import { recordExecution } from "../src/lane-run.ts";
import { type Lane, Registry } from "../src/registry.ts";

export const REQUEST = "discord:111111111111111111:222222222222222222";
export const OLD_RUN = "00000000-0000-4000-8000-000000000001";
export const CURRENT_RUN = "00000000-0000-4000-8000-000000000002";
export const T0 = Date.parse("2026-01-01T00:00:00.000Z");
export const sourcedLane = {
  key: "trace-request", title: "Original request", thread: "discord:111111111111111111",
  brief: "/brief", done: "file /done", openedAt: new Date(T0).toISOString(),
  reportProtocol: "jsonl-v1", lifecycleEpoch: "current-generation",
  requestId: REQUEST, runId: CURRENT_RUN, session: "native-current",
} as const satisfies Lane;

/** Stored readback fixtures; CLI tests never probe or start an actual terminal. */
export async function seedRequest(stateDir: string, requestId = REQUEST) {
  const lane = { ...sourcedLane, requestId };
  const old = { ...lane, runId: OLD_RUN, lifecycleEpoch: "original-generation", session: "native-original" };
  for (const [entry, id] of [[old, "w1:p7"], [lane, "w1:p8"]] as const) {
    const bound = { ...entry, sessionRef: { runtime: "herdr", id } as const };
    recordExecution(stateDir, bound, T0);
    recordExecution(stateDir, bound, T0, bound.session);
  }
  await new Registry(stateDir).write(lane);
  return { lane, old };
}
