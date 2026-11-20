import { expect, test } from "bun:test";
import type { Wait, WaitTarget } from "../../../../src/wait.ts";
import { type Report, reportId } from "../src/reports.ts";

const base: Report = {
  type: "report",
  key: "wait-receipt",
  at: "2026-01-01T12:00:00.000Z",
  kind: "blocker",
  text: "Waiting on the observed operation",
};
const time = Date.parse(base.at);
const session = { sessionId: "native-session", sessionStartedAt: "2026-01-01T11:00:00.000Z" };
const job: WaitTarget = { kind: "job", id: "bg_1", jobStartTime: time - 1_000, ...session };
const approval: WaitTarget = { kind: "approval", id: "call-1", ...session };
const ci: WaitTarget = { kind: "ci", repo: "vntrevx/Cataly", number: 151, head: "a".repeat(40), checkRun: 7 };
const label: WaitTarget = { kind: "label", text: "upstream review" };
const waiting = (target: WaitTarget): Wait => ({
  target,
  startedAt: time,
  observedAt: time,
  lastObservedState: target.kind === "label" ? "unverified" : target.kind === "approval" ? "pending" : "running",
});
const id = (wait: Wait): string => reportId({ ...base, wait });

test("ordinary reports retain the exact six-field main report IDs", () => {
  expect(reportId(base)).toBe("51faa1e47b548c63f9b2d303d613a176ff7ca4787f5996f907c6b8cc07a2045b");
  expect(reportId({ ...base, owner: "Owner summary", generation: "epoch-1" })).toBe(
    "66868a082cb361d79c0ed55dbd79b86061810fc54b30e449c453dbe60fdbf81a",
  );
  const { wait: _wait, ...withoutWait } = { ...base, wait: waiting(job) };
  expect(reportId(withoutWait)).toBe(reportId(base));
});

const identities: [string, WaitTarget, WaitTarget][] = [
  ["job ID", job, { ...job, id: "bg_2" }],
  ["job start time", job, { ...job, jobStartTime: job.jobStartTime + 1 }],
  ["job session", job, { ...job, sessionId: "replacement" }],
  ["job session start", job, { ...job, sessionStartedAt: "2026-01-01T11:00:00.001Z" }],
  ["approval ID", approval, { ...approval, id: "call-2" }],
  ["approval session", approval, { ...approval, sessionId: "replacement" }],
  ["approval session start", approval, { ...approval, sessionStartedAt: "2026-01-01T11:00:00.001Z" }],
  ["CI repository", ci, { ...ci, repo: "another/repository" }],
  ["CI PR number", ci, { ...ci, number: 152 }],
  ["CI head", ci, { ...ci, head: "b".repeat(40) }],
  ["CI check run", ci, { ...ci, checkRun: 8 }],
  ["CI check-run selection", ci, { kind: "ci", repo: ci.repo, number: ci.number, head: ci.head }],
  ["label", label, { ...label, text: "owner decision" }],
  ["wait kind", job, approval],
];

test.each(identities)("same-ms same-text report IDs bind the full %s identity", (_name, before, after) => {
  expect(id(waiting(after))).not.toBe(id(waiting(before)));
});

test("a structured wait and all of its observation metadata participate in the report ID", () => {
  const wait = waiting(job);
  expect(id(wait)).not.toBe(reportId(base));
  expect(id({ ...wait, startedAt: wait.startedAt + 1 })).not.toBe(id(wait));
  expect(id({ ...wait, observedAt: wait.observedAt + 1 })).not.toBe(id(wait));
  expect(id({ ...wait, lastObservedState: "completed" })).not.toBe(id(wait));
});

test.each([job, approval, ci, label])("%s wait IDs do not depend on JSON property insertion order", (target) => {
  const wait = waiting(target);
  const reordered: Wait = {
    lastObservedState: wait.lastObservedState,
    observedAt: wait.observedAt,
    startedAt: wait.startedAt,
    target: Object.fromEntries(Object.entries(target).reverse()) as WaitTarget,
  };
  expect(id(reordered)).toBe(id(wait));
});

test("CI identity retains the existing case-insensitive repository and head equivalence", () => {
  expect(id(waiting({ ...ci, repo: ci.repo.toUpperCase(), head: ci.head.toUpperCase() }))).toBe(id(waiting(ci)));
});
