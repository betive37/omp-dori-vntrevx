import { afterEach, beforeEach, expect, test } from "bun:test";
import { readPaneState } from "../src/lane-state.ts";
import { parkLane } from "../src/park.ts";
import { resumeLane } from "../src/pause.ts";
import { reopenLane } from "../src/reopen.ts";
import { laneState, sent } from "./fakes.ts";
import { lifecycleFixture, type LifecycleFixture } from "./lifecycle-fixture.ts";

let f: LifecycleFixture;
beforeEach(async () => {
  f = await lifecycleFixture();
});
afterEach(() => f.state.done());

test.each(["registry/stale-model", undefined])(
  "reopen does not replace its native model with registry value %s or the current default",
  async (model) => {
    const lane = { ...f.lane, ...(model === undefined ? {} : { model }) };
    await f.deps.registry.write(lane);
    const parked = await parkLane(f.deps, lane, "wait");
    const deps = {
      ...f.deps,
      config: {
        ...f.deps.config,
        defaultModel: "provider/new-default",
        agentCommand: [
          "omp",
          "--cataly-role",
          "lane",
          "--model",
          "{model}",
          "--provider=new-provider",
          "--thinking=high",
          "--no-lsp",
          "{prompt}",
        ],
      },
    };
    const reopened = await reopenLane(deps, parked.lane);
    expect(reopened.code).toBe(0);
    expect(reopened.lane.model).toBe("fixture/saved");
    expect(reopened.lane.modelSnapshot?.model).toEqual({ provider: "fixture", id: "saved" });
    const command = f.world.calls.find((argv) => argv[2] === "run")?.[4];
    expect(command).toContain(`--resume=${f.file}`);
    expect(command).toContain("--no-lsp");
    expect(command).not.toContain("--model=");
    expect(command).not.toContain("--provider=");
    expect(command).not.toContain("--thinking=");
    expect(command).not.toContain("registry/stale-model");
    expect(command).not.toContain("provider/new-default");
    expect(command).not.toContain("{model}");
    expect(sent(f.world)).toEqual(["/goal pause", "/goal resume"]);
  },
);

test("reopen refuses a live model alias in an extension option before creating a pane", async () => {
  const parked = await parkLane(f.deps, f.lane, "wait");
  await expect(
    reopenLane(
      { ...f.deps, config: { ...f.deps.config, agentCommand: ["omp", "--owner-option={model}", "{prompt}"] } },
      parked.lane,
    ),
  ).rejects.toThrow("cannot resolve {model}");
  expect(f.creates()).toBe(0);
  expect(sent(f.world)).toEqual(["/goal pause"]);
});

test("unknown native model snapshot stays paused and cannot be bypassed by resume", async () => {
  const parked = await parkLane(f.deps, f.lane, "wait");
  const deps = {
    ...f.deps,
    run: async (argv: readonly string[]) => {
      const result = await f.deps.run(argv);
      if (argv[0] === "herdr" && argv[2] === "run") {
        const state = readPaneState(f.state.dir, "w1:p8");
        if (!state) throw new Error("missing fixture state");
        const { modelSnapshot: _snapshot, ...unknown } = state;
        laneState(f.state.dir, "w1:p8", { ...unknown, modelSnapshotError: "native snapshot unknown" });
      }
      return result;
    },
  };
  const reopened = await reopenLane(deps, parked.lane);
  expect(reopened.code).toBe(3);
  expect(reopened.lines.join("\n")).toContain("native snapshot unknown");
  expect(reopened.lane.status).toBe("paused");
  expect((await resumeLane(deps, reopened.lane, "explicit resume")).code).toBe(3);
  expect(sent(f.world)).toEqual(["/goal pause"]);
});
