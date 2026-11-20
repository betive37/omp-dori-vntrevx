import { afterEach, beforeEach, expect, spyOn, test } from "bun:test";
import { runtimesFor } from "../src/run.ts";
import { resolveSession } from "../src/session-id.ts";
import { agentIn, depsFor, fakeClock, laneState, newWorld, type TestState, withState, type World } from "./fakes.ts";

const T0 = Date.parse("2026-01-01T12:00:00.000Z");
const SID = "01a11440-ee81-7f90-b2ed-dcc7d51a0adf";
const NEXT = "01a11441-ee81-7f90-b2ed-dcc7d51a0adf";
const REF = { runtime: "herdr", id: "w1:p1" } as const;
let state: TestState;
let world: World;
beforeEach(() => {
  state = withState();
  world = newWorld();
  world.panes = [{ pane_id: REF.id, workspace_id: "w1", agent: "omp", agent_status: "idle", cwd: "/repo" }];
  agentIn(world, REF.id);
});
afterEach(() => state.done());
const setup = () => {
  const flow = depsFor(world, fakeClock(T0), state.dir);
  return {
    run: flow.run,
    stateDir: state.dir,
    sessionsDir: state.dir,
    listDir: () => [`2026-01-01T12-00-03-000Z_${NEXT}.jsonl`],
  };
};

test("a runtime probe exception remains an explicit unknown", async () => {
  const deps = setup();
  const rts = runtimesFor({ runtime: "herdr", stateDir: state.dir }, {}, deps.run);
  const probe = spyOn(rts.for(REF), "probe").mockRejectedValue(new Error("controlled runtime probe failure"));
  try {
    expect(await resolveSession(REF, "/repo", world.procs!, { ...deps, rts })).toEqual({
      id: "",
      via: "none",
      unknownReason: "runtime probe failed",
    });
  } finally {
    probe.mockRestore();
  }
});

test("an unattested positive-PID native record is not promoted to a nearby start-time guess", async () => {
  laneState(state.dir, REF.id, { sessionId: SID });
  const deps = setup();
  const run: typeof deps.run = async (argv, opts) =>
    argv.includes("lstart=") ? { code: 0, out: "Thu Jan  1 12:00:02 2026 GMT", err: "" } : deps.run(argv, opts);
  const hit = await resolveSession(REF, "/repo", world.procs!, { ...deps, run });
  expect(hit).toMatchObject({ id: "", via: "none", unknownReason: "native session record not attested" });
});

for (const record of ["absent", "retired"] as const) {
  test(`${record} native record preserves normal legacy start-time discovery`, async () => {
    if (record === "retired") laneState(state.dir, REF.id, { pid: 0, sessionId: SID });
    expect(await resolveSession(REF, "/repo", world.procs!, setup())).toEqual({
      id: NEXT,
      via: "start-time",
      pid: 4242,
    });
  });
}

test("a clock behind the native evidence is explicitly unknown; equality stays valid", async () => {
  laneState(state.dir, REF.id, { sessionId: SID });
  const deps = setup();
  expect(await resolveSession(REF, "/repo", world.procs!, { ...deps, now: () => T0 - 1 })).toMatchObject({
    id: "",
    via: "none",
    unknownReason: "clock behind native evidence",
  });
  expect(await resolveSession(REF, "/repo", world.procs!, { ...deps, now: () => T0 })).toEqual({
    id: SID,
    via: "extension",
    pid: 4242,
  });
});

test("custom argv remains valid even when an old OMP record exists", async () => {
  laneState(state.dir, REF.id, { sessionId: SID });
  world.panes[0]!.agent = "omo";
  world.procs!.find((p) => p.pid === 4242)!.cmd = `omo --session ${NEXT}`;
  expect(await resolveSession(REF, "/repo", world.procs!, setup())).toEqual({ id: NEXT, via: "argv", pid: 4242 });
});

for (const failure of ["exit", "throw"] as const) {
  test(`failed lstart (${failure}) cannot supply a start-time session guess`, async () => {
    const deps = setup();
    const run: typeof deps.run = async (argv, opts) => {
      if (!argv.includes("lstart=")) return deps.run(argv, opts);
      if (failure === "throw") throw new Error("controlled lstart failure");
      return { code: 1, out: "Thu Jan  1 12:00:00 2026 GMT", err: "partial output" };
    };
    expect(await resolveSession(REF, "/repo", world.procs!, { ...deps, run })).toMatchObject({
      id: "",
      via: "none",
      unknownReason: "process start unavailable",
    });
  });
}

test("failed child-env output cannot supply a custom session or fall through to a time guess", async () => {
  world.panes[0]!.agent = "omo";
  world.procs!.find((p) => p.pid === 4242)!.cmd = "omo";
  world.procs!.push({ pid: 4243, ppid: 4242, cmd: "bun mcp" });
  const deps = setup();
  const run: typeof deps.run = async (argv, opts) =>
    argv[1] === "eww" ? { code: 1, out: `bun mcp PI_SESSION_ID=${NEXT}`, err: "partial output" } : deps.run(argv, opts);
  expect(await resolveSession(REF, "/repo", world.procs!, { ...deps, run })).toMatchObject({
    id: "",
    via: "none",
    unknownReason: "child process environment unavailable",
  });
});

test("unreadable discovery directory remains unknown, not an empty successful lookup", async () => {
  expect(
    await resolveSession(REF, "/repo", world.procs!, {
      ...setup(),
      listDir: () => {
        throw new Error("unreadable");
      },
    }),
  ).toMatchObject({
    id: "",
    via: "none",
    unknownReason: "session directory unavailable",
  });
});
