import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { Checkpoints } from "./checkpoints.ts";
import { statusOf } from "./registry.ts";
import { Reports } from "./reports.ts";
import { SupervisionCost } from "./supervision-cost.ts";
import {
  absorbIncidental,
  confirmDeclared,
  discoverSupervisionFiles,
  observationText,
  prepareWindow,
  writeObservation,
} from "./supervision-evidence-state.ts";
import {
  currentSupervisionLane,
  type SupervisedLane,
  type SupervisionDeps,
  type SupervisionOptions,
  type SupervisionResult,
  type UsageSnapshot,
  timerFromScreen,
  withCurrentSupervision,
  withSupervisionWriter,
} from "./supervision-observe.ts";
import { judgeSweep, recheckQuiet, supervisionTag } from "./supervision-verdict.ts";

export type { SupervisionDeps, SupervisionResult } from "./supervision-observe.ts";

const NOT_OBSERVED: SupervisionResult = {
  enabled: false,
  state: null,
  alerts: [],
  alertEvents: [],
  usage: null,
  hung: false,
  heldHung: false,
  coverageComplete: false,
  lastReportAt: null,
  lastEvidenceAt: null,
};
const BUSY: SupervisionResult = { ...NOT_OBSERVED, busy: true };

export class Supervision {
  readonly reports: Reports;
  readonly checkpoints: Checkpoints;
  private readonly cost: SupervisionCost;
  constructor(
    readonly deps: SupervisionDeps,
    readonly options: SupervisionOptions = {},
  ) {
    this.reports = deps.reports ?? new Reports(deps.stateDir);
    this.checkpoints = new Checkpoints(deps.stateDir);
    this.cost = new SupervisionCost({ ...deps, reports: this.reports }, options);
  }

  private enabled(lane: SupervisedLane): boolean {
    return lane.reportProtocol === "jsonl-v1" || existsSync(this.reports.path(lane.key));
  }

  // A null screen has no trusted activity timer; usage and budget observations remain independent.
  async sweep(lane: SupervisedLane, screen: string | null, nativeActiveSince?: number): Promise<SupervisionResult> {
    if (!this.enabled(lane) || statusOf(lane) !== "working" || lane.nativeCloseIntent) return NOT_OBSERVED;
    const now = this.deps.clock.now();
    const path = join(dirname(this.reports.path(lane.key)), "supervision.json");
    const observe = () => this.observe(lane, screen, nativeActiveSince, now, path);
    return (await withSupervisionWriter(this.deps.stateDir, lane, now, observe)) ?? BUSY;
  }

  private async observe(
    lane: SupervisedLane,
    screen: string | null,
    nativeActiveSince: number | undefined,
    now: number,
    path: string,
  ): Promise<SupervisionResult> {
    const { deps } = this;
    const discover = () => discoverSupervisionFiles(deps.run, this.options, deps.stateDir, lane);
    const discovery = screen === null ? null : await discover();
    const prepared = await withCurrentSupervision(deps, lane, () => {
      const tag = supervisionTag(this.reports, lane);
      return { ...prepareWindow(path, lane, tag, discovery), tag };
    });
    if (!prepared) return NOT_OBSERVED;
    const sampled = discovery !== null && !("error" in discovery);
    const timer = timerFromScreen(screen, now, nativeActiveSince);
    const read = { lane, now, timer, sampled, previous: prepared.previous, ...prepared.observe() };
    const judging = {
      reports: this.reports,
      checkpoints: this.checkpoints,
      options: this.options,
      clock: deps.clock,
      registry: deps.registry,
    };
    // An arbitrary hook may touch incidental Git files. The original sample judges those paths; explicit watches must
    // still hold after the hook for a new stall. Where no hook can write, confirm the whole window at the later point.
    const beforeUsage = this.options.usageArgv?.length ? recheckQuiet(judging, read, prepared.tag) : undefined;
    const usage = await this.cost.usage(lane, now);
    let recheck = this.options.usageArgv?.length ? beforeUsage : recheckQuiet(judging, read, prepared.tag);
    if (recheck && this.options.usageArgv?.length && discovery && !("error" in discovery))
      recheck = confirmDeclared(read.files, discovery.declared);
    const committed = await withCurrentSupervision(deps, lane, async () => {
      if (observationText(path) !== prepared.basis) return;
      if (JSON.stringify(supervisionTag(this.reports, lane)) !== JSON.stringify(prepared.tag)) return;
      const verdict = await judgeSweep(judging, read, usage, prepared.tag, recheck);
      if (!verdict) return;
      if (this.options.usage === "omp" || this.options.usageArgv?.length) this.cost.record(usage);
      const undelivered = new Map<string, string>();
      for (const { detail } of verdict.freshAlerts) {
        try {
          await deps.alert?.(lane, detail);
        } catch (error) {
          undelivered.set(detail, error instanceof Error ? error.message : String(error));
        }
      }
      if (deps.registry && !currentSupervisionLane(lane, await deps.registry.read(lane.key))) return;
      if (
        observationText(path) !== prepared.basis ||
        JSON.stringify(supervisionTag(this.reports, lane)) !== JSON.stringify(prepared.tag)
      )
        return;
      const { result, observation } = await verdict.settle(undelivered);
      // Commit decisions and delivered receipts before advisory post-effect I/O.
      const basis =
        sampled ||
        Boolean(prepared.previous?.coverage?.pending.length) ||
        JSON.stringify(observation.alerts) !== JSON.stringify(prepared.previous?.alerts ?? [])
          ? writeObservation(path, observation)
          : prepared.basis;
      const deliveryError = undelivered.size
        ? `alert delivery failed for ${lane.key}: ${[...undelivered].map(([message, why]) => `${message} (${why})`).join("; ")}`
        : undefined;
      return { result, observation, basis, deliveryError, delivered: verdict.freshAlerts.length > 0 };
    });
    if (!committed) return NOT_OBSERVED;
    const { result, observation, basis, deliveryError, delivered } = committed;
    let advisoryError: string | undefined;
    if (discovery && !("error" in discovery) && (this.options.usageArgv?.length || delivered)) {
      try {
        const after = await discover();
        if ("error" in after) throw new Error(after.error);
        const refreshed = absorbIncidental(observation, discovery, after, prepared.remaining);
        await withCurrentSupervision(deps, lane, () => {
          if (
            refreshed !== observation &&
            observationText(path) === basis &&
            JSON.stringify(supervisionTag(this.reports, lane)) === JSON.stringify(prepared.tag)
          )
            writeObservation(path, refreshed);
        });
      } catch (error) {
        advisoryError = `post-effect activity sample failed: ${error instanceof Error ? error.message : String(error)}`;
      }
    }
    const observationError = [deliveryError, result.evidenceError, advisoryError].filter(Boolean).join("; ");
    if (sampled && deliveryError) throw new Error(observationError);
    return observationError ? { ...result, observationError } : result;
  }

  async close(lane: SupervisedLane): Promise<UsageSnapshot | null> {
    return this.enabled(lane) ? this.cost.close(lane) : null;
  }
}
