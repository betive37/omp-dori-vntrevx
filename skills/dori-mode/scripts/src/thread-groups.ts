import { createHash } from "node:crypto";
import { fill } from "./config.ts";
import { withDeliveryLock } from "./delivery-lock.ts";
import type { FlowDeps } from "./done-flow.ts";
import { type Lane, statusOf, withStatus } from "./registry.ts";

export type CloseCommit = {
  readonly closed: Lane | null;
  readonly remaining?: readonly string[];
  readonly held?: string;
};

/** Elect the last closer while serializing the close transition and sibling snapshot, not external hooks. */
export const commitThreadClose = async (deps: FlowDeps, lane: Lane, note: string, at: string): Promise<CloseCommit> => {
  const grouped = deps.config.threadDonePolicy === "last-lane" && lane.thread !== "none";
  const commit = async (): Promise<CloseCommit> => {
    const remaining = grouped
      ? (await deps.registry.open())
          .filter((other) => other.key !== lane.key && other.thread === lane.thread)
          .map((other) => other.key)
      : undefined;
    const closed =
      statusOf(lane) === "closed"
        ? null
        : await deps.registry.transition(lane, (current) => withStatus(current, "closed", note, at, { closedAt: at }));
    return { closed, ...(remaining === undefined ? {} : { remaining }) };
  };
  if (!grouped) return commit();
  // @ cannot begin a lane key, so this cannot collide with a lane's own delivery lock.
  const key = `@thread-${createHash("sha256").update(lane.thread).digest("hex")}`;
  const held = await withDeliveryLock(deps, key, commit);
  return held.ok ? held.value : { closed: null, held: held.holder };
};

export const finishThread = async (
  deps: FlowDeps,
  lane: Lane,
  note: string,
  remaining?: readonly string[],
): Promise<string[]> => {
  if (lane.thread === "none") return [];
  if (remaining?.length)
    return [
      `thread ${lane.thread}: ${remaining.length} lanes still open (${remaining.join(", ")}); threadDone skipped`,
    ];
  const hook = deps.config.hooks.threadDone;
  if (!hook) return [];
  const result = await deps.run(fill(hook, { thread: lane.thread, text: note, key: lane.key }));
  return [result.code === 0 ? "thread marked done" : `thread hook failed: ${result.err.slice(0, 160)}`];
};
