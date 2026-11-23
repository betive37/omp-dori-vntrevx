import { createHash } from "node:crypto";
import { appendFileSync, chmodSync, existsSync, mkdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

import { renderWait, type Wait } from "../../../../src/wait.ts";
import { nextEvidenceSequence } from "./evidence-sequence.ts";
import type { EvidenceRef } from "./evidence.ts";
import { type Lane, LANE_KEY } from "./registry.ts";
import { reportActivity } from "./report-activity.ts";
import { parseEvent, ReportError } from "./report-events.ts";
import { type NativeReference, type ReportProvenance, provenanceIdentity } from "./request-identity.ts";

export type ReportKind = "milestone" | "blocker" | "question" | "halted" | "done";
export type ProgressState = "running" | "blocked" | "halted" | "done" | "stalled";
type EventFields = {
  readonly key: string;
  readonly at: string;
  readonly text: string;
  readonly generation?: string;
  readonly provenance?: ReportProvenance;
  readonly evidenceRefs?: readonly EvidenceRef[];
  readonly evidenceSequence?: number;
};
export type Report = EventFields & {
  readonly type: "report";
  readonly kind: ReportKind;
  readonly owner?: string;
  readonly wait?: Wait;
};
export type Activity = EventFields & {
  readonly type: "activity";
  readonly state: "running" | "stalled";
};
type ProgressEvent = Report | Activity | (EventFields & { readonly type: "reopen" });
export type Execution = Omit<EventFields, "provenance" | "evidenceRefs" | "evidenceSequence"> & {
  readonly type: "execution";
  readonly requestId: string;
  readonly runId: string;
} & ({ readonly phase: "started" } | { readonly phase: "bound"; readonly nativeRef: NativeReference });
export type LaneEvent = ProgressEvent | Execution;
type EventScope = Pick<Lane, "requestId" | "runId"> & { readonly generation: string | undefined };
export const reportScope = (lane: Pick<Lane, "lifecycleEpoch" | "requestId" | "runId">): EventScope => ({
  generation: lane.lifecycleEpoch,
  ...(lane.requestId === undefined ? {} : { requestId: lane.requestId }),
  ...(lane.requestId === undefined || lane.runId === undefined ? {} : { runId: lane.runId }),
});
export type Progress = {
  readonly state: ProgressState;
  readonly lastReport: Report | null;
  readonly lastEvent: ProgressEvent;
  /** Evidence from the exact same scope as this progress view. */
  readonly evidenced: readonly ProgressEvent[];
};

// A question waits on the owner's answer, so it is blocked like a blocker: posted, never nudged.
export const reportState = (kind: ReportKind): ProgressState => {
  switch (kind) {
    case "milestone":
      return "running";
    case "blocker":
      return "blocked";
    case "question":
      return "blocked";
    case "halted":
      return "halted";
    case "done":
      return "done";
  }
};

// The printed line goes to terminals, so escape sequences and other control characters are dropped from it (a CR or
// newline becomes one space); the journal keeps the raw text.
export const reportLine = (report: Report): string =>
  `[REPORT] ${report.key} | ${report.kind} | ${Bun.stripANSI(
    report.wait ? `${report.text} WAIT ${renderWait(report.wait)}` : report.text,
  )
    .replace(/\s*[\r\n]+\s*/g, " ")
    // oxlint-disable-next-line no-control-regex -- the pattern deliberately matches control characters to reject or strip them
    .replace(/[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/g, "")}`;

export const reportId = (report: Report): string =>
  createHash("sha256")
    .update(
      JSON.stringify([
        report.key,
        report.at,
        report.kind,
        report.text,
        report.owner ?? null,
        ...(report.wait ? [report.wait] : []),
        report.generation ?? null,
        ...(report.provenance ? [provenanceIdentity(report.provenance)] : []),
        ...(report.evidenceRefs?.length ? [[report.evidenceSequence, report.evidenceRefs]] : []),
      ]),
    )
    .digest("hex");

type CachedJournal = {
  readonly stamp: string;
  readonly events: readonly LaneEvent[];
  lastRead?: { readonly scopeKey: string; readonly progress: Progress | null };
};

// Reports share the lane registry's writer lock; observation checks and their append are one synchronous section.
// Activity events use one O_APPEND write and cannot supersede a blocked, halted or done report in read().
export class Reports {
  private readonly memo: Map<string, CachedJournal> | undefined;

  // A freshness tick may reuse a parsed journal until any writer changes it. Other readers remain uncached.
  constructor(
    readonly stateDir: string,
    options: { readonly memo?: boolean } = {},
  ) {
    this.memo = options.memo ? new Map() : undefined;
  }

  path(key: string): string {
    if (!LANE_KEY.test(key)) throw new ReportError(`invalid lane key: ${key}`);
    return join(this.stateDir, "lanes", key, "reports.jsonl");
  }

  private journal(key: string): CachedJournal | null {
    const path = this.path(key);
    if (!existsSync(path)) return null;
    // Stamp before reading so an append racing the read invalidates the next lookup.
    const stat = this.memo ? statSync(path, { bigint: true }) : undefined;
    const stamp = stat ? `${stat.ino}:${stat.size}:${stat.mtimeNs}:${stat.ctimeNs}` : "";
    const memo = this.memo?.get(path);
    if (memo?.stamp === stamp) return memo;
    const events: LaneEvent[] = [];
    for (const [index, line] of readFileSync(path, "utf8").split("\n").entries()) {
      if (!line.trim()) continue;
      try {
        events.push(parseEvent(line, key));
      } catch (error) {
        if (!(error instanceof SyntaxError || error instanceof ReportError)) throw error;
        throw new ReportError(`${path}:${index + 1}: ${error.message}`);
      }
    }
    const journal = { stamp, events };
    this.memo?.set(path, journal);
    return journal;
  }

  events(key: string): LaneEvent[] {
    return [...(this.journal(key)?.events ?? [])];
  }

  read(key: string, scope?: EventScope): Progress | null {
    const journal = this.journal(key);
    if (!journal) return null;
    const scopeKey = scope ? JSON.stringify([scope.generation, scope.requestId, scope.runId]) : "raw";
    if (journal.lastRead?.scopeKey === scopeKey) return journal.lastRead.progress;
    let progress: Progress | null = null;
    let lastReport: Report | null = null;
    const evidenced: ProgressEvent[] = [];
    for (const event of journal.events) {
      if (event.type === "execution") continue;
      if (
        scope &&
        (event.generation !== scope.generation ||
          event.provenance?.requestId !== scope.requestId ||
          event.provenance?.runId !== scope.runId)
      )
        continue;
      if (event.evidenceRefs?.length) evidenced.push(event);
      if (event.type === "reopen") {
        lastReport = null;
        progress = { state: "running", lastReport, lastEvent: event, evidenced };
      } else if (event.type === "report") {
        lastReport = event;
        progress = { state: reportState(event.kind), lastReport: event, lastEvent: event, evidenced };
      } else if (!progress || progress.state === "running" || progress.state === "stalled") {
        progress = { state: event.state, lastReport, lastEvent: event, evidenced };
      }
    }
    if (this.memo) journal.lastRead = { scopeKey, progress };
    return progress;
  }
  append<Event extends LaneEvent>(event: Event): Event {
    if ("evidenceRefs" in event || "evidenceSequence" in event)
      throw new ReportError("evidence append must hold the lane writer lock");
    return this.persist(event);
  }
  /** The caller owns Registry.withCurrent for this lane and has rechecked the generation and execution binding. */
  appendEvidenceLocked<Event extends ProgressEvent>(event: Event, refs: readonly EvidenceRef[]): Event {
    if (refs.length === 0) return this.append(event);
    this.path(event.key);
    return this.persist({
      ...event,
      evidenceRefs: refs,
      evidenceSequence: nextEvidenceSequence(this.stateDir, event.key),
    });
  }
  private persist<Event extends LaneEvent>(event: Event): Event {
    const path = this.path(event.key);
    const line = JSON.stringify(event);
    parseEvent(line, event.key);
    const dir = join(this.stateDir, "lanes", event.key);
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    chmodSync(dir, 0o700);
    appendFileSync(path, `${line}\n`, { encoding: "utf8", mode: 0o600 });
    return event;
  }
  report(
    key: string,
    kind: ReportKind,
    text: string,
    now: number,
    generation?: string,
    owner?: string,
    provenance?: ReportProvenance,
    evidenceLocked: readonly EvidenceRef[] = [],
    wait?: Wait,
  ): Report {
    const report: Report = {
      type: "report",
      key,
      kind,
      text: text.trim(),
      at: new Date(now).toISOString(),
      ...(generation === undefined ? {} : { generation }),
      ...(wait === undefined ? {} : { wait }),
      ...(owner === undefined ? {} : { owner: owner.trim() }),
      ...(provenance === undefined ? {} : { provenance }),
    };
    return this.appendEvidenceLocked(report, evidenceLocked);
  }
  observe(
    key: string,
    screen: string,
    now: number,
    staleAfterMs: number,
    resumeOnWorking = true,
    scope?: EventScope,
    nativeStatus?: import("../../../../src/runtime/types.ts").AgentStatus,
  ): Progress | null {
    const progress = this.read(key, scope);
    if (!progress) return null;
    const event = reportActivity(key, progress, screen, now, staleAfterMs, resumeOnWorking, nativeStatus);
    if (!event) return progress;
    this.append(event);
    return this.read(key, scope);
  }
}
