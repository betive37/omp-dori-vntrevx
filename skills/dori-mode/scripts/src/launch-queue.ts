import { randomUUID } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { withLaunchLock } from "./delivery-lock.ts";
import type { FlowDeps } from "./done-flow.ts";
import { sampleHost, type HostSample } from "./host-guard.ts";
import { originalBrief } from "./launch-footer.ts";
import { LaunchQueue, type QueueEntry } from "./launch-queue-store.ts";
import { QueueError } from "./launch-errors.ts";
import { launchLane, prepareLaunch } from "./launch.ts";
import type { LaunchInput } from "./launch-input.ts";
import { LANE_KEY, statusOf } from "./registry.ts";
import { canLaunch } from "./routing.ts";
import { iso, runtimesOf } from "./run.ts";
import { checkDone } from "./signals.ts";

type Sample = () => Promise<HostSample>;
const sampler =
  (deps: FlowDeps): Sample =>
  () =>
    sampleHost(deps.run, deps.config.defaultCwd, runtimesOf(deps));

const blockedBy = async (deps: FlowDeps, entry: QueueEntry, sample?: Sample): Promise<string[]> => {
  if (Date.parse(entry.expiresAt) <= deps.clock.now()) return ["expired; cancel and requeue after reviewing the brief"];
  const reasons: string[] = [];
  for (const key of entry.after) {
    const lane = await deps.registry.read(key);
    const receipt = lane?.receipt;
    if (!lane || statusOf(lane) !== "closed") {
      reasons.push(`${key}(${lane ? statusOf(lane) : "not registered"})`);
      continue;
    }
    if (
      !receipt ||
      typeof receipt !== "object" ||
      ("outcome" in receipt && receipt.outcome !== "done") ||
      !("checks" in receipt) ||
      !Array.isArray(receipt.checks) ||
      receipt.checks.length === 0 ||
      receipt.checks.some((check) => !check || check.ok !== true)
    ) {
      reasons.push(`${key}(no successful completion receipt)`);
      continue;
    }
    if (sample) {
      const checks = await checkDone(lane.done, deps.run, {
        cwd: lane.cwd ?? deps.config.defaultCwd,
        ...deps.signalIo,
      });
      if (checks.some((check) => !check.ok)) reasons.push(`${key}(Done no longer live)`);
    }
  }
  if (sample && reasons.length === 0) reasons.push(...canLaunch(await sample(), deps.config.guard).reasons);
  if (Date.parse(entry.expiresAt) <= deps.clock.now())
    reasons.push("expired; cancel and requeue after reviewing the brief");
  return reasons;
};

export const enqueueLaunch = async (
  deps: FlowDeps,
  input: LaunchInput,
  after: readonly string[],
  expiresHours = 24,
): Promise<QueueEntry> => {
  new LaunchQueue(deps.config.stateDir).path(input.key);
  if (!after.length || after.some((key) => !LANE_KEY.test(key) || key === input.key))
    throw new QueueError("--after needs distinct predecessor lane keys, excluding this key");
  const expiresAt = new Date(deps.clock.now() + expiresHours * 3_600_000);
  if (!Number.isFinite(expiresHours) || expiresHours <= 0 || !Number.isFinite(expiresAt.getTime()))
    throw new QueueError("--expires-hours must be positive and produce a valid expiry date");
  const graph = await withLaunchLock(deps, ".queue-graph", () =>
    withLaunchLock(deps, input.key, async () => {
      const queue = new LaunchQueue(deps.config.stateDir);
      const prior = queue.read(input.key);
      if (prior && prior.status !== "cancelled") throw new QueueError(`queue ${input.key} already exists`);
      const reaches = (key: string, visited = new Set<string>()): boolean => {
        if (key === input.key) return true;
        if (visited.has(key)) return false;
        visited.add(key);
        return queue.read(key)?.after.some((parent) => reaches(parent, visited)) ?? false;
      };
      for (const key of after) {
        if (!(await deps.registry.read(key)) && !queue.read(key))
          throw new QueueError(`unknown predecessor lane: ${key}`);
        if (reaches(key)) throw new QueueError(`queue dependency cycle through ${key}`);
      }
      const prepared = await prepareLaunch(deps, input);
      const { template: _template, variables: _variables, ...plain } = input;
      const entry: QueueEntry = {
        id: randomUUID(),
        input: plain,
        briefText: originalBrief(prepared.preamble),
        after: [...new Set(after)],
        queuedAt: iso(deps.clock),
        expiresAt: expiresAt.toISOString(),
        status: "pending",
      };
      queue.write(entry);
      return entry;
    }),
  );
  if (!graph.ok) throw new QueueError(`queue graph held: ${graph.holder}`);
  const held = graph.value;
  if (!held.ok) throw new QueueError(`queue ${input.key} held: ${held.holder}`);
  return held.value;
};

