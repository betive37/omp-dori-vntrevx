import type { Checkpoints } from "./checkpoints.ts";
import { confirmMarks, type WindowRead } from "./evidence-window.ts";
import { type Evidenced, type EvidenceRef, novelEvidence } from "./evidence.ts";
import { runContext } from "./lane-run.ts";
import { ReportError } from "./report-events.ts";
import { type Activity, type Progress, type Reports, reportScope } from "./reports.ts";
import { type ReportProvenance, provenanceIdentity } from "./request-identity.ts";
import { type Observation, selectedEvidence } from "./supervision-evidence-state.ts";
import {
  currentSupervisionLane,
  isHungTimer,
  observeBudget,
  type SupervisedLane,
  type SupervisionAlert,
  type SupervisionDeps,
  type SupervisionOptions,
  type SupervisionResult,
  type UsageSnapshot,
  type WorkingTimer,
} from "./supervision-observe.ts";

type VerdictDeps = Pick<SupervisionDeps, "clock" | "registry"> & {
  readonly reports: Reports;
  readonly checkpoints: Checkpoints;
  readonly options: SupervisionOptions;
};
export type SweepRead = WindowRead & {
  readonly lane: SupervisedLane;
  readonly now: number;
  readonly timer: WorkingTimer | null;
  readonly previous: Observation | null;
  readonly sampled: boolean;
};

const HUNG = "Working/Running timer exceeded threshold without fresh report, checkpoint, or file activity";
const RECOVERED = "Fresh evidence observed (selected or changed file bytes)";
type Tag = Pick<Activity, "generation" | "provenance">;

export const supervisionTag = (reports: Reports, lane: SupervisedLane): Tag => {
  const context = runContext(reports, lane, lane.runId);
  if (!context || context.generation !== reportScope(lane).generation)
    throw new ReportError(`supervision: execution identity unavailable for ${lane.key}`);
  const { generation, provenance } = context;
  return { ...(generation === undefined ? {} : { generation }), ...(provenance ? { provenance } : {}) };
};

const sameTag = (a: Tag, b: Tag): boolean =>
  a.generation === b.generation &&
  JSON.stringify(a.provenance && provenanceIdentity(a.provenance)) ===
    JSON.stringify(b.provenance && provenanceIdentity(b.provenance));

type Journal = {
  readonly progress: Progress | null;
  readonly records: readonly Evidenced[];
  readonly evidence: { readonly signature: string; readonly lastEvidenceAt: string | null };
};

const journals = (deps: VerdictDeps, lane: SupervisedLane, tag: Tag, includeCheckpoints = true): Journal => {
  const scope = reportScope(lane);
  const progress = deps.reports.read(lane.key, scope);
  const nativeAgrees = (provenance: ReportProvenance | undefined) =>
    !provenance?.nativeRef ||
    JSON.stringify(provenanceIdentity(provenance)) ===
      JSON.stringify(tag.provenance && provenanceIdentity(tag.provenance));
  // Checkpoints do not encode lifecycleEpoch. Unscoped entries can only be fenced by openedAt.
  const checkpoints = includeCheckpoints
    ? deps.checkpoints
        .read(lane.key)
        .filter(
          (entry) =>
            entry.provenance?.requestId === scope.requestId &&
            entry.provenance?.runId === scope.runId &&
            nativeAgrees(entry.provenance) &&
            Date.parse(entry.at) >= Date.parse(lane.openedAt),
        )
    : [];
  const records = [...(progress?.evidenced.filter((event) => nativeAgrees(event.provenance)) ?? []), ...checkpoints];
  return { progress, records, evidence: selectedEvidence(records) };
};

const observedRefs = ({ previous, observed }: SweepRead): readonly EvidenceRef[] =>
  observed.filter(({ ref, fingerprint }) => previous?.incidental?.[ref] !== fingerprint);

const assess = (deps: VerdictDeps, read: SweepRead, journal: Journal, novel: boolean) => {
  const { previous, timer, now, sampled } = read;
  const advanced = sampled && previous?.files !== undefined && journal.evidence.signature !== previous.activity;
  const coverage = read.coverage && { ...read.coverage, changed: read.coverage.changed || novel || advanced };
  const complete =
    sampled && coverage !== undefined && !coverage.pending.length && !coverage.deferred.length && !read.evidenceError;
  const activeAt = advanced ? deps.clock.now() : previous?.activity == null ? now : previous.activeAt;
  const quiet =
    complete &&
    coverage?.changed === false &&
    previous?.activity != null &&
    isHungTimer(deps.options, previous, timer, now, activeAt);
  return { advanced, activeAt, coverage, complete, quiet };
};

export const recheckQuiet = (deps: VerdictDeps, read: SweepRead, tag: Tag): boolean | undefined => {
  if (!read.sampled || read.previous?.hung === true) return;
  const journal = journals(deps, read.lane, tag);
  if (assess(deps, read, journal, novelEvidence(journal.records, observedRefs(read)).length > 0).quiet)
    return confirmMarks(read.files).quiet;
};

