import { expect, test } from "bun:test";
import { dutyTick } from "../src/duty.ts";
import { ready, report } from "../src/lanes.ts";
import { waitLane } from "./wait-setup.ts";

const waiting = { status: "waiting", waitingFor: "job:bg_1" } as const;

test.each(["completed", "failed", "cancelled", "not-observed"] as const)(
  "a %s wait ends once without resetting the 40-minute escalation",
  async (state) => {
    const s = await waitLane();
    await report(s.d, s.lane.key, "waiting", waiting);
    const before = s.d.store.lane(s.lane.key)!;
    s.w.clock += 1_000;
    s.control.native = {
      ...s.control.native!,
      jobs: {
        running: [],
        recent: state === "not-observed" ? [] : [{ id: "bg_1", startTime: s.lane.createdAt, status: state }],
      },
    };
    expect((await dutyTick(s.d)).filter((event) => event.action === "wait-ended")).toHaveLength(1);
    expect(s.d.store.lane(s.lane.key)).toMatchObject({
      status: "waiting",
      progressAt: before.progressAt,
      nudges: before.nudges,
      waitingSince: before.waitingSince,
      wait: { lastObservedState: state, startedAt: before.wait!.startedAt },
    });
    expect(s.d.store.lane(s.lane.key)!.escalatedAt).toBe(before.escalatedAt);
    expect((await dutyTick(s.d)).filter((event) => event.action === "wait-ended")).toEqual([]);
    s.w.clock = s.lane.createdAt + 40 * 60_000;
    expect(await dutyTick(s.d)).toContainEqual({ lane: s.lane.key, action: "escalated" });
    expect(s.lead.received.join("\n")).toContain(state);
  },
);

test("missing native observation is unknown, not a released wait", async () => {
  const s = await waitLane();
  await report(s.d, s.lane.key, "waiting", waiting);
  s.control.native = undefined;
  expect((await dutyTick(s.d)).filter((event) => event.action === "wait-ended")).toEqual([]);
  expect(s.d.store.lane(s.lane.key)).toMatchObject({ status: "waiting", wait: { lastObservedState: "unobservable" } });
});

test("a newer dependency reported during the probe is never ended by the older observation", async () => {
  const s = await waitLane();
  await report(s.d, s.lane.key, "waiting", waiting);
  s.control.native = { ...s.control.native!, jobs: { running: [], recent: [] } };
  s.control.duringProbe = async () => {
    s.w.clock += 1_000;
    s.control.native = { ...s.control.native!, jobs: { running: [{ id: "bg_2", startTime: s.w.clock }], recent: [] } };
    await report(s.d, s.lane.key, "now waiting for job two", { status: "waiting", waitingFor: "job:bg_2" });
  };
  expect((await dutyTick(s.d)).filter((event) => event.action === "wait-ended")).toEqual([]);
  expect(s.d.store.lane(s.lane.key)!.wait).toMatchObject({ target: { id: "bg_2" }, lastObservedState: "running" });
});

test("a READY received while probing is not changed by wait observation", async () => {
  const s = await waitLane();
  await report(s.d, s.lane.key, "waiting", waiting);
  s.control.native = { ...s.control.native!, jobs: { running: [], recent: [] } };
  s.control.duringProbe = async () => {
    await ready(s.d, s.lane.key, "finished", ["https://example.test/pr/1"]);
  };
  expect((await dutyTick(s.d)).filter((event) => event.action === "wait-ended")).toEqual([]);
  expect(s.d.store.lane(s.lane.key)).toMatchObject({ status: "ready", final: { text: "finished" } });
});

test("an approval resolving ends only its identity and leaves the lane waiting", async () => {
  const s = await waitLane();
  await report(s.d, s.lane.key, "approval", { status: "waiting", waitingFor: "approval:call-1" });
  s.control.native = { ...s.control.native!, approvals: [] };
  expect((await dutyTick(s.d)).filter((event) => event.action === "wait-ended")).toHaveLength(1);
  expect(s.d.store.lane(s.lane.key)).toMatchObject({
    status: "waiting",
    wait: { lastObservedState: "resolved" },
    progressAt: s.lane.createdAt,
    nudges: 0,
  });
});
