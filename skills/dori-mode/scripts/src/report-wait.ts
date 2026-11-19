import { sameSession } from "../../../../src/refs.ts";
import { type Wait, waitKey } from "../../../../src/wait.ts";
import { type Lane, sameLaneGeneration, sessionOf } from "./registry.ts";
import type { Report } from "./reports.ts";

export type WaitProof = {
  readonly wait: Wait;
  readonly lane: Lane;
  readonly report: Report | null | undefined;
};

/** Called synchronously under the registry writer lock; only the current journal read is deferred. */
export const waitRejection = (
  current: Lane | null,
  proof: WaitProof,
  generation: string | undefined,
  readLatest: () => Report | null | undefined,
): string | undefined => {
  if (
    !current ||
    current.key !== proof.lane.key ||
    current.nativeCloseIntent ||
    current.lifecycleEpoch !== generation ||
    !sameLaneGeneration(proof.lane, current)
  )
    return "lane state changed while observing its wait; report again";
  const ref = sessionOf(proof.lane);
  const liveRef = sessionOf(current);
  if (ref ? !liveRef || !sameSession(ref, liveRef) : liveRef !== undefined)
    return "lane session changed while observing its wait; report again";
  const latest = readLatest();
  if (JSON.stringify(latest) !== JSON.stringify(proof.report) || current.lastWaitNotice !== proof.lane.lastWaitNotice)
    return "a newer report or wait observation arrived; report again";
  const wait = proof.wait;
  if (current.lastWaitNotice === `ended|${current.openedAt}|${waitKey(wait.target)}|${wait.startedAt}`)
    return "this wait has already ended; report a currently pending identity";
};
