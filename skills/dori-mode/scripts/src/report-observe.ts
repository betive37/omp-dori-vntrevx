import type { Activity, Progress } from "./reports.ts";

export const reportActivity = (
  key: string,
  progress: Progress,
  screen: string,
  now: number,
  staleAfterMs: number,
  resumeOnWorking: boolean,
): Activity | null => {
  if (progress.state !== "running" && progress.state !== "stalled") return null;
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
  if (state === progress.state) return null;
  const { generation } = progress.lastEvent;
  return {
    type: "activity",
    key,
    at: new Date(now).toISOString(),
    state,
    ...(generation === undefined ? {} : { generation }),
    text: failed
      ? "compaction failed"
      : state === "stalled"
        ? "idle prompt without Working or a fresh report"
        : "Working activity resumed",
  };
};
