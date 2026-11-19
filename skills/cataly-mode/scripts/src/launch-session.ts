import { randomUUID } from "node:crypto";
import { accessSync, constants, readFileSync, realpathSync, writeFileSync } from "node:fs";

import { ToolError } from "../../../../src/runtime/exec.ts";
import { HcError, isReportedKind } from "../../../../src/runtime/hc/exec.ts";
import { type CreateSpec, formatRef, type RuntimeKind, type SessionRef } from "../../../../src/runtime/types.ts";
import type { FlowDeps } from "./done-flow.ts";
import { recordExecution, runContext } from "./lane-run.ts";
import { quoteForPane, runCommandPrefix } from "./launch-footer.ts";
import {
  discardGeneratedBrief,
  type GeneratedBrief,
  publishGeneratedBrief,
  stageGeneratedBrief,
} from "./launch-generated.ts";
import { isDiscordSnowflake } from "./messenger/discord-inbound-state.ts";
import { createModelProfileFile } from "./model-profile.ts";
import { removePrepared } from "./prepared-file.ts";
import { type Lane, type Registry, sameLaneGeneration, sessionFields, sessionOf } from "./registry.ts";
import { Reports } from "./reports.ts";
import type { ReportProvenance } from "./request-identity.ts";
import type { ChosenRuntimes, Runner } from "./run.ts";
import { trustedPaneState } from "./session-id.ts";

export type OpenedLane =
  | { readonly kind: "opened"; readonly lane: Lane; readonly ref: SessionRef }
  | { readonly kind: "taken" }
  | { readonly kind: "failed"; readonly what: string; readonly error: unknown };

const why = (error: unknown): string => (error instanceof Error ? error.message : String(error));

/** Bind the route and run to this launch, not the shell or a later OMP session in the same pane. */
export const laneStartCommand = (lane: Pick<Lane, "key" | "thread" | "runId">, argv: readonly string[]): string => {
  const prefix =
    lane.thread.startsWith("discord:") && isDiscordSnowflake(lane.thread.slice("discord:".length))
      ? `CATALY_ASK_LAUNCHED_LANE=${quoteForPane(lane.key)} `
      : "";
  return `${prefix}${runCommandPrefix(lane)}${argv.map(quoteForPane).join(" ")}`;
};

const ownsLaunchRun = (lane: Lane, current: Lane | null): current is Lane => {
  if (
    !current ||
    current.nativeCloseIntent ||
    !sameLaneGeneration(lane, current) ||
    current.requestId !== lane.requestId ||
    current.runId !== lane.runId
  )
    return false;
  const expected = sessionOf(lane);
  const actual = sessionOf(current);
  return actual?.runtime === expected?.runtime && actual?.id === expected?.id;
};

/**
 * Records a sourced launch run as started before its agent starts, while the registry still holds this lane and run.
 * The attribution for the launch activity, or null when the lane moved on (the agent is then not started).
 */
export const startLaunchRun = (deps: FlowDeps, lane: Lane): Promise<ReportProvenance | null> =>
  deps.registry.withCurrent(lane.key, (current) => {
    if (!ownsLaunchRun(lane, current)) return null;
    recordExecution(deps.config.stateDir, current, deps.clock.now());
    return runContext(new Reports(deps.config.stateDir), current, current.runId)?.provenance ?? null;
  });

type NativeReadback = {
  readonly run: Runner;
  readonly rts: ChosenRuntimes;
  readonly stateDir: string;
  readonly ref: SessionRef;
};

/** Bind only if the same trusted live process and session bracket this launch's own goal readback. */
export const bindLaunchRun = async (
  deps: FlowDeps,
  lane: Lane,
  native: NativeReadback,
  proven: () => Promise<boolean>,
): Promise<void> => {
  const { run, rts, stateDir, ref } = native;
  const expected = sessionOf(lane);
  if (expected?.runtime !== ref.runtime || expected.id !== ref.id) return;
  const before = await trustedPaneState(run, stateDir, ref, rts);
  if (before?.role !== "lane" || !before.sessionId || !(await proven())) return;
  const after = await trustedPaneState(run, stateDir, ref, rts);
  if (after?.role !== "lane" || after.sessionId !== before.sessionId || after.pid !== before.pid) return;
  await deps.registry.withCurrent(lane.key, (current) => {
    if (ownsLaunchRun(lane, current) && (current.session ?? before.sessionId) === before.sessionId)
      recordExecution(stateDir, current, deps.clock.now(), before.sessionId);
  });
};

// A nonzero exit alone is not proof: the transport may have failed after terminal creation.
const creationWasRejected = (rts: ChosenRuntimes, error: unknown): boolean => {
  if (rts.failure !== undefined && error === rts.failure) return true;
  if (!(error instanceof ToolError)) return false;
  if (error.result.spawnFailed) return true;
  if (error instanceof HcError) {
    // A failed list was preflight; after `run`, only an explicit rejection reply proves non-creation.
    return error.argv[1] === "ls" || isReportedKind(error, "usage", "invalid_params", "name_taken");
  }
  try {
    const response: unknown = JSON.parse(error.result.stderr || error.result.stdout);
    if (!response || typeof response !== "object" || !("error" in response)) return false;
    const rejection = response.error;
    return (
      rejection !== null &&
      typeof rejection === "object" &&
      "code" in rejection &&
      rejection.code === "server_not_running"
    );
  } catch (error) {
    if (error instanceof SyntaxError) return false;
    throw error;
  }
};

