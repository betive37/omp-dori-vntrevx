import { readWait } from "../../../../src/wait.ts";
import { isEvidenceRefs, isEvidenceSequence } from "./evidence.ts";
import type { LaneEvent, ReportKind } from "./reports.ts";
import { isNativeReference, isProvenance, isRequestId, isRunId } from "./request-identity.ts";

export class ReportError extends Error {}

export const isReportKind = (value: unknown): value is ReportKind =>
  value === "milestone" || value === "blocker" || value === "question" || value === "halted" || value === "done";

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
    !("type" in value) ||
    ("generation" in value && typeof value.generation !== "string") ||
    ("provenance" in value && !isProvenance(value.provenance))
  ) {
    throw new ReportError(`invalid report record for ${key}`);
  }
  const common = {
    key,
    at: value.at,
    text: value.text,
    ...("generation" in value && typeof value.generation === "string" ? { generation: value.generation } : {}),
    ...("provenance" in value && isProvenance(value.provenance) ? { provenance: value.provenance } : {}),
  };
  const refs = "evidenceRefs" in value ? value.evidenceRefs : undefined;
  const sequence = "evidenceSequence" in value ? value.evidenceSequence : undefined;
  if (refs !== undefined && !isEvidenceRefs(refs)) throw new ReportError(`invalid report evidenceRefs for ${key}`);
  if (sequence !== undefined && (!isEvidenceSequence(sequence) || !refs?.length))
    throw new ReportError(`invalid report evidenceSequence for ${key}`);
  if (value.type === "execution") {
    if (
      !("requestId" in value) ||
      !isRequestId(value.requestId) ||
      !("runId" in value) ||
      !isRunId(value.runId) ||
      !("phase" in value) ||
      "provenance" in value ||
      "evidenceRefs" in value ||
      "evidenceSequence" in value
    )
      throw new ReportError(`invalid execution record for ${key}`);
    const execution = { ...common, type: "execution" as const, requestId: value.requestId, runId: value.runId };
    if (value.phase === "started" && !("nativeRef" in value)) return { ...execution, phase: "started" };
    if (value.phase === "bound" && "nativeRef" in value && isNativeReference(value.nativeRef))
      return { ...execution, phase: "bound", nativeRef: value.nativeRef };
    throw new ReportError(`invalid execution binding for ${key}`);
  }
  const progress = {
    ...common,
    ...(refs === undefined ? {} : { evidenceRefs: refs }),
    ...(sequence === undefined ? {} : { evidenceSequence: sequence }),
  };
  if (value.type === "reopen") return { ...progress, type: "reopen" };
  if (value.type === "report" && "kind" in value && isReportKind(value.kind)) {
    if ("owner" in value && (typeof value.owner !== "string" || !value.owner.trim()))
      throw new ReportError(`invalid owner summary for ${key}`);
    return {
      ...progress,
      type: "report",
      kind: value.kind,
      ...(value.kind === "blocker" && "wait" in value && readWait(value.wait) ? { wait: readWait(value.wait)! } : {}),
      ...("owner" in value ? { owner: value.owner as string } : {}),
    };
  }
  if (value.type === "activity" && "state" in value && (value.state === "running" || value.state === "stalled")) {
    return { ...progress, type: "activity", state: value.state };
  }
  throw new ReportError(`invalid report kind or activity state for ${key}`);
};
