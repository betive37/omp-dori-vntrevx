import { Refusal } from "./refusal.ts";
import { recordWait, type Wait, type WaitRequest } from "./wait.ts";

/** Read only when reporting a CI wait; neither duty nor freshness polls GitHub. */
export async function bindCiWait(
  request: Extract<WaitRequest, { kind: "ci" }>,
  readHead: () => Promise<string>,
  api: (endpoint: string) => Promise<unknown>,
  now: () => number,
  previous?: Wait,
): Promise<Wait> {
  const head = (await readHead()).toLowerCase();
  if (!/^[a-f0-9]{40}$/.test(head)) throw new Refusal("CI wait needs a complete PR head SHA");
  let state: Wait["lastObservedState"] = "bound";
  if (request.checkRun !== undefined) {
    const value = await api(`repos/${request.repo}/check-runs/${request.checkRun}`);
    if (typeof value !== "object" || value === null) throw new Refusal("CI check-run is unobservable");
    const check = value as Record<string, unknown>;
    if (
      check["id"] !== request.checkRun ||
      typeof check["head_sha"] !== "string" ||
      check["head_sha"].toLowerCase() !== head
    )
      throw new Refusal("CI check-run does not belong to the current PR head");
    if (check["status"] === "completed")
      throw new Refusal("CI check-run already completed; it cannot establish a wait");
    switch (check["status"]) {
      case "queued":
      case "in_progress":
      case "pending":
      case "waiting":
      case "requested":
        state = check["status"];
        break;
      default:
        throw new Refusal("CI check-run has no observable pending state");
    }
    if ((await readHead()).toLowerCase() !== head)
      throw new Refusal("PR head moved while binding the CI wait; report again");
  }
  const at = now();
  return recordWait({ ...request, head }, state, at, at, previous);
}
