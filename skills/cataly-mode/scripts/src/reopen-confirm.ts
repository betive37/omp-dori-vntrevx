import type { SessionRef } from "../../../../src/runtime/types.ts";
import type { FlowDeps } from "./done-flow.ts";
import type { ModelReadback, ModelSnapshot } from "./lane-state.ts";
import { LaunchError } from "./launch.ts";
import { modelResumeCommand, verifiedModelSnapshot } from "./launch-model.ts";
import { removePrepared } from "./prepared-file.ts";
import { confirmedLaneState, nativeGoalStatus } from "./lifecycle-session.ts";
import { createModelProfileFile } from "./model-profile.ts";
import type { Lane } from "./registry.ts";

export type Reopened = { sessionId: string | undefined; snapshot?: ModelSnapshot; readback?: ModelReadback };

/** Waits for the same saved session to come back idle; a profile-owned reopen also needs its verified snapshot. */
export const awaitReopened = async (
  deps: FlowDeps,
  opened: Lane,
  ref: SessionRef,
  file: string,
  headless: boolean,
  profileFile: string | undefined,
): Promise<Reopened | { problem: string }> => {
  const attempts = Math.max(1, Math.ceil(deps.config.startupWaitSeconds));
  let problem = "native model snapshot not observed";
  for (let n = 0; n < attempts; n++) {
    const state = await confirmedLaneState(deps, opened, ref);
    const goal = nativeGoalStatus(state);
    if (
      state &&
      (!headless || state.sessionFile === file) &&
      (goal === "paused" || goal === "none" || goal === "complete" || goal === "dropped")
    ) {
      if (!profileFile) return { sessionId: state.sessionId };
      if (state.modelReadback && state.sessionFile === file && state.agentStatus === "idle") {
        const snapshot = verifiedModelSnapshot(state, profileFile);
        if (typeof snapshot !== "string")
          return { sessionId: state.sessionId, snapshot, readback: state.modelReadback };
        problem = snapshot;
        if (state.modelSnapshotError) break;
      }
    }
    await deps.clock.sleep(1000);
  }
  return { problem };
};

/** A pinned lane reopens onto its saved snapshot, not onto a live default that may have moved. */
export const recordReopenedModel = async (deps: FlowDeps, opened: Lane, confirmed: Reopened): Promise<Lane | null> => {
  const { snapshot, readback } = confirmed;
  if (!snapshot) return opened;
  return deps.registry.transition(opened, (current) => ({
    ...current,
    model: `${snapshot.model.provider}/${snapshot.model.id}`,
    ...(readback ? { modelReadback: readback } : {}),
    modelSnapshot: snapshot,
  }));
};

/** A native reopen resumes the saved session on its own profile overlay; headless reopen has neither. */
export const prepareNativeReopen = (
  deps: FlowDeps,
  template: readonly string[],
  file: string,
  headless: boolean,
): { profileFile: string | undefined; argv: readonly string[] | undefined } => {
  if (headless) return { profileFile: undefined, argv: undefined };
  const profileFile = createModelProfileFile(deps.config.stateDir);
  const resumed = modelResumeCommand(template, file);
  if (typeof resumed === "string") {
    removePrepared(profileFile);
    throw new LaunchError(resumed);
  }
  return { profileFile, argv: [...resumed, `--config=${profileFile}`] };
};
