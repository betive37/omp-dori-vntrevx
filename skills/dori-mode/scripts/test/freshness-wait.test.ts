import { afterEach, beforeEach, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { freshnessTick } from "../src/freshness.ts";
import { checkWaiting } from "../src/freshness-wait.ts";
import { statusOf } from "../src/registry.ts";
import { SESSION, T0, waitFixture } from "./wait-fixture.ts";

let f: Awaited<ReturnType<typeof waitFixture>>;
beforeEach(async () => {
  f = await waitFixture();
});
afterEach(() => f.done());
const current = async () => {
  const lane = await f.deps.registry.read(f.lane.key);
  if (!lane) throw new Error("lane missing");
  return lane;
};
const tick = async () => checkWaiting(f.deps, await current(), f.reports.read(f.lane.key));

test.each(["completed", "failed", "cancelled", "not-observed"] as const)(
  "%s ends only the observed wait, once, without clearing the blocker",
  async (status) => {
    await f.report("job:bg_1");
    const journal = readFileSync(f.reports.path(f.lane.key), "utf8");
    f.advance(60_000);
    f.observe({ running: [], recent: status === "not-observed" ? [] : [{ id: "bg_1", startTime: T0, status }] });
    const ended = await tick();
    expect(ended?.kind).toBe("wait-ended");
    expect(ended?.detail).toContain(status);
    expect(ended?.detail).toContain("not success or permission to resume");
    expect(await tick()).toBeUndefined();
    expect(f.reports.read(f.lane.key)?.state).toBe("blocked");
    expect(readFileSync(f.reports.path(f.lane.key), "utf8")).toBe(journal);
    expect(statusOf(await current())).toBe("working");
    expect(f.world.calls.some((call) => call.includes("send-text") || call[0] === "gh")).toBe(false);
    // A delayed older running snapshot cannot resurrect a wait whose end was already noticed.
    f.observe({ running: [{ id: "bg_1", startTime: T0 }], recent: [] });
    await expect(f.report("job:bg_1")).rejects.toThrow("already ended");
    f.observe({ running: [{ id: "bg_1", startTime: f.clock.at }], recent: [] });
    expect((await f.report("job:bg_1")).record?.wait?.startedAt).toBe(f.clock.at);
  },
);

test("no job manager does not assert completion; a denial is resolved rather than approved", async () => {
  await f.report("job:bg_1");
  f.observe(null);
  expect(await tick()).toBeUndefined();
  f.observe(null, [{ sessionId: SESSION, toolCallId: "call-1", toolName: "bash" }]);
  await f.report("approval:call-1");
  f.observe(null);
  const ended = await tick();
  expect(ended?.kind).toBe("wait-ended");
  expect(ended?.detail).toContain("resolved");
  expect(f.reports.read(f.lane.key)?.state).toBe("blocked");
});

test("a new report during native observation cannot inherit the old wait's end notice", async () => {
  await f.report("job:bg_1");
  f.observe({ running: [], recent: [{ id: "bg_1", startTime: T0, status: "completed" }] });
  f.control.onProbe = async () => {
    await f.reports.report(f.lane.key, "milestone", "new work", f.clock.at);
  };
  expect(await tick()).toBeUndefined();
  expect((await current()).lastWaitNotice).toBeUndefined();
  expect(f.reports.read(f.lane.key)?.state).toBe("running");
});

test("a pause during observation cannot be overwritten by an advisory notice", async () => {
  await f.report("job:bg_1");
  f.observe({ running: [], recent: [] });
  f.control.onProbe = async () => {
    await f.deps.registry.update(f.lane.key, (lane) => {
      if (!lane) throw new Error("lane missing");
      return { ...lane, status: "paused" };
    });
  };
  expect(await tick()).toBeUndefined();
  expect((await current()).lastWaitNotice).toBeUndefined();
  expect(statusOf(await current())).toBe("paused");
});

test("the actual freshness sweep emits the end but neither nudges nor clears the blocker", async () => {
  await f.report("job:bg_1");
  f.advance(41 * 60_000);
  f.observe({ running: [], recent: [{ id: "bg_1", startTime: T0, status: "failed" }] });
  const acts = await freshnessTick(f.deps, "/home/test");
  expect(acts.filter((act) => act.kind === "wait-ended")).toHaveLength(1);
  expect(acts.some((act) => act.kind === "nudged")).toBe(false);
  expect(f.reports.read(f.lane.key)?.state).toBe("blocked");
  expect((await freshnessTick(f.deps, "/home/test")).some((act) => act.kind === "wait-ended")).toBe(false);
});

test("an older recovered observation never erases a newer wait notice", async () => {
  await f.report("job:bg_1");
  await f.deps.registry.update(f.lane.key, (lane) => {
    if (!lane) throw new Error("lane missing");
    return { ...lane, lastWaitNotice: "error|previous observation" };
  });
  f.control.onProbe = async () => {
    await f.deps.registry.update(f.lane.key, (lane) => {
      if (!lane) throw new Error("lane missing");
      return { ...lane, lastWaitNotice: "ended|newer observation" };
    });
  };
  expect(await tick()).toBeUndefined();
  expect((await current()).lastWaitNotice).toBe("ended|newer observation");
});

test("a pre-existing pause remains a pause even when the observed job is done", async () => {
  await f.report("job:bg_1");
  await f.deps.registry.update(f.lane.key, (lane) => {
    if (!lane) throw new Error("lane missing");
    return { ...lane, status: "paused" };
  });
  f.observe({ running: [], recent: [{ id: "bg_1", startTime: T0, status: "completed" }] });
  expect((await freshnessTick(f.deps, "/home/test")).some((act) => act.kind === "wait-ended")).toBe(false);
  expect(statusOf(await current())).toBe("paused");
  expect(f.reports.read(f.lane.key)?.state).toBe("blocked");
});
