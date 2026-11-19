import { afterEach, beforeEach, expect, test } from "bun:test";
import { existsSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import type { Manifest } from "../src/boot-monitors.ts";
import { monitorFilterFindings } from "../src/doctor-monitors.ts";
import { freshnessTick } from "../src/freshness.ts";
import { monitorPresetFor } from "../src/monitor-presets.ts";
import { checkWaiting } from "../src/freshness-wait.ts";
import { sessionOf } from "../src/registry.ts";
import { SESSION, T0, waitFixture } from "./wait-fixture.ts";

let f: Awaited<ReturnType<typeof waitFixture>>;
const HEAD = "a".repeat(40);
beforeEach(async () => {
  f = await waitFixture();
  await f.deps.registry.update(f.lane.key, (lane) => {
    if (!lane) throw new Error("lane missing");
    return { ...lane, lifecycleEpoch: "epoch-1" };
  });
});
afterEach(() => f.done());

const change = (kind: "epoch" | "closing") =>
  f.deps.registry.update(f.lane.key, (lane) => {
    if (!lane) throw new Error("lane missing");
    if (kind === "epoch") return { ...lane, lifecycleEpoch: "epoch-2" };
    const ref = sessionOf(lane);
    if (!ref) throw new Error("lane session missing");
    return {
      ...lane,
      nativeCloseIntent: { note: "closing", checks: [], settlingClaim: false, ref, session: SESSION, epoch: "epoch-1" },
    };
  });

const locks = () => ({
  registry: existsSync(`${f.deps.registry.path(f.lane.key)}.lock`),
  delivery: existsSync(join(f.deps.registry.dir, `${f.lane.key}.deliver.lock`)),
});

test.each(["epoch", "closing"] as const)(
  "a native wait observed across %s is discarded without a journal append",
  async (kind) => {
    f.control.onProbe = async () => {
      await change(kind);
    };
    await expect(f.report("job:bg_1")).rejects.toThrow("lane state changed");
    expect(f.reports.read(f.lane.key)).toBeNull();
    expect(existsSync(f.reports.path(f.lane.key))).toBe(false);
  },
);

test.each(["epoch", "closing"] as const)(
  "a CI wait observed across %s is discarded without a journal append",
  async (kind) => {
    let changed = false;
    f.control.api = async (endpoint) => {
      if (!changed) {
        changed = true;
        await change(kind);
      }
      return endpoint.endsWith("/pulls/7")
        ? { head: { sha: HEAD } }
        : { id: 99, head_sha: HEAD, status: "in_progress" };
    };
    await expect(f.report("ci:acme/project#7@99")).rejects.toThrow("lane state changed");
    expect(f.reports.read(f.lane.key)).toBeNull();
    expect(existsSync(f.reports.path(f.lane.key))).toBe(false);
  },
);

test("an epoch-only reopen does not inherit the previous epoch's waiting interval", async () => {
  const first = await f.report("job:bg_1");
  f.advance(60_000);
  await change("epoch");
  const reopened = await f.report("job:bg_1");
  expect(reopened.record?.wait?.startedAt).toBe(f.clock.at);
  expect(reopened.record?.wait?.startedAt).not.toBe(first.record?.wait?.startedAt);
  expect(reopened.record).toHaveProperty("generation", "epoch-2");
});

test.each(["epoch", "closing"] as const)(
  "a native end observed across %s cannot write a stale notice or change the journal",
  async (kind) => {
    await f.report("job:bg_1");
    const journal = readFileSync(f.reports.path(f.lane.key), "utf8");
    const lane = await f.deps.registry.read(f.lane.key);
    if (!lane) throw new Error("lane missing");
    f.observe({ running: [], recent: [{ id: "bg_1", startTime: T0, status: "completed" }] });
    f.control.onProbe = async () => {
      await change(kind);
    };
    expect(await checkWaiting(f.deps, lane, f.reports.read(lane.key))).toBeUndefined();
    expect((await f.deps.registry.read(lane.key))?.lastWaitNotice).toBeUndefined();
    expect(readFileSync(f.reports.path(lane.key), "utf8")).toBe(journal);
  },
);

test.each(["job:bg_1", "ci:acme/project#7@99"])(
  "the report handler observes %s outside both existing locks",
  async (selection) => {
    const samples: ReturnType<typeof locks>[] = [];
    f.control.onProbe = async () => {
      samples.push(locks());
    };
    f.control.api = (endpoint) => {
      samples.push(locks());
      return endpoint.endsWith("/pulls/7")
        ? { head: { sha: HEAD } }
        : { id: 99, head_sha: HEAD, status: "in_progress" };
    };
    await f.report(selection);
    expect(samples).toHaveLength(selection.startsWith("ci:") ? 3 : 1);
    expect(samples.every((sample) => !sample.registry && !sample.delivery)).toBe(true);
    expect(f.reports.read(f.lane.key)?.state).toBe("blocked");
  },
);

test("the actual freshness sweep probes native wait state outside both existing locks", async () => {
  await f.report("job:bg_1");
  f.observe({ running: [], recent: [{ id: "bg_1", startTime: T0, status: "completed" }] });
  const samples: ReturnType<typeof locks>[] = [];
  const deps = {
    ...f.deps,
    run: async (...args: Parameters<typeof f.deps.run>) => {
      if (args[0][0] === "ps" && args[0].includes("lstart=")) samples.push(locks());
      return f.deps.run(...args);
    },
  };
  const acts = await freshnessTick(deps, "/home/test");
  expect(samples.length).toBeGreaterThan(0);
  expect(samples.every((sample) => !sample.registry && !sample.delivery)).toBe(true);
  expect(acts.filter((act) => act.kind === "wait-ended")).toHaveLength(1);
  expect(f.reports.read(f.lane.key)?.state).toBe("blocked");
});

test("a discarded closing notice does not rewrite even an unchanged registry record", async () => {
  await f.report("job:bg_1");
  const lane = await f.deps.registry.read(f.lane.key);
  if (!lane) throw new Error("lane missing");
  f.observe({ running: [], recent: [{ id: "bg_1", startTime: T0, status: "completed" }] });
  let closedInode: number | undefined;
  f.control.onProbe = async () => {
    await change("closing");
    closedInode = statSync(f.deps.registry.path(lane.key)).ino;
  };
  expect(await checkWaiting(f.deps, lane, f.reports.read(lane.key))).toBeUndefined();
  expect(typeof closedInode).toBe("number");
  if (closedInode === undefined) throw new Error("closing probe was not observed");
  expect(statSync(f.deps.registry.path(lane.key)).ino).toBe(closedInode);
});

test("a wait replaced by a ceiling blocker still emits the already-recorded supervision alert", async () => {
  await f.report("job:bg_1");
  f.observe({ running: [], recent: [{ id: "bg_1", startTime: T0, status: "completed" }] });
  const deps = { ...f.deps, config: { ...f.deps.config, supervision: { defaults: { wallMinutes: 0 } } } };
  const acts = await freshnessTick(deps, "/home/test");
  expect(acts).toContainEqual({
    kind: "blocked",
    lane: f.lane.key,
    detail: "wallMinutes ceiling reached (0)",
  });
  expect(acts.some((act) => act.kind === "wait-ended")).toBe(false);
  expect(f.reports.read(f.lane.key)?.lastReport?.text).toBe("wallMinutes ceiling reached (0)");
  expect((await f.deps.registry.read(f.lane.key))?.lastWaitNotice).toBeUndefined();
});

test("the default freshness monitor carries a real wait-ended line and doctor detects its omission", async () => {
  await f.report("job:bg_1");
  const lane = await f.deps.registry.read(f.lane.key);
  if (!lane) throw new Error("lane missing");
  f.observe({ running: [], recent: [{ id: "bg_1", startTime: T0, status: "completed" }] });
  const act = await checkWaiting(f.deps, lane, f.reports.read(lane.key));
  const preset = monitorPresetFor(["dori", "freshness"]);
  if (!act || !preset) throw new Error("wait-ended action or freshness preset missing");
  expect(new RegExp(preset.filter).test(`${act.kind.toUpperCase()} ${act.lane} ${act.detail}`)).toBe(true);
  const manifest = (filter: string): Manifest => ({
    kind: "omp",
    path: "/fixture",
    data: {
      version: 1,
      sessionId: "owner",
      monitors: [{ name: "freshness", argv: ["dori", "freshness"], filter, cwd: "/work" }],
    },
  });
  expect(monitorFilterFindings([manifest(preset.filter)], "owner")).toEqual([]);
  expect(monitorFilterFindings([manifest("^(?!WAIT-ENDED\\b)")], "owner")).toEqual([
    {
      check: "monitor-filter",
      severity: "WARN",
      detail: '"freshness" misses probes: WAIT-ENDED; inspect dori monitor-presets freshness in the owner session',
    },
  ]);
});
