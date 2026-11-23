import { expect, test } from "bun:test";
import { main } from "../src/cli.ts";
import { ready, report } from "../src/lanes.ts";
import { captureIo } from "./inbox-setup.ts";
import { waitLane } from "./wait-setup.ts";

const waiting = { status: "waiting", waitingFor: "job:bg_1" } as const;

test("root reports preserve the same dependency start and the original whole-waiting clock", async () => {
  const s = await waitLane();
  const first = await report(s.d, s.lane.key, "waiting for build", waiting);
  const before = s.d.store.lane(s.lane.key)!;
  expect(first.progress.join("\n")).toContain("WAIT job:bg_1");
  expect(s.lead.received.join("\n")).toContain("WAIT job:bg_1");
  s.w.clock += 1_000;
  await report(s.d, s.lane.key, "same build", waiting);
  await report(s.d, s.lane.key, "same build without --for", { status: "waiting" });
  expect(s.d.store.lane(s.lane.key)).toMatchObject({
    waitingSince: before.waitingSince,
    wait: { startedAt: before.wait!.startedAt },
  });
  s.control.native = { ...s.control.native!, jobs: { running: [{ id: "bg_2", startTime: s.w.clock }], recent: [] } };
  await report(s.d, s.lane.key, "next build", { status: "waiting", waitingFor: "job:bg_2" });
  expect(s.d.store.lane(s.lane.key)).toMatchObject({
    waitingSince: before.waitingSince,
    wait: { startedAt: s.w.clock, target: { id: "bg_2" } },
    progressAt: s.lane.createdAt,
  });
});

test("the actual root CLI accepts structured --for and refuses an ended job without changing the lane", async () => {
  const s = await waitLane();
  const result = await captureIo(() =>
    main(["report", s.lane.key, "--status", "waiting", "--for", "job:bg_1", "--text", "build pending"], s.d),
  );
  expect(result.code).toBe(0);
  const before = s.d.store.lane(s.lane.key);
  s.control.native = {
    ...s.control.native!,
    jobs: { running: [], recent: [{ id: "bg_1", startTime: s.lane.createdAt, status: "completed" }] },
  };
  await expect(report(s.d, s.lane.key, "still pending", waiting)).rejects.toThrow("not observed running");
  expect(s.d.store.lane(s.lane.key)).toEqual(before);
  s.control.native = undefined;
  await expect(report(s.d, s.lane.key, "cannot observe", waiting)).rejects.toThrow("unobservable");
  expect(s.d.store.lane(s.lane.key)).toEqual(before);
});

test("working clears the binding, and READY followed by another wait starts a new waiting interval", async () => {
  const s = await waitLane();
  await report(s.d, s.lane.key, "waiting", waiting);
  await report(s.d, s.lane.key, "working", { status: "working" });
  expect(s.d.store.lane(s.lane.key)!.wait).toBeUndefined();
  await report(s.d, s.lane.key, "waiting again", waiting);
  await ready(s.d, s.lane.key, "ready", ["https://example.test/pr/1"]);
  s.w.clock += 1_000;
  await report(s.d, s.lane.key, "new waiting interval", waiting);
  expect(s.d.store.lane(s.lane.key)).toMatchObject({ waitingSince: s.w.clock, wait: { startedAt: s.w.clock } });
});

test("a READY written during observation is not overwritten by a delayed report", async () => {
  const s = await waitLane();
  s.control.duringProbe = () => ready(s.d, s.lane.key, "finished", ["https://example.test/pr/1"]).then(() => {});
  await expect(report(s.d, s.lane.key, "late wait", waiting)).rejects.toThrow("lane changed");
  expect(s.d.store.lane(s.lane.key)).toMatchObject({ status: "ready", final: { text: "finished" } });
  expect(s.d.store.lane(s.lane.key)!.wait).toBeUndefined();
});

test("a newer report with unchanged status during observation still owns the lane", async () => {
  const s = await waitLane();
  s.control.duringProbe = () => report(s.d, s.lane.key, "new progress").then(() => {});
  await expect(report(s.d, s.lane.key, "late wait", waiting)).rejects.toThrow("lane changed");
  expect(s.d.store.lane(s.lane.key)?.log.at(-1)?.text).toBe("new progress");
  expect(s.d.store.lane(s.lane.key)?.wait).toBeUndefined();
});

test("a native approval is bound to the actual pending call, not to arbitrary dependency prose", async () => {
  const s = await waitLane();
  await report(s.d, s.lane.key, "approval", { status: "waiting", waitingFor: "approval:call-1" });
  expect(s.d.store.lane(s.lane.key)!.wait).toMatchObject({
    target: { kind: "approval", id: "call-1", sessionId: "native-main" },
    lastObservedState: "pending",
  });
  await expect(
    report(s.d, s.lane.key, "missing", { status: "waiting", waitingFor: "approval:missing" }),
  ).rejects.toThrow("not observed pending");
  await report(s.d, s.lane.key, "external", { status: "waiting", waitingFor: "waiting for a review" });
  expect(s.d.store.lane(s.lane.key)!.wait?.lastObservedState).toBe("unverified");
});
