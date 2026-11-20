import { afterEach, beforeEach, expect, spyOn, test } from "bun:test";
import { readFileSync } from "node:fs";
import { makeCli } from "../src/cli-context.ts";
import { opsCommands } from "../src/cli-ops.ts";
import { runtimesOf } from "../src/run.ts";
import { sendVerified } from "../src/sessions.ts";
import { syncRegistry } from "../src/sync.ts";
import { getStatus } from "../src/voice/status.ts";
import { agentIn, depsFor, fakeClock, laneState, newWorld, type TestState, withState, type World } from "./fakes.ts";

const AT = "2026-01-01T12:00:00.000Z";
const SID = "01a11440-ee81-7f90-b2ed-dcc7d51a0adf";
const NEXT = "01a11441-ee81-7f90-b2ed-dcc7d51a0adf";
const REF = { runtime: "herdr", id: "w1:p1" } as const;
let state: TestState;
let world: World;
beforeEach(() => {
  state = withState();
  world = newWorld();
});
afterEach(() => state.done());

const setup = async (custom = false) => {
  world.panes = [
    { pane_id: REF.id, workspace_id: "w1", agent: custom ? "omo" : "omp", agent_status: "idle", cwd: "/repo" },
  ];
  agentIn(world, REF.id);
  if (custom) world.procs!.find((p) => p.pid === 4242)!.cmd = `omo --session ${NEXT}`;
  else laneState(state.dir, REF.id, { sessionId: SID });
  const deps = depsFor(world, fakeClock(Date.parse(AT)), state.dir);
  const lane = {
    key: "observed",
    title: "Observed",
    thread: "none",
    pane: REF.id,
    sessionRef: REF,
    session: SID,
    brief: "/b.md",
    done: "closed acme/app#1",
    openedAt: AT,
  };
  await deps.registry.write(lane);
  return { deps, lane };
};

for (const failure of ["empty", "partial", "throw"] as const) {
  test(`failed process table (${failure}) stays unknown and cannot change a stored session`, async () => {
    const { deps, lane } = await setup(true);
    const before = readFileSync(deps.registry.path(lane.key), "utf8");
    const run: typeof deps.run = async (argv, opts) => {
      const result = await deps.run(argv, opts);
      if (argv[0] !== "ps" || argv[1] !== "-A") return result;
      if (failure === "throw") throw new Error("controlled process lookup failure");
      return { code: 1, out: failure === "partial" ? result.out : "", err: "controlled failure" };
    };
    const snapshot = await syncRegistry({ ...deps, run }, true);
    expect(snapshot.rows[0]).toMatchObject({
      session: SID,
      status: "working",
      source: "registry",
      relationship: "unknown",
    });
    expect(snapshot.rows[0]?.unknownReason).toContain("process table");
    expect(snapshot.drift).toEqual([]);
    expect(readFileSync(deps.registry.path(lane.key), "utf8")).toBe(before);
  });
}

test("a failed pane probe is unknown, not gone, while another pane keeps its successful observation", async () => {
  const { deps, lane } = await setup();
  const ref = { runtime: "herdr", id: "w1:p2" } as const;
  world.panes.push({ pane_id: ref.id, workspace_id: "w1", agent: "omp", agent_status: "idle", cwd: "/repo" });
  agentIn(world, ref.id, 5000);
  laneState(state.dir, ref.id, { pid: 5000, sessionId: SID });
  await deps.registry.write({ ...lane, key: "healthy", pane: ref.id, sessionRef: ref });
  const before = readFileSync(deps.registry.path(lane.key), "utf8");
  const run: typeof deps.run = async (argv, opts) => {
    if (argv[2] === "process-info" && argv[4] === REF.id) throw new Error("controlled pane probe failure");
    return deps.run(argv, opts);
  };
  const result = await syncRegistry({ ...deps, run }, false);
  expect(result.rows.find((row) => row.key === lane.key)).toMatchObject({
    source: "registry",
    relationship: "unknown",
    unknownReason: "process root unavailable",
  });
  expect(result.rows.find((row) => row.key === "healthy")).toMatchObject({
    source: "extension",
    relationship: "matched",
    unknownReason: null,
  });
  expect(result.drift).toEqual([]);
  expect(world.calls.filter((c) => c.join(" ") === "ps -A -o pid=,ppid=,command=")).toHaveLength(1);
  expect(readFileSync(deps.registry.path(lane.key), "utf8")).toBe(before);
  await syncRegistry({ ...deps, run }, true);
  expect(readFileSync(deps.registry.path(lane.key), "utf8")).toBe(before);
});

