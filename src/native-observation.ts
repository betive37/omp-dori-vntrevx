/**
 * What the omp-cataly extension last observed of its own OMP session's native state, carried in the pane record
 * (`native`) and handed on by a probe only once the record's writer is attested (runtime/omp.ts).
 *
 * `observedAt`: when `jobs` was read from the main session's async job snapshot (ms since the epoch); the record
 * on disk always holds the snapshot read at that time. `jobs`: that snapshot's running and recent jobs, or null when
 * the session had no snapshot to read (no job manager, or not read yet in this session); null is "not observable",
 * never "nothing running". A job missing from `running` is not running as of `observedAt`; it says nothing about how
 * it ended unless `recent` lists it. `approvals`: the tool approvals open in the process when the record was written,
 * each with the session its event named.
 */
export type NativeJobStatus = "running" | "completed" | "failed" | "cancelled";
export type NativeRunningJob = { readonly id: string; readonly startTime: number };
export type NativeRecentJob = {
  readonly id: string;
  readonly startTime: number;
  readonly status: NativeJobStatus;
  readonly endTime?: number;
};
export type NativeJobs = { readonly running: readonly NativeRunningJob[]; readonly recent: readonly NativeRecentJob[] };
export type NativeApproval = { readonly sessionId: string; readonly toolCallId: string; readonly toolName: string };
export type NativeObservation = {
  readonly observedAt: number;
  readonly jobs: NativeJobs | null;
  readonly approvals: readonly NativeApproval[];
};
/** A probe's observation: the attested pane record's session and its start, as the record states them. */
export type ProbedNativeObservation = NativeObservation & {
  readonly sessionId: string;
  readonly sessionStartedAt: string;
};

const STATUSES: Readonly<Record<string, NativeJobStatus>> = {
  running: "running",
  completed: "completed",
  failed: "failed",
  cancelled: "cancelled",
};

const record = (value: unknown): Record<string, unknown> | undefined =>
  typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;
const name = (value: unknown): value is string => typeof value === "string" && value !== "";
const time = (value: unknown): value is number =>
  typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 8.64e15;

/** Every element of `value` read by `read`, or undefined when it is not an array or any element is malformed. */
function each<T>(value: unknown, read: (row: Record<string, unknown>) => T | undefined): T[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const out: T[] = [];
  for (const item of value) {
    const row = record(item);
    const parsed = row && read(row);
    if (parsed === undefined) return undefined;
    out.push(parsed);
  }
  return out;
}

const runningJob = (row: Record<string, unknown>): NativeRunningJob | undefined =>
  name(row["id"]) && time(row["startTime"]) ? { id: row["id"], startTime: row["startTime"] } : undefined;

const recentJob = (row: Record<string, unknown>): NativeRecentJob | undefined => {
  const status =
    typeof row["status"] === "string" && Object.hasOwn(STATUSES, row["status"]) ? STATUSES[row["status"]] : undefined;
  const end = row["endTime"];
  if (!name(row["id"]) || !time(row["startTime"]) || status === undefined) return undefined;
  const job = { id: row["id"], startTime: row["startTime"], status };
  if (end === undefined) return job;
  return time(end) ? { ...job, endTime: end } : undefined;
};

const approval = (row: Record<string, unknown>): NativeApproval | undefined =>
  name(row["sessionId"]) && name(row["toolCallId"]) && typeof row["toolName"] === "string"
    ? { sessionId: row["sessionId"], toolCallId: row["toolCallId"], toolName: row["toolName"] }
    : undefined;

/**
 * A pane record's `native` field as a well-formed observation, copied field by field; undefined when it is absent or
 * any part of it is malformed. The observation is dropped whole: a partial one could hide a running job or an open
 * approval. The rest of the pane record is judged without it.
 */
export function readNativeObservation(value: unknown): NativeObservation | undefined {
  const native = record(value);
  if (native === undefined || !Number.isSafeInteger(native["observedAt"]) || !time(native["observedAt"]))
    return undefined;
  const approvals = each(native["approvals"], approval);
  if (approvals === undefined) return undefined;
  if (native["jobs"] === null) return { observedAt: native["observedAt"], jobs: null, approvals };
  const jobs = record(native["jobs"]);
  const running = jobs && each(jobs["running"], runningJob);
  const recent = jobs && each(jobs["recent"], recentJob);
  if (running === undefined || recent === undefined) return undefined;
  return { observedAt: native["observedAt"], jobs: { running, recent }, approvals };
}
