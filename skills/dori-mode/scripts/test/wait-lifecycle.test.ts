import { afterEach, beforeEach, expect, setSystemTime, spyOn, test } from "bun:test";
import { makeCli } from "../src/cli-context.ts";
import { journalCommands } from "../src/cli-journal.ts";
import { readPaneState } from "../src/lane-state.ts";
import { parkLane } from "../src/park.ts";
import { reopenLane } from "../src/reopen.ts";
import { Registry, statusOf } from "../src/registry.ts";
import { Reports } from "../src/reports.ts";
import { laneState } from "./fakes.ts";
import { lifecycleFixture, type LifecycleFixture } from "./lifecycle-fixture.ts";

let f: LifecycleFixture;
beforeEach(async () => {
  f = await lifecycleFixture();
  setSystemTime(new Date(f.deps.clock.now()));
  f.lane = { ...f.lane, reportProtocol: "jsonl-v1", lifecycleEpoch: "epoch-before" };
  await f.deps.registry.write(f.lane);
  const state = readPaneState(f.state.dir, "w1:p7");
  if (!state) throw new Error("pane state missing");
  laneState(f.state.dir, "w1:p7", {
    ...state,
    native: {
      observedAt: f.deps.clock.now(),
      jobs: { running: [{ id: "bg_1", startTime: f.deps.clock.now() - 1_000 }], recent: [] },
      approvals: [],
    },
  });
});
afterEach(() => {
  setSystemTime();
  f.state.done();
});

test.each(["park", "reopen"] as const)(
  "an actual %s between native observation and the writer lock discards the old wait",
  async (transition) => {
    const original = Registry.prototype.update;
    let pending = true;
    const intercepted = spyOn(Registry.prototype, "update").mockImplementation(async function (
      this: Registry,
      key,
      next,
    ) {
      if (pending && key === f.lane.key) {
        pending = false;
        const parked = await parkLane(f.deps, f.lane, "owner asked to park");
        expect(parked.code).toBe(0);
        expect(statusOf(parked.lane)).toBe("closed");
        if (transition === "reopen") {
          const reopened = await reopenLane(f.deps, parked.lane);
          expect(reopened.code).toBe(0);
          expect(statusOf(reopened.lane)).toBe("working");
          expect(reopened.lane.lifecycleEpoch).not.toBe(f.lane.lifecycleEpoch);
        }
      }
      return original.call(this, key, next);
    });
    try {
      const report = journalCommands["report"];
      if (!report) throw new Error("report handler missing");
      await expect(
        report(
          makeCli(
            "report",
            [],
            { positionals: [f.lane.key], values: { kind: "blocker", text: "old observation", for: "job:bg_1" } },
            f.deps.config,
            f.deps,
          ),
        ),
      ).rejects.toThrow("lane state changed");
      expect(pending).toBe(false);
      expect(new Reports(f.state.dir).read(f.lane.key)?.lastReport ?? null).toBeNull();
      const current = await f.deps.registry.read(f.lane.key);
      if (!current) throw new Error("lane missing");
      expect(statusOf(current)).toBe(transition === "park" ? "closed" : "working");
      expect(current.lastWaitNotice).toBeUndefined();
    } finally {
      intercepted.mockRestore();
    }
  },
);
