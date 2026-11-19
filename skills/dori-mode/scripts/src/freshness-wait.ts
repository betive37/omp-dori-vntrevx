import { sameSession } from "../../../../src/refs.ts";
import { observeWait, renderWait, waitEnded, waitKey } from "../../../../src/wait.ts";
import type { FlowDeps } from "./done-flow.ts";
import type { SweepAct } from "./freshness.ts";
import { type Lane, sessionOf, statusOf } from "./registry.ts";
import { type Progress, Reports } from "./reports.ts";
import { runtimesOf } from "./run.ts";

/** An advisory notice only: the journal's blocker, pause, quota and ceiling are never cleared here. */
export async function checkWaiting(
  deps: FlowDeps,
  lane: Lane,
  progress: Progress | null,
): Promise<SweepAct | undefined> {
  const report = progress?.lastReport;
  const wait = report?.wait;
  const ref = sessionOf(lane);
  if (
    progress?.state !== "blocked" ||
    report?.kind !== "blocker" ||
    !wait ||
    !ref ||
    (wait.target.kind !== "job" && wait.target.kind !== "approval") ||
    Date.parse(report.at) < Date.parse(lane.openedAt)
  )
    return;
  const ended = `ended|${lane.openedAt}|${waitKey(wait.target)}|${wait.startedAt}`;
  if (lane.lastWaitNotice === ended) return;
  let note: string | undefined;
  let outcome: SweepAct | undefined;
  try {
    const observed = observeWait(wait, await runtimesOf(deps).for(ref).probe(ref));
    if (waitEnded(observed)) {
      note = ended;
      outcome = {
        kind: "wait-ended",
        lane: lane.key,
        detail: `${renderWait(observed)}; blocker unchanged; not success or permission to resume`,
      };
    }
  } catch (error) {
    const detail = `wait observation failed: ${error instanceof Error ? error.message : String(error)}`;
    note = `error|${waitKey(wait.target)}|${detail}`;
    outcome = { kind: "warning", lane: lane.key, detail };
  }
  if (note === lane.lastWaitNotice) return;
  let emitted: SweepAct | undefined;
  await deps.registry.transition(lane, (current) => {
    const currentRef = sessionOf(current);
    if (
      statusOf(current) !== "working" ||
      !currentRef ||
      !sameSession(ref, currentRef) ||
      JSON.stringify(new Reports(deps.config.stateDir).read(lane.key)?.lastReport) !== JSON.stringify(report) ||
      current.lastWaitNotice !== lane.lastWaitNotice ||
      current.lastWaitNotice === note
    )
      return current;
    emitted = outcome;
    return { ...current, lastWaitNotice: note };
  });
  return emitted;
}
