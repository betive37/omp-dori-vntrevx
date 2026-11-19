import { oneName } from "./fit.ts";
import { Refusal } from "./refusal.ts";
import type { Probe } from "./runtime/types.ts";

export type WaitRequest =
  | { readonly kind: "job" | "approval"; readonly id: string }
  | { readonly kind: "ci"; readonly repo: string; readonly number: number; readonly checkRun?: number }
  | { readonly kind: "label"; readonly text: string };
type Session = { readonly sessionId: string; readonly sessionStartedAt: string };
export type WaitTarget =
  | (Session & { readonly kind: "job"; readonly id: string; readonly jobStartTime: number })
  | (Session & { readonly kind: "approval"; readonly id: string })
  | {
      readonly kind: "ci";
      readonly repo: string;
      readonly number: number;
      readonly head: string;
      readonly checkRun?: number;
    }
  | { readonly kind: "label"; readonly text: string };
const states = [
  "running",
  "pending",
  "completed",
  "failed",
  "cancelled",
  "resolved",
  "not-observed",
  "session-changed",
  "unobservable",
  "unverified",
  "bound",
  "queued",
  "in_progress",
  "waiting",
  "requested",
] as const;
export type Wait = {
  readonly target: WaitTarget;
  readonly startedAt: number;
  readonly observedAt: number;
  readonly lastObservedState: (typeof states)[number];
};

/** Only explicit machine syntax is verified; ordinary dependency prose remains an unverified label. */
export function parseWait(text: string): WaitRequest {
  const normalized = oneName(text).trim();
  const native = /^(job|approval):(\S+)$/.exec(normalized);
  if (native) return { kind: native[1] === "job" ? "job" : "approval", id: native[2]! };
  const ci = /^ci:([\w.-]+\/[\w.-]+)#([1-9]\d*)(?:@([1-9]\d*))?$/.exec(normalized);
  if (ci && Number.isSafeInteger(Number(ci[2])) && (ci[3] === undefined || Number.isSafeInteger(Number(ci[3]))))
    return {
      kind: "ci",
      repo: ci[1]!.toLowerCase(),
      number: Number(ci[2]),
      ...(ci[3] ? { checkRun: Number(ci[3]) } : {}),
    };
  return { kind: "label", text: normalized || "?" };
}

/** A stable tuple, independent of JSON property order and of the latest observation. */
export function waitKey(target: WaitTarget): string {
  switch (target.kind) {
    case "job":
      return JSON.stringify([target.kind, target.sessionId, target.sessionStartedAt, target.id, target.jobStartTime]);
    case "approval":
      return JSON.stringify([target.kind, target.sessionId, target.sessionStartedAt, target.id]);
    case "ci":
      return JSON.stringify([
        target.kind,
        target.repo.toLowerCase(),
        target.number,
        target.head.toLowerCase(),
        target.checkRun ?? null,
      ]);
    case "label":
      return JSON.stringify([target.kind, target.text]);
  }
}

export function recordWait(
  target: WaitTarget,
  state: Wait["lastObservedState"],
  observedAt: number,
  now: number,
  previous?: Wait,
): Wait {
  return {
    target,
    lastObservedState: state,
    observedAt,
    startedAt: previous && waitKey(previous.target) === waitKey(target) ? previous.startedAt : now,
  };
}

/** Bind to an attested observation, not to a typed ID or a scraped terminal line. */
export function bindNativeWait(
  request: Exclude<WaitRequest, { kind: "ci" }>,
  probe: Probe | undefined,
  now: number,
  previous?: Wait,
): Wait {
  if (request.kind === "label") return recordWait(request, "unverified", now, now, previous);
  const native = probe?.native;
  if (!native || probe?.status === "unknown" || probe?.status === "gone")
    throw new Refusal("native wait is unobservable; no attested current-session observation");
  const session = { sessionId: native.sessionId, sessionStartedAt: native.sessionStartedAt };
  let target: WaitTarget;
  if (request.kind === "approval") {
    if (
      !native.approvals.some(
        (approval) => approval.sessionId === native.sessionId && approval.toolCallId === request.id,
      )
    )
      throw new Refusal(`approval:${request.id} is not observed pending in this session`);
    target = { kind: "approval", id: request.id, ...session };
  } else {
    const job = native.jobs?.running.find((item) => item.id === request.id);
    if (!job) throw new Refusal(`job:${request.id} is not observed running in this session`);
    target = { kind: "job", id: job.id, jobStartTime: job.startTime, ...session };
  }
  if (
    previous &&
    waitKey(previous.target) === waitKey(target) &&
    (waitEnded(previous) || native.observedAt < previous.observedAt)
  )
    throw new Refusal("a newer or ended wait observation exists; report again from current native state");
  return recordWait(target, request.kind === "job" ? "running" : "pending", native.observedAt, now, previous);
}

