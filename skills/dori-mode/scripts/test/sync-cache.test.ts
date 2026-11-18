import { afterEach, beforeEach, expect, test } from "bun:test";
import { syncRegistry } from "../src/sync.ts";
import { agentIn, depsFor, fakeClock, laneState, newWorld, withState, type TestState, type World } from "./fakes.ts";
import { hcTerm } from "./hc-runner.ts";

const T0 = Date.parse("2026-01-01T12:00:00.000Z");
let state: TestState;
let world: World;
beforeEach(() => {
  state = withState();
  world = newWorld();
});
afterEach(() => state.done());

test("a read-only sync shares one process table and one herdr pane list; --write reads them fresh", async () => {
  world.panes = [];
  const refs = [
    { runtime: "herdr", id: "w1:p1", group: "w1" },
    { runtime: "herdr", id: "w2:p2", group: "w2" },
  ] as const;
  const deps = depsFor(world, fakeClock(T0), state.dir, { runtime: "herdr", workspaces: ["w1", "w2"] });
  for (const [i, ref] of refs.entries()) {
    world.panes.push({ pane_id: ref.id, workspace_id: ref.group, agent: "omp", agent_status: "idle", cwd: "/repo" });
    agentIn(world, ref.id, 5000 + i * 10);
    laneState(state.dir, ref.id, { pid: 5000 + i * 10 });
    const at = new Date(T0).toISOString();
    await deps.registry.write({
      key: `omp-${i}`,
      title: "omp",
      thread: "none",
      pane: ref.id,
      sessionRef: ref,
      brief: "/b.md",
      done: "closed acme/app#1",
      openedAt: at,
    });
  }
  const shared = () => ({
    psA: world.calls.filter((c) => c.join(" ") === "ps -A -o pid=,ppid=,command=").length,
    paneList: world.calls.filter((c) => c[0] === "herdr" && c.at(-2) === "pane" && c.at(-1) === "list").length,
  });
  world.calls = [];
  const rows = (await syncRegistry(deps, false)).rows;
  expect(rows.map((row) => row.session.endsWith("(extension)"))).toEqual([true, true]);
  expect(shared()).toEqual({ psA: 1, paneList: 1 });
  expect(world.calls.filter((c) => c[2] === "process-info")).toHaveLength(2);
  world.calls = [];
  await syncRegistry(deps, true);
  expect(shared()).toEqual({ psA: 3, paneList: 3 });
  let processReads = 0;
  await syncRegistry(
    {
      ...deps,
      run: async (argv, opts) => {
        if (argv[0] === "ps" && argv[1] === "-A" && processReads++ === 0)
          return { code: 1, out: "", err: "temporary process lookup failure" };
        return deps.run(argv, opts);
      },
    },
    false,
  );
  expect(processReads).toBe(2);
  world.panes = [];
  world.calls = [];
  const next = await syncRegistry(deps, false);
  expect(next.drift).toHaveLength(2);
  expect(shared()).toEqual({ psA: 1, paneList: 1 });
});

test("hc keeps its separate group queries and reports only watched groups", async () => {
  world.terminals = {
    t1: hcTerm({ labels: { "dori.group": "one" } }),
    t2: hcTerm({ labels: { "dori.group": "two" } }),
    t3: hcTerm({ labels: { "dori.group": "outside" } }),
  };
  const deps = depsFor(world, fakeClock(T0), state.dir, { runtime: "hc", workspaces: ["one", "two"] });
  const result = await syncRegistry(deps, false);
  expect(result.unregistered.map((row) => row.pane)).toEqual(["t1", "t2"]);
  expect(world.calls.filter((argv) => argv[0] === "hc" && argv[2] === "ls")).toEqual([
    ["hc", "--json", "ls"],
    ["hc", "--json", "ls", "--label", "dori.group=one"],
    ["hc", "--json", "ls", "--label", "dori.group=two"],
  ]);
});
