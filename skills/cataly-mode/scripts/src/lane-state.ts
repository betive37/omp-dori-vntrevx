import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { ModelSwitchReceipt } from "./model-switch-state.ts";

/**
 * Per-pane state written by the omp-cataly extension from inside a Cataly or lane session and read by the `cataly` CLI.
 * omp exposes no session id in argv or the environment and no goal readback on screen that cataly can trust, so the
 * session reports itself here. One file per herdr pane or hc terminal; the extension is the only writer.
 */
export type CatalyRole = "cataly" | "lane";
export type GoalStatus = "none" | "active" | "paused" | "complete" | "dropped" | "blocked";

export interface ModelReadback {
  readonly requested: { readonly provider: string; readonly id: string } | null;
  readonly observed: { readonly provider: string; readonly id: string } | null;
  readonly status: "matched" | "mismatch" | "unavailable" | "unknown" | "unrequested";
  readonly billing: "subscription" | "non-subscription" | "unknown";
  readonly checkedAt: string;
  readonly source: "native-extension" | "launch-preflight";
  readonly reason?: string;
  /** Present when a trailing `:<level>` selected the base model: the requested and live native thinking levels. */
  readonly thinking?: { readonly requested: string; readonly observed: string | null };
}

/** One native observation, replaced only by an explicit idle lane-model change. */
export interface ModelSnapshot {
  readonly version: 1;
  readonly id: string;
  readonly model: NonNullable<ModelReadback["observed"]>;
  readonly modelRoles: Readonly<Record<string, string>>;
  readonly defaultThinkingLevel: string;
  /** The native selection, including auto; its resolved per-turn level is only an observation below. */
  readonly configuredThinkingLevel: string | null;
  /** null is the native session's unset level, not an inferred default. */
  readonly thinkingLevel: string | null;
  readonly capturedAt: string;
  readonly provenance: {
    readonly kind: "launch" | "idle-switch";
    readonly requested: string;
    readonly modelRoles: Readonly<Record<string, "env" | "runtime" | "overlay" | "project" | "global" | "default">>;
    readonly defaultThinkingLevel: "env" | "runtime" | "overlay" | "project" | "global" | "default";
  };
}

export type PaneState = {
  readonly paneId: string;
  readonly role: CatalyRole;
  readonly sessionId: string;
  readonly sessionFile?: string;
  readonly discordLaneKey?: string;
  readonly discordLaneInbox?: true;
  readonly discordLaneReceiver?: { readonly channel: string; readonly stateDir: string };
  readonly cwd: string;
  readonly pid: number;
  readonly startedAt: string;
  readonly updatedAt: string;
  readonly goal: { readonly status: GoalStatus; readonly objective?: string };
  /** A tool approval prompt is open in this session: never type into the pane. */
  readonly approvalPending: boolean;
  /** Last native agent lifecycle event; absent in older records, independent of goal status. */
  readonly agentStatus?: "idle" | "working";
  /** Native catalog and selected-model agreement, never billing authorization or a quota balance. */
  readonly modelReadback?: ModelReadback;
  readonly modelSnapshot?: ModelSnapshot;
  readonly modelProfileFile?: string;
  /** A saved selection exists but cannot safely govern this native session. */
  readonly modelSnapshotError?: string;
  /** This process's receipt for the last `/dori-model-apply` nonce it claimed; validated where read. */
  readonly modelSwitch?: ModelSwitchReceipt;
};

/** The native catalog distinguishes literal colon-tagged ids from thinking suffixes. */
export const exactModelIdentity = (value: string): ModelReadback["requested"] => {
  const match = /^([a-zA-Z0-9][a-zA-Z0-9._-]*)\/([^\s*,]+)$/.exec(value);
  return match?.[1] && match[2] ? { provider: match[1], id: match[2] } : null;
};

const THINKING_LEVELS = new Set(["off", "minimal", "low", "medium", "high", "xhigh", "max"]);

/**
 * OMP's trailing `:<level>` model selector suffix; any other colon suffix stays part of a literal id. Case-sensitive like
 * OMP's grammar, where `:HIGH` is a literal id: every level comparison goes through this one parse.
 */