/** Ended means this native wait no longer applies, never that work succeeded or may resume. */
export const waitEnded = (wait: Wait): boolean =>
  (wait.target.kind === "job" || wait.target.kind === "approval") &&
  ["completed", "failed", "cancelled", "resolved", "not-observed", "session-changed"].includes(wait.lastObservedState);

export function observeWait(wait: Wait, probe: Probe): Wait {
  const target = wait.target;
  if (target.kind === "label" || target.kind === "ci" || waitEnded(wait)) return wait;
  const native = probe.native;
  if (!native || probe.status === "unknown" || probe.status === "gone")
    return { ...wait, lastObservedState: "unobservable" };
  if (native.observedAt < wait.observedAt) return wait;
  let state: Wait["lastObservedState"];
  if (native.sessionId !== target.sessionId || native.sessionStartedAt !== target.sessionStartedAt)
    state = "session-changed";
  else if (target.kind === "approval")
    state = native.approvals.some(
      (approval) => approval.sessionId === target.sessionId && approval.toolCallId === target.id,
    )
      ? "pending"
      : "resolved";
  else if (native.jobs === null) state = "unobservable";
  else if (native.jobs.running.some((job) => job.id === target.id && job.startTime === target.jobStartTime))
    state = "running";
  else
    state =
      native.jobs.recent.find((job) => job.id === target.id && job.startTime === target.jobStartTime)?.status ??
      "not-observed";
  return { ...wait, observedAt: native.observedAt, lastObservedState: state };
}

export function renderWait(wait: Wait): string {
  const target = wait.target;
  const name =
    target.kind === "label"
      ? target.text
      : target.kind === "ci"
        ? `ci:${target.repo}#${target.number}@${target.head}${target.checkRun === undefined ? "" : ` check-run:${target.checkRun}`}`
        : `${target.kind}:${target.id} session:${target.sessionId}${target.kind === "job" ? ` start:${target.jobStartTime}` : ""}`;
  return `${name} [${wait.lastObservedState}; since ${new Date(wait.startedAt).toISOString()}; last observation ${new Date(wait.observedAt).toISOString()}]`;
}

/** Optional evidence is validated at persistence boundaries without weakening the enclosing lane/report state. */
export function readWait(value: unknown): Wait | undefined {
  if (typeof value !== "object" || value === null) return;
  const v = value as Record<string, unknown>;
  const time = (n: unknown): n is number => typeof n === "number" && Number.isFinite(n) && Math.abs(n) <= 8.64e15;
  const text = (s: unknown): s is string => typeof s === "string" && s.length > 0;
  if (!time(v["startedAt"]) || !time(v["observedAt"]) || !states.some((state) => state === v["lastObservedState"]))
    return;
  if (typeof v["target"] !== "object" || v["target"] === null) return;
  const t = v["target"] as Record<string, unknown>;
  if (t["kind"] === "label") {
    if (!text(t["text"]) || v["lastObservedState"] !== "unverified") return;
  } else if (t["kind"] === "ci") {
    if (
      !text(t["repo"]) ||
      !/^[\w.-]+\/[\w.-]+$/.test(t["repo"]) ||
      !Number.isSafeInteger(t["number"]) ||
      Number(t["number"]) < 1 ||
      !text(t["head"]) ||
      !/^[a-f0-9]{40}$/i.test(t["head"]) ||
      (t["checkRun"] !== undefined && (!Number.isSafeInteger(t["checkRun"]) || Number(t["checkRun"]) < 1))
    )
      return;
  } else if (t["kind"] === "job" || t["kind"] === "approval") {
    if (
      !text(t["id"]) ||
      !text(t["sessionId"]) ||
      !text(t["sessionStartedAt"]) ||
      !Number.isFinite(Date.parse(t["sessionStartedAt"]))
    )
      return;
    if (t["kind"] === "job" && !time(t["jobStartTime"])) return;
  } else return;
  return value as Wait;
}
