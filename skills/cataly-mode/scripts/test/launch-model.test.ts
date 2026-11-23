import { afterEach, beforeEach, expect, test } from "bun:test";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import type { ModelReadback, PaneState } from "../src/lane-state.ts";
import { launchLane } from "../src/launch.ts";
import { modelLaunchProblem } from "../src/launch-model.ts";
import { snapshotFor } from "./model-snapshot-fixture.ts";
import { agentIn, depsFor, fakeClock, laneState, newWorld, sent, withState, type TestState } from "./fakes.ts";

let state: TestState;
beforeEach(() => {
  state = withState();
});
afterEach(() => state.done());

const launch = async (
  model: string,
  patch: Partial<PaneState> = {},
  options: { launchKeywords?: string; snapshot?: boolean } = {},
) => {
  const { launchKeywords } = options;
  const world = newWorld();
  const clock = fakeClock(Date.parse("2026-01-01T12:00:00.000Z"));
  const brief = join(state.dir, "brief.md");
  writeFileSync(brief, "Do not dispatch until the model is checked.\n");
  world.panes = [{ pane_id: "w:p9", workspace_id: "w", agent: "omp", agent_status: "idle" }];
  agentIn(world, "w:p9");
  laneState(state.dir, "w:p9", { agentStatus: "idle", ...patch });
  world.onEnterStatus = "working";
  const base = depsFor(
    world,
    {
      ...clock,
      sleep: async (ms) => {
        clock.at += ms;
      },
    },
    state.dir,
    { goalMarker: "", startupWaitSeconds: 20, ...(launchKeywords === undefined ? {} : { launchKeywords }) },
  );
  const deps = {
    ...base,
    run: async (argv: readonly string[]) => {
      if (argv[0] === "herdr" && argv[1] === "tab" && argv[2] === "create")
        return {
          code: 0,
          out: JSON.stringify({ result: { root_pane: { pane_id: "w:p9" }, tab_id: "w:t9" } }),
          err: "",
        };
      if (argv[0] === "herdr" && argv[2] === "run") {
        const lane = await base.registry.read("model-gate");
        if (!lane?.modelProfileFile) throw new Error("launch fixture missing its allocated model profile");
        const observed = patch.modelReadback?.observed;
        laneState(state.dir, "w:p9", {
          agentStatus: "idle",
          modelProfileFile: lane.modelProfileFile,
          ...(observed && options.snapshot !== false
            ? { modelSnapshot: snapshotFor(`${observed.provider}/${observed.id}`, model) }
            : {}),
          ...patch,
        });
      }
      const response = await base.run(argv);
      if (argv[0] === "herdr" && argv[2] === "send-keys" && argv[4] === "enter" && response.code === 0)
        laneState(state.dir, "w:p9", { ...patch, agentStatus: "working" });
      return response;
    },
  };
  const result = await launchLane(deps, {
    key: "model-gate",
    title: "Model gate",
    brief,
    model,
    done: "closed acme/app#3",
  });
  return { result, world };
};

test("an unknown native model never receives the launch brief even with a goal-marker opt-out", async () => {
  const { result, world } = await launch("subscription/exact");
  expect(result.startup).toStartWith("STARTUP_MODEL_HOLD model-gate w:p9:");
  expect(sent(world)).toEqual([]);
  expect(world.calls.find((argv) => argv[2] === "run")?.at(-1)).not.toContain("Read and execute");
});

const matched = {
  requested: { provider: "subscription", id: "exact" },
  observed: { provider: "subscription", id: "exact" },
  status: "matched" as const,
  billing: "subscription" as const,
  checkedAt: "2026-01-01T12:00:00.000Z",
  source: "native-extension" as const,
};

test("an exact live readback delivers once after starting without the brief", async () => {
  const { result, world } = await launch("subscription/exact", { modelReadback: matched });
  expect(result.startup).toBe("STARTUP_OK model-gate w:p9");
  expect(result.lane.model).toBe("subscription/exact");
  expect(result.lane.modelSnapshot).toMatchObject({
    model: matched.observed,
    provenance: { kind: "launch", requested: "subscription/exact" },
  });
  expect(result.lane.modelProfileFile).toContain(join("model-profiles", ""));
  expect(sent(world)).toHaveLength(1);
  expect(sent(world)[0]).toContain("Read and execute");
  const command = world.calls.find((argv) => argv[2] === "run")?.at(-1);
  expect(command).toContain("--cataly-launch-model=subscription/exact");
  expect(command).not.toContain("Read and execute");
});

