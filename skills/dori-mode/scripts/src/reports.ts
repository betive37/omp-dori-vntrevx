import { appendFileSync, chmodSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { generation, type Lane, LANE_KEY, Registry, sessionOf } from "./registry.ts";
import { sameSession } from "../../../../src/refs.ts";
import { readWait, renderWait, type Wait, waitKey } from "../../../../src/wait.ts";

export type ReportKind = "milestone" | "blocker" | "question" | "halted" | "done";
export type ProgressState = "running" | "blocked" | "halted" | "done" | "stalled";
export type Report = {
  readonly type: "report";
  readonly key: string;
  readonly at: string;
  readonly kind: ReportKind;
  readonly text: string;
  readonly wait?: Wait;
};
export type Activity = {
  readonly type: "activity";
  readonly key: string;
  readonly at: string;
  readonly state: "running" | "stalled";
  readonly text: string;
};
export type LaneEvent = Report | Activity;
export type Progress = {
  readonly state: ProgressState;
  readonly lastReport: Report | null;
  readonly lastEvent: LaneEvent;
};

type WaitProof = {
  readonly wait: Wait;
  readonly lane: Lane;
  readonly report: Report | null | undefined;
};

export class ReportError extends Error {}

export const isReportKind = (value: unknown): value is ReportKind =>
  value === "milestone" || value === "blocker" || value === "question" || value === "halted" || value === "done";

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
    // biome-ignore lint/suspicious/noControlCharactersInRegex: the pattern deliberately matches control characters to reject or strip them
    .replace(/[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/g, "")}`;

export const parseEvent = (line: string, key: string): LaneEvent => {
  const value: unknown = JSON.parse(line);
  if (
    typeof value !== "object" ||
    value === null ||
    !("key" in value) ||
    value.key !== key ||
    !("at" in value) ||
    typeof value.at !== "string" ||
    !Number.isFinite(Date.parse(value.at)) ||
    !("text" in value) ||
    typeof value.text !== "string" ||
    !value.text.trim() ||
    !("type" in value)
  ) {
    throw new ReportError(`invalid report record for ${key}`);
  }
  const common = { key, at: value.at, text: value.text };
  if (value.type === "report" && "kind" in value && isReportKind(value.kind)) {
    const wait = value.kind === "blocker" && "wait" in value ? readWait(value.wait) : undefined;
    return { ...common, type: "report", kind: value.kind, ...(wait ? { wait } : {}) };
  }
  if (value.type === "activity" && "state" in value && (value.state === "running" || value.state === "stalled")) {
    return { ...common, type: "activity", state: value.state };
  }
  throw new ReportError(`invalid report kind or activity state for ${key}`);
};

// Reports share the lane registry's writer lock; observation checks and their append are one synchronous section.
// Activity events use one O_APPEND write and cannot supersede a blocked, halted or done report in read().
export class Reports {
  constructor(readonly stateDir: string) {}

  path(key: string): string {
    if (!LANE_KEY.test(key)) throw new ReportError(`invalid lane key: ${key}`);
    return join(this.stateDir, "lanes", key, "reports.jsonl");
  }

  read(key: string): Progress | null {
    const path = this.path(key);
    if (!existsSync(path)) return null;
    let progress: Progress | null = null;
    let lastReport: Report | null = null;
    for (const [index, line] of readFileSync(path, "utf8").split("\n").entries()) {
      if (!line.trim()) continue;
      let event: LaneEvent;
      try {
        event = parseEvent(line, key);
      } catch (error) {
        if (!(error instanceof SyntaxError || error instanceof ReportError)) throw error;
        throw new ReportError(`${path}:${index + 1}: ${error.message}`);
      }
      if (event.type === "report") {
        lastReport = event;
        progress = { state: reportState(event.kind), lastReport: event, lastEvent: event };
      } else if (!progress || progress.state === "running" || progress.state === "stalled") {
        progress = { state: event.state, lastReport, lastEvent: event };
      }
    }
    return progress;
  }

  private writeEvent(event: LaneEvent): void {
    const path = this.path(event.key);
    parseEvent(JSON.stringify(event), event.key);
    const dir = join(this.stateDir, "lanes", event.key);
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    // mkdir's mode applies only on creation; a directory made earlier with wider permissions is narrowed here.
    chmodSync(dir, 0o700);
    appendFileSync(path, `${JSON.stringify(event)}\n`, { encoding: "utf8", mode: 0o600 });
  }

  append(event: Activity): void {
    this.writeEvent(event);
  }

  report(key: string, kind: ReportKind, text: string, now: number, waiting?: WaitProof): Promise<Report>;
  report(
    key: string,
    kind: ReportKind,
    text: string,
    now: number,
    waiting: WaitProof | undefined,
    shouldReport: (progress: Progress | null) => boolean,
  ): Promise<Report | null>;
  async report(
    key: string,
    kind: ReportKind,
    text: string,
    now: number,
    waiting?: WaitProof,
    shouldReport?: (progress: Progress | null) => boolean,
  ): Promise<Report | null> {
    if (waiting && kind !== "blocker") throw new ReportError("a structured wait needs a blocker report");
    const report: Report = {
      type: "report",
      key,
      kind,
      text: text.trim(),
      at: new Date(now).toISOString(),
      ...(waiting ? { wait: waiting.wait } : {}),
    };
    this.path(key);
    parseEvent(JSON.stringify(report), key);
    let appended = false;
    await new Registry(this.stateDir).update(key, (current) => {
      if (waiting) {
        if (!current || current.key !== waiting.lane.key || generation(current) !== generation(waiting.lane))
          throw new ReportError("lane state changed while observing its wait; report again");
        const ref = sessionOf(waiting.lane);
        const liveRef = sessionOf(current);
        if (ref ? !liveRef || !sameSession(ref, liveRef) : liveRef !== undefined)
          throw new ReportError("lane session changed while observing its wait; report again");
        const latest = this.read(key)?.lastReport;
        if (
          JSON.stringify(latest) !== JSON.stringify(waiting.report) ||
          current.lastWaitNotice !== waiting.lane.lastWaitNotice
        )
          throw new ReportError("a newer report or wait observation arrived; report again");
        const wait = waiting.wait;
        if (current.lastWaitNotice === `ended|${current.openedAt}|${waitKey(wait.target)}|${wait.startedAt}`)
          throw new ReportError("this wait has already ended; report a currently pending identity");
      }
      if (shouldReport && !shouldReport(this.read(key))) return null;
      this.writeEvent(report);
      appended = true;
      return null; // The journal changes, not the registry record; no second write can leave a partial transition.
    });
    return appended ? report : null;
  }

  observe(key: string, screen: string, now: number, staleAfterMs: number, resumeOnWorking = true): Progress | null {
    const progress = this.read(key);
    if (!progress || (progress.state !== "running" && progress.state !== "stalled")) return progress;
    const visible = Bun.stripANSI(screen);
    const lastAt = (pattern: RegExp): number => {
      let at = -1;
      for (const match of visible.matchAll(pattern)) at = match.index;
      return at;
    };
    const workingAt = lastAt(/^\s*[^\w\n]*(?:Working|Running)\b/gim);
    const working = workingAt >= 0;
    // A failure counts only when no Working line follows it: an old error left on screen above a recovered lane is history.
    const failed =
      lastAt(
        /compaction (?:failed|failure|error)|failed to compact|error (?:during|in) compaction|auto-?compaction failed/gi,
      ) > workingAt;
    const idle = /^\s*[❯>]\s*$/m.test(visible);
    const stale = now - Date.parse(progress.lastReport?.at ?? progress.lastEvent.at) >= staleAfterMs;
    const state =
      failed || (idle && !working && stale) ? "stalled" : working && resumeOnWorking ? "running" : progress.state;
    if (state === progress.state) return progress;
    const event: Activity = {
      type: "activity",
      key,
      at: new Date(now).toISOString(),
      state,
      text: failed
        ? "compaction failed"
        : state === "stalled"
          ? "idle prompt without Working or a fresh report"
          : "Working activity resumed",
    };
    this.append(event);
    return this.read(key);
  }
}