export const startQueued = async (
  deps: FlowDeps,
  key: string,
  sample = sampler(deps),
): Promise<{ code: number; lines: string[] }> => {
  new LaunchQueue(deps.config.stateDir).path(key);
  const held = await withLaunchLock(deps, key, async () => {
    const queue = new LaunchQueue(deps.config.stateDir);
    const entry = queue.read(key);
    if (!entry || entry.status !== "pending")
      throw new QueueError(`queue ${key} is ${entry?.status ?? "absent"}; no launch retried`);
    if (await deps.registry.read(key))
      throw new QueueError(`lane ${key} is already registered; inspect the queue receipt`);
    const reasons = await blockedBy(deps, entry, sample);
    if (reasons.length) return { code: 4, lines: [`QUEUE_HELD ${key} ${reasons.join(" | ")}`] };
    // Durable intent precedes terminal creation. A crash cannot silently launch the job twice.
    const starting: QueueEntry = { ...entry, status: "starting" };
    queue.write(starting);
    const dir = join(deps.config.stateDir, "queued-briefs");
    mkdirSync(dir, { recursive: true });
    const brief = join(dir, `${entry.id}.md`);
    writeFileSync(brief, entry.briefText, { flag: "wx", mode: 0o600 });
    const launched = await launchLane(deps, { ...entry.input, brief, queueId: entry.id }, true);
    queue.write({ ...starting, status: "started" });
    return {
      code: /^STARTUP_(OK|DONE)/.test(launched.startup) ? 0 : 3,
      lines: [...launched.warnings, `QUEUE_STARTED ${key} pane=${launched.lane.pane}`, launched.startup],
    };
  });
  if (!held.ok) throw new QueueError(`queue ${key} held: ${held.holder}`);
  return held.value;
};

export const cancelQueued = async (deps: FlowDeps, key: string): Promise<string> => {
  new LaunchQueue(deps.config.stateDir).path(key);
  const held = await withLaunchLock(deps, key, async () => {
    const queue = new LaunchQueue(deps.config.stateDir);
    const entry = queue.read(key);
    if (!entry) throw new QueueError(`queue ${key} is absent`);
    if (entry.status === "started" || (await deps.registry.read(key)))
      throw new QueueError(`lane ${key} is registered; cancelling a queue never stops an agent`);
    queue.write({ ...entry, status: "cancelled" });
    return `QUEUE_CANCELLED ${key}; no pane or worktree removed`;
  });
  if (!held.ok) throw new QueueError(`queue ${key} held: ${held.holder}`);
  return held.value;
};

/** Notification only. Even a ready entry requires the operator's explicit queue start. */
export const queueTick = async (deps: FlowDeps): Promise<string[]> => {
  const queue = new LaunchQueue(deps.config.stateDir);
  const scan = queue.scan();
  const lines = scan.problems.map((problem) => `LANE_QUEUE_WARN ${problem}`);
  for (const listed of scan.entries.filter((entry) => entry.status === "pending")) {
    const held = await withLaunchLock(deps, listed.input.key, async () => {
      const entry = queue.read(listed.input.key);
      if (!entry || entry.status !== "pending") return;
      const reasons = await blockedBy(deps, entry);
      const notice = reasons.length
        ? `LANE_QUEUE_HELD ${entry.input.key} ${reasons.join(" | ")}`
        : `LANE_QUEUE_READY ${entry.input.key}; live checks run on explicit dori queue start ${entry.input.key}`;
      if (notice === entry.lastNotice) return;
      queue.write({ ...entry, lastNotice: notice });
      lines.push(notice);
    });
    if (!held.ok) lines.push(`LANE_QUEUE_HELD ${listed.input.key} lock: ${held.holder}`);
  }
  return lines;
};
