import { rmSync } from "node:fs";
import { mayRunOmpArgv } from "../../../../src/runtime/omp-argv.ts";
import type { FlowDeps } from "./done-flow.ts";
import type { Lane } from "./registry.ts";

// Each cleanup step is tried on its own: one that fails is reported and never stops the others.
export const removePrepared = (path: string | undefined): void => {
  if (!path) return;
  try {
    rmSync(path, { force: true });
  } catch (error) {
    process.stderr.write(
      `cataly: could not remove the prepared launch file ${path} (${error instanceof Error ? error.message : String(error)})\n`,
    );
  }
};

/** Native launches own a process model profile unless a launch-preflight lane never captures one. */
export const launchProfileDir = (deps: FlowDeps, runtime: string, draft: Lane): string | undefined =>
  runtime !== "headless" &&
  mayRunOmpArgv(deps.config.agentCommand) &&
  draft.modelReadback?.source !== "launch-preflight"
    ? deps.config.stateDir
    : undefined;