// A brief that is a link (a shared template) is written through it, as a plain write would.
const briefTarget = (brief: string): string => {
  try {
    return realpathSync(brief);
  } catch {
    return brief;
  }
};

/**
 * Opens a lane's session and registers it before its agent starts (cataly report refuses an unknown key, so a fast
 * lane's first report would be lost). Generated briefs are staged privately before terminal creation and published only
 * when it returns a terminal identity; a confirmed rejection can discard just that attempt. An explicit brief is staged
 * beside its path, then rewritten in place once this launch owns the key; a failed rewrite restores its bytes. A key
 * another launch registered meanwhile is `taken`; its record and brief stay. A failure closes the session and cleans up.
 */
export const openLaneSession = async (
  registry: Registry,
  rts: ChosenRuntimes,
  spec: CreateSpec,
  draft: Lane,
  {
    preamble,
    generated,
    runtime,
    profileStateDir,
  }: {
    readonly preamble: string;
    readonly generated: boolean;
    readonly runtime: RuntimeKind;
    readonly profileStateDir?: string | undefined;
  },
): Promise<OpenedLane> => {
  let generatedAttempt: GeneratedBrief | undefined;
  let staged:
    | { readonly target: string; readonly pending: string; readonly backup: string; readonly original: Buffer }
    | undefined;
  const cleanup = (keepBackup = false): void => {
    if (!staged) return;
    removePrepared(staged.pending);
    if (!keepBackup) removePrepared(staged.backup);
  };
  try {
    if (generated) {
      generatedAttempt = stageGeneratedBrief(draft.brief, preamble);
    } else {
      const target = briefTarget(draft.brief);
      accessSync(target, constants.W_OK);
      staged = {
        target,
        pending: `${target}.${process.pid}.${randomUUID()}.launch`,
        // If a failed rewrite cannot be restored, the original stays where the error names it.
        backup: `${target}.${process.pid}.${randomUUID()}.original`,
        original: readFileSync(target),
      };
      writeFileSync(staged.pending, preamble, { flag: "wx", mode: 0o600 });
      writeFileSync(staged.backup, staged.original, { flag: "wx", mode: 0o600 });
    }
  } catch (error) {
    cleanup();
    return { kind: "failed", what: generated ? "generated brief not writable" : "brief not writable", error };
  }
  let ref: SessionRef, modelProfileFile: string | undefined;
  try {
    if (profileStateDir) modelProfileFile = createModelProfileFile(profileStateDir);
    ref = await rts.for({ runtime, id: "" }).create(spec);
  } catch (error) {
    cleanup();
    removePrepared(modelProfileFile);
    if (generatedAttempt && creationWasRejected(rts, error)) {
      discardGeneratedBrief(generatedAttempt);
      generatedAttempt = undefined;
    }
    const what = generatedAttempt
      ? `session create failed; generated brief retained at ${generatedAttempt.brief}`
      : "session create failed";
    return { kind: "failed", what, error };
  }
  const lane: Lane = {
    ...draft,
    ...sessionFields(ref),
    ...(ref.runtime === "headless" ? { lifecycleEpoch: ref.id } : {}),
    ...(modelProfileFile ? { modelProfileFile } : {}),
  };
  let registered = false;
  let keepBackup = false;
  let failure: OpenedLane = { kind: "taken" };
  try {
    if (generatedAttempt) {
      publishGeneratedBrief(generatedAttempt, draft.brief);
      generatedAttempt = undefined;
    }
    registered = await registry.create(lane);
    if (registered) {
      // Written in place, as the brief file itself: its inode, hard links, owner, group, mode and ACL stay.
      if (staged) writeFileSync(staged.target, preamble);
      cleanup();
      return { kind: "opened", lane, ref };
    }
  } catch (error) {
    const what = generatedAttempt
      ? `generated brief not published; retained at ${generatedAttempt.brief}`
      : "lane not registered";
    failure = { kind: "failed", what, error };
    if (registered && staged) {
      let reason = error;
      try {
        writeFileSync(staged.target, staged.original);
      } catch (restoreError) {
        keepBackup = true;
        reason = new Error(
          `${why(error)}; the original brief is kept at ${staged.backup} (it could not be put back: ${why(restoreError)})`,
        );
      }
      failure = { kind: "failed", what: "brief not written", error: reason };
    }
  }
  cleanup(keepBackup);
  removePrepared(modelProfileFile);
  if (registered)
    await registry.discard(lane).catch((error: unknown) => {
      process.stderr.write(`cataly: could not remove lane ${lane.key} after its launch failed (${why(error)})\n`);
    });
  await rts
    .for(ref)
    .close(ref, ref.container ? "container" : "session")
    .catch((error: unknown) => {
      process.stderr.write(
        `cataly: could not close ${formatRef(ref)} after lane ${lane.key} did not open (${why(error)})\n`,
      );
    });
  return failure;
};
