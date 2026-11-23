// Probe-level regressions for the extension's native observation: only withOmpState's existing attestation is used, so
// on a tree without the observation the positive cases fail on assertions, not on a missing module.
import { describe, expect, test } from "bun:test";
import { writeFileSync } from "node:fs";
import { ompWorld } from "./omp-setup.ts";

const observation = {
  observedAt: 1_763_500_000_000,
  jobs: {
    running: [{ id: "bg_2", startTime: 1_763_499_990_000 }],
    recent: [
      { id: "bg_1", startTime: 1_763_499_900_000, status: "completed" as const, endTime: 1_763_499_950_000 },
      { id: "bg_0", startTime: 1_763_499_800_000, status: "cancelled" as const },
    ],
  },
  approvals: [{ sessionId: "omp-session-1", toolCallId: "call-7", toolName: "bash" }],
};

for (const kind of ["herdr", "hc"] as const) {
  describe(`${kind}: native wait observation`, () => {
    const world = (native: unknown) => {
      const s = ompWorld(kind);
      const write = (value: unknown) => writeFileSync(s.path, JSON.stringify({ ...s.record, native: value }));
      write(native);
      return { ...s, write };
    };

    test("an attested record hands on its observation bound to the record's session and start", async () => {
      const s = world(observation);
      const probe = await s.rt.probe(s.ref);
      expect(probe).toMatchObject({ status: "idle", pid: 101, sessionId: "omp-session-1", approvalPending: false });
      expect(probe.native).toEqual({
        ...observation,
        sessionId: "omp-session-1",
        sessionStartedAt: "2026-11-11T00:00:05Z",
      });
    });

    test("a null job snapshot stays null: unobservable, never an empty running list", async () => {
      const s = world({ ...observation, jobs: null });
      expect((await s.rt.probe(s.ref)).native).toEqual({
        observedAt: observation.observedAt,
        jobs: null,
        approvals: observation.approvals,
        sessionId: "omp-session-1",
        sessionStartedAt: "2026-11-11T00:00:05Z",
      });
    });

    test("fields outside the observation are not carried", async () => {
      const s = world({
        ...observation,
        extra: "x",
        jobs: {
          running: [{ id: "bg_2", startTime: 5, label: "build", status: "running" }],
          recent: [{ id: "bg_1", startTime: 4, status: "failed", command: "make" }],
        },
        approvals: [{ sessionId: "sub-1", toolCallId: "c", toolName: "edit", approved: true }],
      });
      expect((await s.rt.probe(s.ref)).native).toEqual({
        observedAt: observation.observedAt,
        jobs: { running: [{ id: "bg_2", startTime: 5 }], recent: [{ id: "bg_1", startTime: 4, status: "failed" }] },
        approvals: [{ sessionId: "sub-1", toolCallId: "c", toolName: "edit" }],
        sessionId: "omp-session-1",
        sessionStartedAt: "2026-11-11T00:00:05Z",
      });
    });

    test.each([
      ["a string observation time", { ...observation, observedAt: "2026-11-19T00:00:00Z" }],
      ["a fractional observation time", { ...observation, observedAt: 1.5 }],
      ["an observation time outside Date range", { ...observation, observedAt: Number.MAX_SAFE_INTEGER }],
      ["a missing approval list", { observedAt: 1, jobs: null }],
      ["jobs given as a list", { ...observation, jobs: [] }],
      ["jobs without a recent list", { ...observation, jobs: { running: [] } }],
      ["a running job without its start", { ...observation, jobs: { running: [{ id: "bg_2" }], recent: [] } }],
      ["a running job with an empty id", { ...observation, jobs: { running: [{ id: "", startTime: 1 }], recent: [] } }],
      [
        "a recent job with an unknown status",
        { ...observation, jobs: { running: [], recent: [{ id: "a", startTime: 1, status: "succeeded" }] } },
      ],
      [
        "a recent job whose status names an object property",
        { ...observation, jobs: { running: [], recent: [{ id: "a", startTime: 1, status: "constructor" }] } },
      ],
      [
        "a recent job with a malformed end",
        { ...observation, jobs: { running: [], recent: [{ id: "a", startTime: 1, status: "failed", endTime: "x" }] } },
      ],
      ["an approval without its session", { ...observation, approvals: [{ toolCallId: "c", toolName: "bash" }] }],
      ["an approval list with a non-record", { ...observation, approvals: ["call-7"] }],
      ["a non-record observation", "running"],
    ])("%s drops the observation and keeps the pane's own judgement", async (_, native) => {
      const s = world(native);
      const probe = await s.rt.probe(s.ref);
      expect(probe).toMatchObject({ status: "idle", pid: 101, sessionId: "omp-session-1", approvalPending: false });
      expect(probe.native).toBeUndefined();
    });

    test("a malformed observation never hides an open approval", async () => {
      const s = ompWorld(kind);
      s.record.approvalPending = true;
      writeFileSync(s.path, JSON.stringify({ ...s.record, native: { observedAt: "bad" } }));
      const probe = await s.rt.probe(s.ref);
      expect(probe).toMatchObject({ status: "blocked", approvalPending: true });
      expect(probe.native).toBeUndefined();
    });

    test.each([
      ["an exited writer", "100 1 /bin/bash\n"],
      ["a writer outside this terminal", "100 1 /bin/bash\n101 200 bun /synthetic/omp\n"],
      ["a pid reused by another program", "100 1 /bin/bash\n101 100 vim\n"],
    ])("%s hands on no observation", async (_, table) => {
      const s = world(observation);
      s.control.table = table;
      const probe = await s.rt.probe(s.ref);
      expect(probe.status).toBe("unknown");
      expect(probe.native).toBeUndefined();
    });

    test("a newer process reusing the writer pid hands on no observation", async () => {
      const s = world(observation);
      s.control.started = "2026-11-11T00:01:00Z";
      const probe = await s.rt.probe(s.ref);
      expect(probe.status).toBe("unknown");
      expect(probe.native).toBeUndefined();
    });

    test("a session switch during attestation hands on neither session's observation", async () => {
      const s = world(observation);
      s.control.onPs = () => {
        s.record.sessionId = "omp-session-2";
        s.write({ ...observation, approvals: [] });
      };
      const probe = await s.rt.probe(s.ref);
      expect(probe.status).toBe("unknown");
      expect(probe.native).toBeUndefined();
    });

    test("an observation rewritten during attestation is read from the re-read record", async () => {
      const s = world(observation);
      const later = { ...observation, observedAt: observation.observedAt + 1, jobs: { running: [], recent: [] } };
      s.control.onPs = (argv) => {
        if (argv[0] === "-o") s.write(later);
      };
      expect((await s.rt.probe(s.ref)).native).toEqual({
        ...later,
        sessionId: "omp-session-1",
        sessionStartedAt: "2026-11-11T00:00:05Z",
      });
    });

    test("a record without an observation, as older extensions write, hands on none", async () => {
      const s = ompWorld(kind);
      const probe = await s.rt.probe(s.ref);
      expect(probe).toMatchObject({ status: "idle", sessionId: "omp-session-1" });
      expect(probe.native).toBeUndefined();
    });
  });
}