test("JSON adds observation fields without changing the old rows, drift or unregistered meanings", async () => {
  const { deps, lane } = await setup();
  const snapshot = await syncRegistry(deps, false);
  const json = JSON.parse(JSON.stringify(snapshot));
  expect(json.observedAt).toBe(AT);
  expect(json.rows[0]).toMatchObject({ source: "extension", relationship: "matched", unknownReason: null });
  const legacyRow = ({ key, thread, pane, session, status }: (typeof snapshot.rows)[number]) => ({
    key,
    thread,
    pane,
    session,
    status,
  });
  expect({ rows: json.rows.map(legacyRow), drift: json.drift, unregistered: json.unregistered.map(legacyRow) }).toEqual(
    {
      rows: [{ key: lane.key, thread: "none", pane: REF.id, session: `${SID} (extension)`, status: "working" }],
      drift: [],
      unregistered: [],
    },
  );
  await deps.registry.update(lane.key, (current) => current && { ...current, session: NEXT });
  const changed = await syncRegistry(deps, false);
  expect(changed.rows[0]?.relationship).toBe("changed");
  expect(changed.drift).toEqual([`${lane.key}: pane now runs session ${SID} (registry has ${NEXT})`]);
  await deps.registry.write({
    key: "unbound",
    title: "Unbound",
    thread: "none",
    pane: REF.id,
    sessionRef: REF,
    brief: "/b.md",
    done: lane.done,
    openedAt: AT,
  });
  expect((await syncRegistry(deps, false)).rows.find((row) => row.key === "unbound")?.relationship).toBe("unbound");
});

test("successful custom argv discovery keeps its existing write and display behavior", async () => {
  const { deps, lane } = await setup(true);
  const result = await syncRegistry(deps, true);
  expect(result.rows[0]).toMatchObject({
    session: `${NEXT} (argv)`,
    source: "argv",
    relationship: "changed",
    unknownReason: null,
  });
  expect((await deps.registry.read(lane.key))?.session).toBe(NEXT);
  expect((await syncRegistry(deps, false)).rows[0]?.relationship).toBe("matched");
});

test("CLI and voice show observation provenance and unknown reasons without performing a delivery", async () => {
  const { deps } = await setup();
  const run: typeof deps.run = async (argv, opts) =>
    argv[0] === "ps" && argv[1] === "-A"
      ? { code: 1, out: "", err: "controlled process lookup failure" }
      : deps.run(argv, opts);
  const failed = { ...deps, run };
  const lines: string[] = [];
  const log = spyOn(console, "log").mockImplementation((line: unknown) => {
    lines.push(String(line));
  });
  try {
    await opsCommands["sync"]!(makeCli("sync", [], { values: {}, positionals: [] }, deps.config, failed));
  } finally {
    log.mockRestore();
  }
  const shown = lines.join("\n");
  expect(shown).toContain(`OBSERVED ${AT}`);
  expect(shown).toContain("source | relationship | unknownReason");
  expect(shown).toContain(`${SID} | working | registry | unknown | process table unavailable`);
  expect(shown).toContain("READ_ONLY");
  const voice = await getStatus(failed, ["lanes"]);
  expect(voice.result).toContain(`read at ${AT}`);
  expect(voice.result).toContain("source=registry relationship=unknown unknown=process table unavailable");
  expect(world.calls.some((c) => c[2] === "send-text" || c[2] === "send-keys")).toBe(false);
});

test("a successful read-only snapshot cannot authorize delivery after a fresh process lookup fails", async () => {
  const { deps } = await setup();
  let failing = false;
  const run: typeof deps.run = async (argv, opts) =>
    failing && argv[0] === "ps" && argv[1] === "-A"
      ? { code: 1, out: "", err: "controlled later failure" }
      : deps.run(argv, opts);
  const flow = { ...deps, run };
  expect((await syncRegistry(flow, false)).rows[0]?.session).toBe(`${SID} (extension)`);
  failing = true;
  expect(
    await sendVerified(runtimesOf(flow), deps.clock, REF, "Do not send from a cached observation", undefined, SID),
  ).toBe("failed");
  expect(world.calls.some((c) => c[2] === "send-text" || c[2] === "send-keys")).toBe(false);
  expect((await syncRegistry(flow, false)).rows[0]?.relationship).toBe("unknown");
});
