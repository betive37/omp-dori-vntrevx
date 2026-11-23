import { afterEach, beforeEach, expect, spyOn, test } from "bun:test";
import * as fs from "node:fs";
import {
  appendFileSync,
  chmodSync,
  mkdirSync,
  readFileSync,
  renameSync,
  statSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { freshnessTick } from "../src/freshness.ts";
import { parseEvent, ReportError } from "../src/report-events.ts";
import { Reports, reportLine } from "../src/reports.ts";
import { statusOf, type Lane } from "../src/registry.ts";
import { depsFor, fakeClock, newWorld, withState } from "./fakes.ts";

const T0 = Date.parse("2026-01-01T12:00:00Z");

const MIN = 60_000;

const lane: Lane = {
  key: "report-lane",
  title: "reports",
  thread: "chat:team/1",
  pane: "w:p7",
  brief: "/b.md",
  done: "file /done.md",
  openedAt: new Date(T0).toISOString(),
  reportProtocol: "jsonl-v1",
};

let state: ReturnType<typeof withState>;

let reports: Reports;

beforeEach(() => {
  state = withState();
  reports = new Reports(state.dir);
});

afterEach(() => state.done());

test("report transitions survive restarting the reader without changing done protocol", async () => {
  // Given an open lane with an independent completion status.
  const deps = depsFor(newWorld(), fakeClock(T0), state.dir);
  await deps.registry.write(lane);
  // When each report kind is appended in order.
  for (const [kind, expected] of [
    ["milestone", "running"],
    ["blocker", "blocked"],
    ["milestone", "running"],
    ["halted", "halted"],
    ["milestone", "running"],
    ["done", "done"],
  ] as const) {
    await reports.report(lane.key, kind, `state ${expected}`, T0);
    // Then fresh readers recover the persisted state, not a memory cache.
    expect(new Reports(state.dir).read(lane.key)?.state).toBe(expected);
  }
  expect(statusOf((await deps.registry.read(lane.key)) ?? lane)).toBe("working");
  expect(readFileSync(reports.path(lane.key), "utf8").trim().split("\n")).toHaveLength(6);
});

test("report text round trips quotes and newlines but prints one human line", async () => {
  // Given untrusted text that must remain data.
  const text = 'tests passed\npush "abc123"; $(not a command)';
  // When recorded and rendered.
  const report = await reports.report(lane.key, "milestone", text, T0);
  // Then JSON preserves text while terminal output stays a single line.
  expect(new Reports(state.dir).read(lane.key)?.lastReport?.text).toBe(text);
  expect(reportLine(report)).toBe(`[REPORT] ${lane.key} | milestone | tests passed push "abc123"; $(not a command)`);
});

test("the printed line carries no terminal controls, while the journal keeps the raw text", async () => {
  // Given text with a carriage return, a CSI erase, an OSC title and a bell.
  const text = "tests passed\r\u001b[2Kall green\u001b]0;owned\u0007 done\u0008";
  // When recorded and rendered.
  const report = await reports.report(lane.key, "milestone", text, T0);
  // Then only printable text reaches the terminal, and the record is unchanged.
  expect(reportLine(report)).toBe(`[REPORT] ${lane.key} | milestone | tests passed all green done`);
  expect(new Reports(state.dir).read(lane.key)?.lastReport?.text).toBe(text);
});

test.each(["../escape", "/root", "x", "bad key"])("rejects invalid lane path %s", (key) => {
  // Given an unsafe key; when selecting storage; then no path is accepted.
  expect(() => reports.path(key)).toThrow(ReportError);
});

test.each([
  '{"type":"report","key":"other","at":"2026-01-01","kind":"done","text":"ok"}',
  '{"type":"report","key":"report-lane","at":"bad","kind":"done","text":"ok"}',
  '{"type":"report","key":"report-lane","at":"2026-01-01","kind":"unknown","text":"ok"}',
  '{"type":"report","key":"report-lane","at":"2026-01-01","kind":"done","text":" "}',
])("rejects malformed report records %#", (line) => {
  // Given an invalid record; when parsed; then it cannot assert progress.
  expect(() => parseEvent(line, lane.key)).toThrow(ReportError);
});

test("a corrupt journal fails with its line number instead of hiding a lost report", async () => {
  // Given a valid report followed by corruption.
  await reports.report(lane.key, "milestone", "first", T0);
  appendFileSync(reports.path(lane.key), "{partial\n");
  // When the journal is read; then corruption is explicit.
  expect(() => reports.read(lane.key)).toThrow("reports.jsonl:2:");
});

test("one corrupt journal is reported once and does not stop the sweep for other lanes", async () => {
  // Given a lane with a corrupt journal and another lane that is silent past the nudge time.
  const world = newWorld();
  world.panes = [{ pane_id: "w:p7", workspace_id: "w", agent: "pi", agent_status: "idle" }];
  world.onEnterStatus = "working";
  world.screen = "Working (1m)\n❯ ";
  const deps = depsFor(world, fakeClock(T0 + 30 * MIN), state.dir);
  await deps.registry.write({ ...lane, key: "bad-lane", pane: "w:p8" });
  await deps.registry.write(lane);
  await reports.report("bad-lane", "milestone", "first", T0);
  appendFileSync(reports.path("bad-lane"), "{partial\n");
  await reports.report(lane.key, "milestone", "started", T0);
  // When freshness runs twice.
  const first = await freshnessTick(deps, "/home/test");
  // Then the healthy lane is still nudged, and the error is printed once with its line number.
  expect(first.map((act) => `${act.kind} ${act.lane}`).sort()).toEqual([
    "journal-error bad-lane",
    `nudged ${lane.key}`,
  ]);
  expect(first.find((act) => act.kind === "journal-error")?.detail).toContain("reports.jsonl:2:");
  expect(world.calls.filter((call) => call[2] === "send-text").map((call) => call[3])).toEqual(["w:p7"]);
  expect((await freshnessTick(deps, "/home/test")).map((act) => act.kind)).toEqual([]);
});

test.each([false, true])("an inaccessible journal ancestor stays absent (memo=%s)", (memo) => {
  const lanes = join(state.dir, "lanes");
  mkdirSync(lanes, { recursive: true });
  const ancestor = join(lanes, lane.key);
  // Use a directory loop on POSIX; a file in place of the directory doesn't require symlink privileges on Windows.
  if (process.platform === "win32") writeFileSync(ancestor, "");
  else symlinkSync(lane.key, ancestor);
  expect(new Reports(state.dir, { memo }).read(lane.key)).toBeNull();
});

test("a memoizing reader shares unchanged reads but sees external appends and repeats corrupt-line errors", () => {
  const tick = new Reports(state.dir, { memo: true });
  expect(tick.read(lane.key)).toBeNull();
  reports.report(lane.key, "milestone", "one", T0);
  const reads = spyOn(fs, "readFileSync");
  const journalReads = () => reads.mock.calls.filter((call) => call[0] === reports.path(lane.key)).length;
  try {
    expect(tick.read(lane.key)?.lastReport?.text).toBe("one");
    expect(tick.read(lane.key)?.lastReport?.text).toBe("one");
    expect(journalReads()).toBe(1);
    new Reports(state.dir).report(lane.key, "question", "two", T0 + 1);
    expect(tick.read(lane.key)?.state).toBe("blocked");
    expect(journalReads()).toBe(2);
    appendFileSync(reports.path(lane.key), "{partial\n");
    expect(() => tick.read(lane.key)).toThrow("reports.jsonl:3:");
    expect(() => tick.read(lane.key)).toThrow("reports.jsonl:3:");
    expect(journalReads()).toBe(4);
  } finally {
    reads.mockRestore();
  }
});

test("memoized progress sees an atomic same-size replacement even with the old mtime", () => {
  reports.report(lane.key, "milestone", "one", T0);
  const tick = new Reports(state.dir, { memo: true });
  expect(tick.read(lane.key)?.lastReport?.text).toBe("one");
  const path = reports.path(lane.key);
  const original = statSync(path);
  const replacement = `${path}.replacement`;
  writeFileSync(replacement, readFileSync(path, "utf8").replace('"one"', '"two"'));
  utimesSync(replacement, original.atime, original.mtime);
  renameSync(replacement, path);
  expect(tick.read(lane.key)?.lastReport?.text).toBe("two");
});

test("unchanged journal reads keep raw, legacy, and reopened progress separate", () => {
  const tick = new Reports(state.dir, { memo: true });
  const legacy = { generation: undefined };
  const current = { generation: "current" };
  reports.report(lane.key, "done", "legacy done", T0);
  reports.report(lane.key, "milestone", "reopened", T0 + 1, current.generation);
  const result = (scope?: { generation: string | undefined }) => tick.read(lane.key, scope)?.lastReport?.text;
  expect([result(), result(legacy), result(current), result(legacy)]).toEqual([
    "reopened",
    "legacy done",
    "reopened",
    "legacy done",
  ]);
});

test("a quiet freshness tick reads the lane journal once and runs git status once", async () => {
  const world = newWorld();
  world.screen = "Working (1m)\n❯ ";
  const deps = depsFor(world, fakeClock(T0 + MIN), state.dir);
  await deps.registry.write({ ...lane, cwd: "/repo", lastReplyAt: T0 + MIN });
  reports.report(lane.key, "milestone", "started", T0);
  await freshnessTick(deps, "/home/test");
  const reads = spyOn(fs, "readFileSync");
  try {
    world.calls = [];
    expect(await freshnessTick(deps, "/home/test")).toEqual([]);
    expect(reads.mock.calls.filter((call) => call[0] === reports.path(lane.key))).toHaveLength(1);
    expect(world.calls.filter((call) => call[0] === "git" && call.includes("status"))).toHaveLength(1);
  } finally {
    reads.mockRestore();
  }
});

// POSIX-only: permission bits (0700/0600) have no meaning on Windows.
const posix = test.skipIf(process.platform === "win32");

posix("the lane journal directory is private (0700), like the 0600 journal", async () => {
  const state = withState();
  const umask = process.umask(0o022);
  try {
    const reports = new Reports(state.dir);
    await reports.report("private-lane", "milestone", "first", T0);
    expect(statSync(join(state.dir, "lanes", "private-lane")).mode & 0o777).toBe(0o700);
    expect(statSync(reports.path("private-lane")).mode & 0o777).toBe(0o600);
  } finally {
    process.umask(umask);
    state.done();
  }
});

posix("a lane directory created earlier with wider permissions is made 0700 on the next report", async () => {
  const dir = join(state.dir, "lanes", lane.key);
  mkdirSync(dir, { recursive: true, mode: 0o755 });
  chmodSync(dir, 0o755);
  await reports.report(lane.key, "milestone", "first", T0);
  expect(statSync(dir).mode & 0o777).toBe(0o700);
});