test("native case-insensitive exact readback is accepted without changing the requested identity", async () => {
  const { result, world } = await launch("Subscription/EXACT", {
    modelReadback: { ...matched, requested: { provider: "Subscription", id: "EXACT" } },
  });
  expect(result.startup).toBe("STARTUP_OK model-gate w:p9");
  expect(sent(world)).toHaveLength(1);
  expect(modelLaunchProblem(["omp", "--model", "{model}", "{prompt}"], "ollama/qwen:14b")).toBeNull();
});

test("a thinking-suffixed launch delivers once its base model and native level both read back", async () => {
  const high = {
    ...matched,
    requested: { provider: "subscription", id: "exact:high" },
    thinking: { requested: "high", observed: "high" },
  };
  const { result, world } = await launch("subscription/exact:high", { modelReadback: high });
  expect(result.startup).toBe("STARTUP_OK model-gate w:p9");
  expect(sent(world)).toHaveLength(1);
  expect(world.calls.find((argv) => argv[2] === "run")?.at(-1)).toContain(
    "--cataly-launch-model=subscription/exact:high",
  );
  for (const patch of [
    { ...high, thinking: { requested: "high", observed: "low" } },
    { ...matched, requested: high.requested },
    {
      ...high,
      observed: { provider: "subscription", id: "exact:high" },
      thinking: { requested: "low", observed: "low" },
    },
  ]) {
    state.done();
    state = withState();
    const held = await launch("subscription/exact:high", { modelReadback: patch });
    expect(held.result.startup).toStartWith("STARTUP_MODEL_HOLD");
    expect(sent(held.world)).toEqual([]);
  }
});

test("a thinking record must name the request's own effort suffix before it selects the base model", async () => {
  const proof = (id: string, thinking?: unknown) =>
    ({
      ...matched,
      requested: { provider: "subscription", id },
      ...(thinking === undefined ? { observed: { provider: "subscription", id } } : { thinking }),
    }) as ModelReadback;
  // A literal catalog id that ends in a level keeps the exact path without a thinking record.
  const literal = await launch("subscription/exact:high", { modelReadback: proof("exact:high") });
  expect(literal.result.startup).toBe("STARTUP_OK model-gate w:p9");
  expect(sent(literal.world)).toHaveLength(1);
  for (const [model, patch] of [
    ["subscription/exact:high", proof("exact:high", {})],
    ["subscription/exact:high", proof("exact:high", null)],
    ["subscription/exact:14b", proof("exact:14b", { requested: "14b", observed: "14b" })],
    ["subscription/exact:HIGH", proof("exact:HIGH", { requested: "HIGH", observed: "HIGH" })],
  ] as const) {
    state.done();
    state = withState();
    const held = await launch(model, { modelReadback: patch });
    expect(held.result.startup).toStartWith("STARTUP_MODEL_HOLD");
    expect(sent(held.world)).toEqual([]);
  }
});

test("unsafe typed launch text is held without a send or an unhandled delivery error", async () => {
  const { result, world } = await launch(
    "subscription/exact",
    { modelReadback: matched },
    { launchKeywords: "ulw $(work)" },
  );
  expect(result.startup).toStartWith("STARTUP_MODEL_HOLD");
  expect(result.startup).toContain("refusing to send text");
  expect(sent(world)).toEqual([]);
});

test("mismatch, unavailable, stale and foreign-provider evidence never dispatches", async () => {
  for (const patch of [
    { ...matched, status: "mismatch" as const },
    { ...matched, status: "unavailable" as const },
    { ...matched, observed: { provider: "metered", id: "exact" } },
    { ...matched, checkedAt: "2025-12-31T12:00:00.000Z" },
  ]) {
    const { result, world } = await launch("subscription/exact", { modelReadback: patch });
    expect(result.startup).toStartWith("STARTUP_MODEL_HOLD");
    expect(sent(world)).toEqual([]);
    state.done();
    state = withState();
  }
});

test("matched identity alone cannot dispatch without its process-bound snapshot", async () => {
  for (const patch of [
    null,
    { modelProfileFile: "/another/process.json" },
    { modelSnapshotError: "native profile drift" },
    { modelSnapshot: snapshotFor("subscription/other") },
  ]) {
    const { result, world } = await launch(
      "subscription/exact",
      { modelReadback: matched, ...patch },
      { snapshot: patch !== null },
    );
    expect(result.startup).toStartWith("STARTUP_MODEL_HOLD");
    expect(sent(world)).toEqual([]);
    state.done();
    state = withState();
  }
});

test("an unqualified or ambiguous model is rejected before opening a pane", async () => {
  await expect(launch("exact")).rejects.toThrow("exact provider/model");
});
