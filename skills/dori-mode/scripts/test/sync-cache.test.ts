import { afterEach, beforeEach, expect, test } from "bun:test";
import { syncRegistry } from "../src/sync.ts";
import { agentIn, depsFor, fakeClock, laneState, newWorld, withState, type TestState, type World } from "./fakes.ts";

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
  world.calls = [];
  await syncRegistry(deps, true);
  expect(shared()).toEqual({ psA: 3, paneList: 3 });
});
