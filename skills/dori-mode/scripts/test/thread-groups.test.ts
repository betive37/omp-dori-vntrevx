import { afterEach, beforeEach, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { closeLane, watchTick } from "../src/done-flow.ts";
import { withDeliveryLock } from "../src/delivery-lock.ts";
import { ConfigError, loadConfig } from "../src/config.ts";
import { type Lane, statusOf } from "../src/registry.ts";
import { depsFor, fakeClock, newWorld, type TestState, withState } from "./fakes.ts";

const T0 = Date.parse("2026-01-01T12:00:00Z");
const lane: Lane = {
  key: "first-lane",
  title: "first",
  thread: "discord:40",
  brief: "/b",
  cwd: "/repo",
  done: "merged acme/app#1",
  openedAt: new Date(T0).toISOString(),
};
let state: TestState;
beforeEach(() => {
  state = withState();
});
afterEach(() => state.done());

test("last-lane skips the first hook and runs it only for the final sibling", async () => {
  const world = newWorld();
  const deps = depsFor(world, fakeClock(T0), state.dir, {
    threadDonePolicy: "last-lane",
    hooks: { threadDone: ["notify", "{thread}", "{key}"] },
  });
  const sibling = { ...lane, key: "second-lane" };
  await deps.registry.write(lane);
  await deps.registry.write(sibling);
  await deps.registry.write({ ...lane, key: "different-thread", thread: "discord:41" });
  const first = await closeLane(deps, lane, "first finished");
  expect(first.closed).toBe(true);
  expect(first.lines.join("\n")).toContain("1 lanes still open (second-lane); threadDone skipped");
  expect(world.calls.some((c) => c[0] === "notify")).toBe(false);
  const second = await closeLane(deps, sibling, "second finished");
  expect(second.closed).toBe(true);
  expect(world.calls.filter((c) => c[0] === "notify")).toEqual([["notify", "discord:40", "second-lane"]]);
  expect(statusOf((await deps.registry.read("different-thread")) ?? lane)).toBe("working");
  const repeated = await closeLane(deps, (await deps.registry.read(sibling.key)) ?? sibling, "duplicate");
  expect(repeated.closed).toBe(false);
  expect(world.calls.filter((c) => c[0] === "notify")).toHaveLength(1);
});

test.each(["working", "paused", "not-done", "done-claimed", "verified-done"] as const)(
  "a %s sibling is still open",
  async (status) => {
    const world = newWorld();
    const deps = depsFor(world, fakeClock(T0), state.dir, {
      threadDonePolicy: "last-lane",
      hooks: { threadDone: ["notify"] },
    });
    await deps.registry.write(lane);
    await deps.registry.write({ ...lane, key: "sibling-lane", status });
    expect((await closeLane(deps, lane, "done")).closed).toBe(true);
    expect(world.calls.some((c) => c[0] === "notify")).toBe(false);
  },
);

test.each([undefined, "every-lane"] as const)("legacy policy %s still runs each lane's hook", async (policy) => {
  const world = newWorld();
  const deps = depsFor(world, fakeClock(T0), state.dir, {
    ...(policy === undefined ? {} : { threadDonePolicy: policy }),
    hooks: { threadDone: ["notify"] },
  });
  await deps.registry.write(lane);
  await deps.registry.write({ ...lane, key: "sibling-lane" });
  expect((await closeLane(deps, lane, "done")).closed).toBe(true);
  expect(world.calls.filter((c) => c[0] === "notify")).toHaveLength(1);
});

test("concurrent sibling closes elect one final hook, independent of slow cleanup", async () => {
  const world = newWorld();
  const deps = depsFor(world, fakeClock(T0), state.dir, {
    threadDonePolicy: "last-lane",
    hooks: { threadDone: ["notify"] },
  });
  const sibling = { ...lane, key: "second-lane" };
  await deps.registry.write(lane);
  await deps.registry.write(sibling);
  const results = await Promise.all([closeLane(deps, lane, "first"), closeLane(deps, sibling, "second")]);
  expect(results.every((result) => result.closed)).toBe(true);
  expect(world.calls.filter((c) => c[0] === "notify")).toHaveLength(1);
});

test("a failing Done signal does not close a group member or run any hook", async () => {
  const world = newWorld();
  world.prState = "OPEN";
  const deps = depsFor(world, fakeClock(T0), state.dir, {
    threadDonePolicy: "last-lane",
    hooks: { threadDone: ["notify"] },
  });
  await deps.registry.write(lane);
  expect((await closeLane(deps, lane, "done")).closed).toBe(false);
  expect(statusOf((await deps.registry.read(lane.key)) ?? lane)).toBe("working");
  expect(world.calls.some((c) => c[0] === "notify")).toBe(false);
});

test("a damaged sibling registry fails before the close transition", async () => {
  const world = newWorld();
  const deps = depsFor(world, fakeClock(T0), state.dir, { threadDonePolicy: "last-lane" });
  await deps.registry.write(lane);
  await Bun.write(deps.registry.path("broken-lane"), "{broken");
  await expect(closeLane(deps, lane, "done")).rejects.toThrow();
  expect(statusOf((await deps.registry.read(lane.key)) ?? lane)).toBe("working");
});

test.each(["MERGED", "OPEN"])("watch retries a held thread close and rechecks Done signals (%s)", async (nextState) => {
  const world = newWorld();
  world.panes = [{ pane_id: "w:p7", workspace_id: "w", agent: "pi", agent_status: "idle" }];
  let now = T0 + 10 * 60_000;
  const clock = {
    now: () => now,
    sleep: async (ms: number) => {
      now += ms;
    },
  };
  const deps = depsFor(world, clock, state.dir, { threadDonePolicy: "last-lane", hooks: { threadDone: ["notify"] } });
  await deps.registry.write({
    ...lane,
    pane: "w:p7",
    status: "done-claimed",
    claim: { at: new Date(T0).toISOString(), evidence: "merged acme/app#1", emitted: true },
  });
  const key = `@thread-${createHash("sha256").update(lane.thread).digest("hex")}`;
  const held = await withDeliveryLock(deps, key, () => watchTick(deps));
  expect(held.ok).toBe(true);
  expect(held.ok && held.value[0]).toStartWith("LANE_HELD first-lane thread close in flight");
  const waiting = await deps.registry.read(lane.key);
  expect(waiting && statusOf(waiting)).toBe("verified-done");
  expect(waiting?.objection).toBeUndefined();
  expect(world.calls.some((c) => c[0] === "notify" || c[2] === "send-text")).toBe(false);
  world.prState = nextState;
  const retried = await watchTick(deps);
  const finished = await deps.registry.read(lane.key);
  if (nextState === "MERGED") {
    expect(retried[0]).toStartWith("LANE_CLOSED first-lane");
    expect(finished && statusOf(finished)).toBe("closed");
    expect(world.calls.filter((c) => c[0] === "notify")).toHaveLength(1);
  } else {
    expect(finished && statusOf(finished)).toBe("not-done");
    expect(finished?.objection?.reasons).toEqual(["merged acme/app#1 -> OPEN"]);
    expect(world.calls.some((c) => c[0] === "notify")).toBe(false);
  }
});

test.each([null, false, "last", ""])("invalid threadDonePolicy %s is refused", async (threadDonePolicy) => {
  const path = `${state.dir}/config.json`;
  await Bun.write(path, JSON.stringify({ threadDonePolicy }));
  await expect(loadConfig(path, state.dir)).rejects.toBeInstanceOf(ConfigError);
});
