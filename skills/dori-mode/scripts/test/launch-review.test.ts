import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { launchLane } from "../src/launch.ts";
import { cancelQueued, enqueueLaunch, queueTick, startQueued } from "../src/launch-queue.ts";
import { LaunchQueue } from "../src/launch-queue-store.ts";
import { pauseLane } from "../src/pause.ts";
import { queueFixture, roomy, type QueueFixture } from "./launch-queue-fixture.ts";

let f: QueueFixture;
beforeEach(async () => {
  f = await queueFixture();
});
afterEach(() => f.state.done());
const store = () => new LaunchQueue(f.state.dir);

const cli = async (...args: string[]) => {
  const config = join(f.state.dir, "config.json");
  writeFileSync(config, JSON.stringify({ ...f.deps.config, runtime: "herdr" }));
  const child = Bun.spawn([process.execPath, join(import.meta.dir, "../src/cli.ts"), ...args], {
    env: { PATH: process.env["PATH"] ?? "", HOME: f.state.dir, DORI_CONFIG: config },
    stdout: "pipe",
    stderr: "pipe",
  });
  const [out, err, code] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  return { out, err, code };
};

test("pause remains usable while a launched agent is awaiting its startup check", async () => {
  const waiting = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  const deps = {
    ...f.deps,
    clock: {
      now: f.deps.clock.now,
      sleep: async (ms: number) => {
        if (ms === 20_000) {
          waiting.resolve();
          await release.promise;
        }
        await f.deps.clock.sleep(ms);
      },
    },
  };
  const launched = launchLane(deps, f.input);
  try {
    await waiting.promise;
    f.world.panes = f.world.panes.map((p) => ({ ...p, agent: "omo", agent_status: "idle" }));
    f.world.screens = ["\u276f ", "Goal paused\n\u276f "];
    const lane = await f.deps.registry.read(f.input.key);
    if (!lane) throw new Error("launch did not register its lane before startup verification");
    const paused = await pauseLane(f.deps, lane, "owner interrupted startup");
    expect(paused.code).toBe(0);
    expect((await f.deps.registry.read(f.input.key))?.status).toBe("paused");
    expect(f.world.calls.some((a) => a.includes("/goal pause"))).toBe(true);
  } finally {
    release.resolve();
    await launched;
  }
  expect((await f.deps.registry.read(f.input.key))?.status).toBe("paused");
});

test("watch reads stored prerequisites without executing Done commands or host probes", async () => {
  await f.deps.registry.write({ ...f.prior, done: 'command ["bun","test"]' });
  await enqueueLaunch(f.deps, f.input, [f.prior.key]);
  const deps = {
    ...f.deps,
    run: async () => {
      throw new Error("watch executed a command");
    },
  };
  expect((await queueTick(deps))[0]).toContain("live checks run on explicit");
  expect(await queueTick(deps)).toEqual([]);
  expect(f.creates()).toBe(0);
});

test("one corrupt queue entry stays visible without hiding valid boot/list/watch entries", async () => {
  await enqueueLaunch(f.deps, f.input, [f.prior.key]);
  writeFileSync(store().path("damaged"), "{");
  const scan = store().scan();
  expect(scan.entries.map((entry) => entry.input.key)).toEqual([f.input.key]);
  expect(scan.problems[0]).toContain("damaged");
  const listed = await cli("queue", "list");
  expect(listed.code).toBe(1);
  expect(JSON.parse(listed.out)[0].input.key).toBe(f.input.key);
  expect(listed.err).toContain("QUEUE_UNREADABLE damaged");
  const boot = await cli("boot");
  expect(boot.code).not.toBe(0);
  expect(boot.out).toContain(`QUEUE ${f.input.key} pending`);
  expect(boot.out).toContain("QUEUE_UNREADABLE damaged");
  const notices = await queueTick(f.deps);
  expect(notices.some((line) => line.includes("LANE_QUEUE_WARN damaged"))).toBe(true);
  expect(notices.some((line) => line.includes("LANE_QUEUE_READY"))).toBe(true);
  const independent = await launchLane(f.deps, { ...f.input, key: "independent" });
  expect(independent.startup).toContain("STARTUP_OK");
  await expect(launchLane(f.deps, { ...f.input, key: "damaged" })).rejects.toThrow("invalid queue JSON");
});

test.each([
  { patch: { key: "lead" }, reason: "reserved" },
  { patch: { done: "merged" }, reason: "not checkable" },
  { patch: { budget: { tokens: -1 } }, reason: "invalid tokens" },
  { patch: { key: "existing-lane" }, reason: "already registered" },
])("queue preparation preserves the ordinary launch validation: %j", async ({ patch, reason }) => {
  await f.deps.registry.write({ ...f.prior, key: "existing-lane" });
  await expect(enqueueLaunch(f.deps, { ...f.input, ...patch }, [f.prior.key])).rejects.toThrow(reason);
  expect(store().scan().entries).toEqual([]);
  expect(f.creates()).toBe(0);
});

test("queued templates freeze rendered values and start through the normal launch path", async () => {
  mkdirSync(join(f.state.dir, "templates"));
  const template = join(f.state.dir, "templates", "build.md");
  writeFileSync(template, "Build {{branch}}.");
  await enqueueLaunch(f.deps, { ...f.input, template: "build", variables: { branch: "first" } }, [f.prior.key]);
  writeFileSync(template, "Changed after queueing.");
  expect((await startQueued(f.deps, f.input.key, roomy)).code).toBe(0);
  const lane = await f.deps.registry.read(f.input.key);
  if (!lane) throw new Error("queued template did not create its lane");
  expect(readFileSync(lane.brief, "utf8")).toContain("Build first.");
  expect(readFileSync(lane.brief, "utf8")).not.toContain("Changed after queueing.");
});

test("failed pre-registration creation needs explicit cancel and a fresh reservation", async () => {
  const original = await enqueueLaunch(f.deps, f.input, [f.prior.key]);
  const deps = {
    ...f.deps,
    run: async (...args: Parameters<typeof f.deps.run>) =>
      args[0][0] === "herdr" && args[0][1] === "tab" && args[0][2] === "create"
        ? { code: 1, out: "", err: "fixture creation refused" }
        : f.deps.run(...args),
  };
  await expect(startQueued(deps, f.input.key, roomy)).rejects.toThrow("session create failed");
  expect(store().read(f.input.key)?.status).toBe("starting");
  expect(await f.deps.registry.read(f.input.key)).toBeNull();
  await expect(startQueued(f.deps, f.input.key, roomy)).rejects.toThrow("no launch retried");
  await cancelQueued(f.deps, f.input.key);
  expect((await enqueueLaunch(f.deps, f.input, [f.prior.key])).id).not.toBe(original.id);
  expect((await startQueued(f.deps, f.input.key, roomy)).code).toBe(0);
  expect(f.creates()).toBe(1);
});