export const thinkingSuffix = (id: string): { readonly base: string; readonly level: string } | null => {
  const at = id.lastIndexOf(":");
  return at > 0 && THINKING_LEVELS.has(id.slice(at + 1)) ? { base: id.slice(0, at), level: id.slice(at + 1) } : null;
};

/**
 * The `provider/model` a matched readback of `model` must observe, from its persisted and therefore untrusted thinking
 * record: the literal request without one, else the base model when the request ends in a recognized level that was
 * both requested and observed. Null holds a malformed or inconsistent record.
 */
export const expectedLaunchModel = (
  model: string,
  thinking: unknown,
): { readonly model: string; readonly thinking?: NonNullable<ModelReadback["thinking"]> } | null => {
  if (thinking === undefined) return { model };
  const suffix = thinkingSuffix(model);
  const record = typeof thinking === "object" && thinking !== null ? (thinking as Record<string, unknown>) : null;
  return suffix && record?.["requested"] === suffix.level && record["observed"] === suffix.level
    ? { model: suffix.base, thinking: { requested: suffix.level, observed: suffix.level } }
    : null;
};

const record = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);
const MODEL_PROVENANCE: ReadonlySet<unknown> = new Set(["env", "runtime", "overlay", "project", "global", "default"]);

/** Session entries and pane JSON are input boundaries; a malformed latest snapshot never falls back to an old one. */
export const isModelSnapshot = (value: unknown): value is ModelSnapshot => {
  if (
    !record(value) ||
    value["version"] !== 1 ||
    typeof value["id"] !== "string" ||
    !value["id"] ||
    !record(value["model"]) ||
    typeof value["model"]["provider"] !== "string" ||
    typeof value["model"]["id"] !== "string" ||
    !record(value["modelRoles"]) ||
    typeof value["defaultThinkingLevel"] !== "string" ||
    !value["defaultThinkingLevel"] ||
    !(
      value["configuredThinkingLevel"] === null ||
      (typeof value["configuredThinkingLevel"] === "string" && value["configuredThinkingLevel"].length > 0)
    ) ||
    !(
      value["thinkingLevel"] === null ||
      (typeof value["thinkingLevel"] === "string" && value["thinkingLevel"].length > 0)
    ) ||
    typeof value["capturedAt"] !== "string" ||
    !Number.isFinite(Date.parse(value["capturedAt"])) ||
    !record(value["provenance"]) ||
    (value["provenance"]["kind"] !== "launch" && value["provenance"]["kind"] !== "idle-switch") ||
    typeof value["provenance"]["requested"] !== "string" ||
    !exactModelIdentity(value["provenance"]["requested"]) ||
    !record(value["provenance"]["modelRoles"]) ||
    !MODEL_PROVENANCE.has(value["provenance"]["defaultThinkingLevel"])
  )
    return false;
  const identity = exactModelIdentity(`${value["model"]["provider"]}/${value["model"]["id"]}`);
  if (!identity || identity.provider !== value["model"]["provider"] || identity.id !== value["model"]["id"])
    return false;
  const sources = value["provenance"]["modelRoles"];
  return Object.entries(value["modelRoles"]).every(
    ([role, model]) => typeof model === "string" && model.length > 0 && MODEL_PROVENANCE.has(sources[role]),
  );
};

export const paneStateDir = (stateDir: string): string => join(stateDir, "sessions");

export const paneStatePath = (stateDir: string, paneId: string): string =>
  join(paneStateDir(stateDir), `${encodeURIComponent(paneId)}.json`);

export const readPaneState = (stateDir: string, paneId: string): PaneState | null => {
  try {
    const state = JSON.parse(readFileSync(paneStatePath(stateDir, paneId), "utf8")) as
      PaneState | (Omit<PaneState, "role"> & { readonly role: "dori" });
    return state?.role === "dori" ? { ...state, role: "cataly" } : state;
  } catch {
    return null;
  }
};

// temp file + rename so a concurrent reader never sees a half-written state
export const writePaneState = (stateDir: string, state: PaneState): void => {
  mkdirSync(paneStateDir(stateDir), { recursive: true });
  const path = paneStatePath(stateDir, state.paneId);
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(state, null, 1));
  renameSync(tmp, path);
};
