import { setSystemTime, spyOn } from "bun:test";
import type { NativeObservation } from "../../../../src/native-observation.ts";
import { makeCli } from "../src/cli-context.ts";
import { journalCommands } from "../src/cli-journal.ts";
import type { FlowDeps } from "../src/done-flow.ts";
import type { Lane } from "../src/registry.ts";
import { Reports } from "../src/reports.ts";
import { agentIn, depsFor, fakeClock, laneState, newWorld, withState } from "./fakes.ts";

export const T0 = Date.parse("2026-01-01T12:00:00Z");
export const SESSION = "01a11440-ee81-7f90-b2ed-dcc7d51a0adf";

export async function waitFixture() {
  const state = withState();
  const clock = fakeClock(T0 + 1_000);
  setSystemTime(new Date(clock.at));
  const world = newWorld();
  const pane = "w:p7";
  world.panes = [{ pane_id: pane, workspace_id: "w", agent: "omp", agent_status: "idle" }];
  agentIn(world, pane);
  const base = depsFor(world, clock, state.dir);
  const control: { onProbe?: () => Promise<void>; api?: (endpoint: string) => unknown } = {};
  const deps: FlowDeps = {
    ...base,
    run: async (...args) => {
      if (args[0][0] === "ps" && args[0].includes("lstart=") && control.onProbe) {
        const action = control.onProbe;
        delete control.onProbe;
        await action();
      }
      if (args[0][0] === "gh" && args[0][1] === "api" && control.api) {
        world.calls.push([...args[0]]);
        const endpoint = args[0][4];
        if (!endpoint) throw new Error("API endpoint missing");
        return { code: 0, out: JSON.stringify(await control.api(endpoint)), err: "" };
      }
      return base.run(...args);
    },
  };
  const lane: Lane = {
    key: "waiting-lane",
    title: "waiting",
    thread: "none",
    pane,
    brief: "/b.md",
    done: "file /done.md",
    openedAt: new Date(T0).toISOString(),
    reportProtocol: "jsonl-v1",
  };
  await deps.registry.write(lane);
  const reports = new Reports(state.dir);
  const observe = (jobs: NativeObservation["jobs"], approvals: NativeObservation["approvals"] = []) => {
    laneState(state.dir, pane, { native: { observedAt: clock.at, jobs, approvals } });
  };
  observe({ running: [{ id: "bg_1", startTime: T0 }], recent: [] });
  const report = async (selection: string, kind = "blocker", text = "Waiting on the observed operation") => {
    const handler = journalCommands["report"];
    if (!handler) throw new Error("report handler missing");
    const output = spyOn(console, "log").mockImplementation(() => {});
    try {
      await handler(
        makeCli("report", [], { positionals: [lane.key], values: { kind, text, for: selection } }, deps.config, deps),
      );
      return { record: reports.read(lane.key)?.lastReport, lines: output.mock.calls.map((args) => args.join(" ")) };
    } finally {
      output.mockRestore();
    }
  };
  return {
    state,
    clock,
    world,
    deps,
    control,
    lane,
    reports,
    observe,
    report,
    advance: (ms: number) => {
      clock.at += ms;
      setSystemTime(new Date(clock.at));
    },
    done: () => {
      setSystemTime();
      state.done();
    },
  };
}
