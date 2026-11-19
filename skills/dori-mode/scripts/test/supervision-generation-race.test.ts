import { expect, test } from "bun:test";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import { Registry } from "../src/registry.ts";
import { Reports } from "../src/reports.ts";
import { withState } from "./fakes.ts";
import { marker } from "./report-race-fixture.ts";

test("a registry-only Done claim invalidates a waiting supervision commit without journal, cost or alert effects", async () => {
  const state = withState();
  const children: ReturnType<typeof Bun.spawn>[] = [];
  const release = join(state.dir, "release");
  try {
    const now = Date.now();
    const lane = {
      key: "claim-race",
      title: "race",
      thread: "none",
      pane: "w:p7",
      brief: "/b.md",
      done: "file /done.md",
      openedAt: new Date(now - 60_000).toISOString(),
      lifecycleEpoch: "epoch-1",
      reportProtocol: "jsonl-v1" as const,
    };
    const registry = new Registry(state.dir);
    await registry.write(lane);
    const reports = new Reports(state.dir);
    await reports.report(lane.key, "milestone", "initial", now, lane.lifecycleEpoch);
    const journal = readFileSync(reports.path(lane.key), "utf8");
    const module = (name: string) => JSON.stringify(pathToFileURL(join(import.meta.dir, `../src/${name}.ts`)).href);
    const claimScript = join(state.dir, "claim.mjs");
    writeFileSync(
      claimScript,
      `import { existsSync } from "node:fs";
import { Registry, withStatus } from ${module("registry")};
import { recordDoneDecision } from ${module("native-close")};
const registry = new Registry(${JSON.stringify(state.dir)});
const lane = await registry.read(${JSON.stringify(lane.key)});
if (!lane) throw new Error("lane missing");
await recordDoneDecision({ registry }, lane, (current) => {
  console.log("CLAIM_LOCKED");
  const deadline = Date.now() + 8000;
  const clock = new Int32Array(new SharedArrayBuffer(4));
  while (!existsSync(${JSON.stringify(release)})) {
    if (Date.now() >= deadline) throw new Error("test barrier was not released");
    Atomics.wait(clock, 0, 0, 10);
  }
  return withStatus(current, "done-claimed", "claim after observation", ${JSON.stringify(new Date(now).toISOString())});
});
`,
    );
    const resultPath = join(state.dir, "result.json");
    const sweepScript = join(state.dir, "sweep.mjs");
    writeFileSync(
      sweepScript,
      `import { existsSync, writeFileSync } from "node:fs";
import { Registry } from ${module("registry")};
import { Supervision } from ${module("supervision")};
const registry = new Registry(${JSON.stringify(state.dir)});
const original = Registry.prototype.update;
Registry.prototype.update = function(...args) {
  console.log("SUPERVISION_WAITING");
  return original.apply(this, args);
};
const delivered = [];
const supervisor = new Supervision({
  stateDir: ${JSON.stringify(state.dir)}, registry,
  clock: { now: () => ${now}, sleep: (ms) => Bun.sleep(ms) },
  run: async (argv) => {
    if (argv[0] !== "usage-fixture") throw new Error("unexpected external command");
    if (existsSync(${JSON.stringify(join(registry.dir, `${lane.key}.deliver.lock`))}))
      throw new Error("usage observed under delivery lock");
    return { code: 0, out: JSON.stringify({ tokens: 1, costUsd: 1 }), err: "" };
  },
  alert: (_lane, message) => { delivered.push(message); },
}, { defaults: { wallMinutes: 0 }, usageArgv: ["usage-fixture"] });
const result = await supervisor.sweep(${JSON.stringify(lane)}, "Working 1m");
writeFileSync(${JSON.stringify(resultPath)}, JSON.stringify({ result, delivered }));
`,
    );
    const invoke = (script: string) => {
      const child = Bun.spawn([process.execPath, script], {
        env: { HOME: state.dir, TMPDIR: state.dir, PATH: dirname(process.execPath), DORI_TELEMETRY: "0" },
        stdout: "pipe",
        stderr: "pipe",
      });
      children.push(child);
      return child;
    };
    const claim = invoke(claimScript);
    const claimError = new Response(claim.stderr).text();
    await marker(claim.stdout, "CLAIM_LOCKED");
    const observer = invoke(sweepScript);
    const observerError = new Response(observer.stderr).text();
    await marker(observer.stdout, "SUPERVISION_WAITING");
    writeFileSync(release, "release");
    expect(await claim.exited).toBe(0);
    expect(await observer.exited).toBe(0);
    expect(await claimError).toBe("");
    expect(await observerError).toBe("");
    expect((await registry.read(lane.key))?.status).toBe("done-claimed");
    expect(readFileSync(reports.path(lane.key), "utf8")).toBe(journal);
    expect(JSON.parse(readFileSync(resultPath, "utf8"))).toEqual({
      result: { enabled: false, state: null, alerts: [], usage: null, hung: false },
      delivered: [],
    });
    expect(existsSync(join(state.dir, "lanes", lane.key, "cost.jsonl"))).toBe(false);
    expect(existsSync(join(state.dir, "lanes", lane.key, "supervision.json"))).toBe(false);
  } finally {
    writeFileSync(release, "release");
    for (const child of children) if (child.exitCode === null) child.kill();
    await Promise.all(children.map((child) => child.exited));
    state.done();
  }
}, 15_000);
