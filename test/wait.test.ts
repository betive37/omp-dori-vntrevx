import { expect, test } from "bun:test";
import type { Probe } from "../src/runtime/types.ts";
import { bindNativeWait, observeWait, parseWait, readWait, renderWait, waitEnded, waitKey } from "../src/wait.ts";

const probe = (patch: Partial<NonNullable<Probe["native"]>> = {}): Probe => ({
  status: "idle",
  shellInFront: false,
  native: {
    sessionId: "session-a",
    sessionStartedAt: "2026-11-19T00:00:00Z",
    observedAt: 100,
    jobs: { running: [{ id: "bg_1", startTime: 20 }], recent: [] },
    approvals: [{ sessionId: "session-a", toolCallId: "call-1", toolName: "bash" }],
    ...patch,
  },
});
const job = () => bindNativeWait({ kind: "job", id: "bg_1" }, probe(), 110);

test("same native wait preserves its start; job reuse and session changes are different identities", () => {
  const first = job();
  const repeat = bindNativeWait({ kind: "job", id: "bg_1" }, probe({ observedAt: 200 }), 210, first);
  expect(repeat.startedAt).toBe(110);
  expect(repeat.observedAt).toBe(200);
  const reused = bindNativeWait(
    { kind: "job", id: "bg_1" },
    probe({ jobs: { running: [{ id: "bg_1", startTime: 25 }], recent: [] } }),
    220,
    repeat,
  );
  expect(reused.startedAt).toBe(220);
  expect(waitKey(reused.target)).not.toBe(waitKey(first.target));
  for (const patch of [{ sessionId: "session-b" }, { sessionStartedAt: "2026-11-19T00:01:00Z" }]) {
    const changed = bindNativeWait({ kind: "job", id: "bg_1" }, probe(patch), 230, first);
    expect(changed.startedAt).toBe(230);
    expect(waitKey(changed.target)).not.toBe(waitKey(first.target));
  }
});

test.each(["completed", "failed", "cancelled"] as const)("a %s job cannot establish a wait", (status) => {
  expect(() =>
    bindNativeWait(
      { kind: "job", id: "bg_1" },
      probe({ jobs: { running: [], recent: [{ id: "bg_1", startTime: 20, status }] } }),
      200,
    ),
  ).toThrow("not observed running");
  const observed = observeWait(
    job(),
    probe({ observedAt: 200, jobs: { running: [], recent: [{ id: "bg_1", startTime: 20, status }] } }),
  );
  expect(observed.lastObservedState).toBe(status);
  expect(observed.startedAt).toBe(110);
  expect(waitEnded(observed)).toBe(true);
  expect(observeWait(observed, { status: "unknown", shellInFront: false })).toEqual(observed);
});

test("missing jobs are not-observed, never fabricated success; a reused id cannot hold the old job", () => {
  for (const jobs of [
    { running: [], recent: [] },
    { running: [{ id: "bg_1", startTime: 50 }], recent: [] },
  ]) {
    const observed = observeWait(job(), probe({ jobs, observedAt: 200 }));
    expect(observed.lastObservedState).toBe("not-observed");
    expect(waitEnded(observed)).toBe(true);
    expect(renderWait(observed)).not.toContain("success");
  }
  expect(() => bindNativeWait({ kind: "job", id: "absent" }, probe(), 200)).toThrow("not observed running");
});

test("unknown probes, missing observations and null snapshots do not release a native wait", () => {
  for (const current of [
    { status: "unknown", shellInFront: false },
    { status: "idle", shellInFront: false },
    probe({ jobs: null, observedAt: 200 }),
  ] as const) {
    const observed = observeWait(job(), current);
    expect(observed.lastObservedState).toBe("unobservable");
    expect(waitEnded(observed)).toBe(false);
    expect(observed.startedAt).toBe(110);
  }
  expect(() => bindNativeWait({ kind: "job", id: "bg_1" }, probe({ jobs: null }), 200)).toThrow();
});

test("an older observation cannot end or rebind a newer wait", () => {
  expect(observeWait(job(), probe({ observedAt: 99, jobs: { running: [], recent: [] } }))).toEqual(job());
  expect(() => bindNativeWait({ kind: "job", id: "bg_1" }, probe({ observedAt: 99 }), 200, job())).toThrow(
    "newer or ended",
  );
  const ended = observeWait(job(), probe({ observedAt: 200, jobs: { running: [], recent: [] } }));
  expect(() => bindNativeWait({ kind: "job", id: "bg_1" }, probe({ observedAt: 210 }), 220, ended)).toThrow(
    "newer or ended",
  );
});

test("session replacement ends the old binding, not the lane", () => {
  const observed = observeWait(job(), probe({ observedAt: 200, sessionId: "session-b" }));
  expect(observed.lastObservedState).toBe("session-changed");
  expect(observed.target).toEqual(job().target);
  expect(waitEnded(observed)).toBe(true);
});

test("approval identity is scoped to the actual session; resolved does not mean approved", () => {
  const wait = bindNativeWait({ kind: "approval", id: "call-1" }, probe(), 110);
  expect(wait.lastObservedState).toBe("pending");
  expect(bindNativeWait({ kind: "approval", id: "call-1" }, probe(), 200, wait).startedAt).toBe(110);
  const other = probe({ observedAt: 200, approvals: [{ sessionId: "other", toolCallId: "call-1", toolName: "bash" }] });
  expect(() => bindNativeWait({ kind: "approval", id: "call-1" }, other, 210)).toThrow("not observed pending");
  const resolved = observeWait(wait, other);
  expect(resolved.lastObservedState).toBe("resolved");
  expect(waitEnded(resolved)).toBe(true);
  expect(renderWait(resolved)).not.toContain("approved");
});

test("prose and malformed machine syntax are explicitly unverified labels", () => {
  for (const text of ["waiting for deploy", "job:two words", "ci:team/app#0"]) {
    const request = parseWait(text);
    expect(request.kind).toBe("label");
    if (request.kind !== "label") throw new Error("expected a label");
    const wait = bindNativeWait(request, undefined, 100);
    expect(wait.lastObservedState).toBe("unverified");
    expect(observeWait(wait, probe())).toEqual(wait);
    expect(waitEnded(wait)).toBe(false);
    expect(renderWait(wait)).toContain("unverified");
  }
  expect(parseWait("job:bg_1")).toEqual({ kind: "job", id: "bg_1" });
  expect(parseWait("approval:call-1")).toEqual({ kind: "approval", id: "call-1" });
  expect(parseWait("ci:Team/App#123@456")).toEqual({ kind: "ci", repo: "team/app", number: 123, checkRun: 456 });
});

test("persisted proof is bounded and typed; field order does not change identity", () => {
  const wait = job();
  expect(readWait(JSON.parse(JSON.stringify(wait)))).toEqual(wait);
  const reordered = { ...wait, target: Object.fromEntries(Object.entries(wait.target).reverse()) };
  const read = readWait(reordered);
  expect(read).toBeDefined();
  expect(waitKey(read!.target)).toBe(waitKey(wait.target));
  for (const broken of [
    null,
    {},
    { ...wait, observedAt: Number.MAX_SAFE_INTEGER },
    { ...wait, lastObservedState: "success" },
    { ...wait, target: { kind: "job", id: "bg_1" } },
  ]) {
    expect(readWait(broken)).toBeUndefined();
  }
});
