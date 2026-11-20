import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { laneGoalActive } from "../src/goal-record.ts";
import { pauseLane } from "../src/pause.ts";
import { runtimesFor } from "../src/run.ts";
import { sessionDirFor } from "../src/session-id.ts";
import {
  agentIn,
  depsFor,
  fakeClock,
  laneState,
  newWorld,
  sent,
  type TestState,
  withState,
  type World,
} from "./fakes.ts";

const AT = "2026-01-01T12:00:00.000Z";
const SID = "01a11440-ee81-7f90-b2ed-dcc7d51a0adf";
const REF = { runtime: "herdr", id: "w1:p1" } as const;
let state: TestState;
let world: World;
beforeEach(() => {
  state = withState();
  world = newWorld();
  world.panes = [{ pane_id: REF.id, workspace_id: "w1", agent: "omp", agent_status: "idle", cwd: "/repo" }];
  agentIn(world, REF.id);
  world.onEnterStatus = "working";
});
afterEach(() => state.done());

const setup = async () => {
  const deps = depsFor(world, fakeClock(Date.parse(AT)), state.dir, { agentCommand: ["omp"], sessionsDir: state.dir });
  const lane = {
    key: "unbound",
    title: "Unbound",
    thread: "none",
    pane: REF.id,
    sessionRef: REF,
    brief: "/b.md",
    done: "closed acme/app#1",
    openedAt: AT,
  };
  await deps.registry.write(lane);
  return { deps, lane };
};

for (const failure of ["partial", "empty", "throw"] as const) {
  test(`unbound native pause cannot turn a failed process read (${failure}) into missing identity`, async () => {
    const { deps, lane } = await setup();
    laneState(state.dir, REF.id, { role: "dori" });
    const before = readFileSync(deps.registry.path(lane.key), "utf8");
    let reads = 0;
    const run: typeof deps.run = async (argv, opts) => {
      const result = await deps.run(argv, opts);
      if (argv[0] !== "ps" || argv[1] !== "-A" || reads++ !== 0) return result;
      if (failure === "throw") throw new Error("controlled lookup failure");
      return { ...result, code: 1, out: failure === "partial" ? result.out : "", err: "controlled failure" };
    };
    await expect(pauseLane({ ...deps, run }, lane, "fixture pause")).rejects.toThrow("process table unavailable");
    expect(sent(world)).toEqual([]);
    expect(readFileSync(deps.registry.path(lane.key), "utf8")).toBe(before);
    expect(world.calls.some((c) => c[2] === "send-keys")).toBe(false);
  });
}

test("a healthy unbound native lane still pauses and confirms through fresh native state", async () => {
  const { deps, lane } = await setup();
  laneState(state.dir, REF.id, { sessionId: SID });
  world.onSendText = (_id, text) => {
    if (text === "/goal pause") laneState(state.dir, REF.id, { sessionId: SID, goal: { status: "paused" } });
  };
  const result = await pauseLane(deps, lane, "fixture pause");
  expect(result.code).toBe(0);
  expect(result.lane.status).toBe("paused");
  expect(sent(world)).toEqual(["/goal pause"]);
});

test("launch goal observation propagates failed process evidence instead of claiming a goal; healthy evidence works", async () => {
  const { deps, lane } = await setup();
  const dir = sessionDirFor(state.dir, "/repo");
  mkdirSync(dir, { recursive: true });
  const sessionFile = join(dir, `2026-01-01T12-00-00-000Z_${SID}.jsonl`);
  writeFileSync(
    sessionFile,
    JSON.stringify({ type: "message", message: { role: "user", content: `You are the ${lane.key} lane` } }) + "\n",
  );
  laneState(state.dir, REF.id, { sessionId: SID, sessionFile });
  const proof = { run: deps.run, rts: runtimesFor(deps.config, {}, deps.run), stateDir: state.dir, ref: REF };
  expect(await laneGoalActive(state.dir, "/repo", lane.key, Date.parse(AT), proof)).toBe(true);
  const run: typeof deps.run = async (argv, opts) =>
    argv[0] === "ps" && argv[1] === "-A"
      ? { code: 1, out: "", err: "controlled goal observation failure" }
      : deps.run(argv, opts);
  await expect(
    laneGoalActive(state.dir, "/repo", lane.key, Date.parse(AT), {
      ...proof,
      run,
      rts: runtimesFor(deps.config, {}, run),
    }),
  ).rejects.toThrow("process table unavailable");
  expect(sent(world)).toEqual([]);
});