/** Called with the delivery lock. Only the synchronous scoped evidence acceptance takes the registry writer lock. */
export const judgeSweep = async (
  deps: VerdictDeps,
  read: SweepRead,
  usage: UsageSnapshot,
  tag: Tag,
  recheck: boolean | undefined,
) => {
  const { lane, previous, now, sampled } = read;
  let journal = journals(deps, lane, tag, sampled);
  const refs = observedRefs(read);
  const novel = novelEvidence(journal.records, refs).length > 0;
  let evidenceUncommitted = novel && deps.registry === undefined;
  const activity = (state: Activity["state"], text: string): Activity => ({
    type: "activity",
    key: lane.key,
    ...tag,
    at: new Date(deps.clock.now()).toISOString(),
    state,
    text,
  });
  if (novel && deps.registry !== undefined) {
    const accepted = await deps.registry.withCurrent(lane.key, (current) => {
      if (!currentSupervisionLane(lane, current) || !sameTag(tag, supervisionTag(deps.reports, current))) return false;
      const journal = journals(deps, current, tag);
      const evidence = novelEvidence(journal.records, refs);
      if (evidence.length) {
        deps.reports.appendEvidenceLocked(
          activity(journal.progress?.state === "stalled" ? "stalled" : "running", "Observed filesystem evidence"),
          evidence,
        );
      }
      return true;
    });
    if (!accepted) return;
    journal = journals(deps, lane, tag);
  }
  const initialEvidence = journal.evidence;
  const assessed = assess(deps, read, journal, novel);
  const { coverage, complete } = assessed;
  let { advanced, activeAt } = assessed;
  const { violations, unavailable } = observeBudget(deps.options, lane, now, usage);
  const previousHung = previous?.hung ?? previous?.alerts.includes(HUNG) ?? false;
  const provedHung = journal.progress?.state !== "blocked" && assessed.quiet && recheck === true;
  let heldHung = provedHung || (!advanced && previousHung);
  const terminal = () => journal.progress?.state === "done" || journal.progress?.state === "halted";
  const alerts = (): SupervisionAlert[] => {
    if (terminal()) return [];
    const available: SupervisionAlert[] = violations.map((detail) => ({ kind: "blocked", detail }));
    // Retain the receipt even when a ceiling takes precedence during an incomplete observation.
    if (heldHung && ((!violations.length && journal.progress?.state !== "blocked") || (!sampled && previousHung)))
      available.push({ kind: "stalled", detail: HUNG });
    for (const detail of unavailable) available.push({ kind: "warning", detail });
    return available;
  };
  const reconcile = () => {
    const { progress } = journal;
    if (terminal()) {
      heldHung = false;
      return;
    }
    if (violations.length) {
      const blocker = violations.join("; ");
      if (progress?.lastReport?.kind !== "blocker" || progress.lastReport.text !== blocker)
        deps.reports.report(lane.key, "blocker", blocker, deps.clock.now(), tag.generation, undefined, tag.provenance);
    } else if (progress?.state === "blocked") heldHung = false;
    else if (heldHung && (!progress || progress.state === "running")) deps.reports.append(activity("stalled", HUNG));
    else if (sampled && advanced && progress?.state === "stalled") deps.reports.append(activity("running", RECOVERED));
    journal = journals(deps, lane, tag, sampled);
    if (journal.progress?.state === "blocked" && (sampled || !previousHung)) heldHung = false;
  };
  const locked = async <T>(action: () => T): Promise<T> =>
    deps.registry ? deps.registry.withCurrent(lane.key, action) : action();
  const freshAlerts = await locked(() => {
    journal = journals(deps, lane, tag, sampled);
    const fresh = alerts().filter(
      ({ kind, detail }) =>
        !previous?.alerts.includes(detail) && (kind !== "stalled" || journal.progress?.state !== "blocked"),
    );
    reconcile();
    return fresh;
  });
  const settle = async (undelivered: ReadonlyMap<string, string>) =>
    locked(() => {
      journal = journals(deps, lane, tag, sampled);
      if (sampled && journal.evidence.signature !== initialEvidence.signature) {
        advanced = true;
        activeAt = deps.clock.now();
        heldHung = false;
      }
      reconcile();
      evidenceUncommitted &&= novelEvidence(journal.records, refs).length > 0;
      const lastReportAt = journal.progress?.lastReport?.at ?? null;
      const lastEvidenceAt = journal.evidence.lastEvidenceAt;
      const evidenceError = read.evidenceError ?? (!sampled ? previous?.evidenceError : undefined);
      const uncertainty = evidenceError === undefined ? {} : { evidenceError };
      const timer = sampled
        ? { at: now, timer: read.timer?.seconds ?? null, timerKind: read.timer?.kind ?? null }
        : { at: previous?.at ?? now, timer: previous?.timer ?? null, timerKind: previous?.timerKind ?? null };
      const incidental = { ...previous?.incidental };
      for (const { ref, fingerprint } of read.observed) if (incidental[ref] !== fingerprint) delete incidental[ref];
      const alertsSent = alerts()
        .filter(({ detail }) => !undelivered.has(detail))
        .map(({ detail }) => detail);
      const observation: Observation =
        !sampled && previous
          ? {
              ...previous,
              ...(coverage === undefined ? {} : { coverage }),
              ...uncertainty,
              alerts: alertsSent,
            }
          : {
              openedAt: lane.openedAt,
              ...tag,
              ...timer,
              activity: sampled ? journal.evidence.signature : null,
              ...(sampled ? { files: read.files } : {}),
              ...(coverage === undefined ? {} : { coverage: { ...coverage, changed: coverage.changed || advanced } }),
              ...(Object.keys(incidental).length ? { incidental } : {}),
              activeAt,
              hung: heldHung,
              lastReportAt,
              lastEvidenceAt,
              ...uncertainty,
              alerts: alertsSent,
            };
      const result: SupervisionResult = {
        enabled: true,
        state: journal.progress?.state ?? "running",
        alerts: freshAlerts.map(({ detail }) => detail),
        alertEvents: freshAlerts,
        usage,
        hung: provedHung && heldHung,
        heldHung: heldHung && journal.progress?.state === "stalled",
        coverageComplete: complete && !evidenceUncommitted,
        lastReportAt,
        lastEvidenceAt,
        ...uncertainty,
        ...(!sampled || evidenceError !== undefined || evidenceUncommitted ? { observationIncomplete: true } : {}),
      };
      return { observation, result };
    });
  return { freshAlerts, settle };
};
