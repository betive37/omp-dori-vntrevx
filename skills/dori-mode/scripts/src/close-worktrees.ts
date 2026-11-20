import { existsSync } from "node:fs";
import type { FlowDeps } from "./done-flow.ts";
import type { Lane } from "./registry.ts";
import type { Runner } from "./run.ts";

export const discoverWorktrees = async (
  lane: Lane,
  run: Runner,
  extraRoots: readonly string[] = [],
): Promise<string[]> => {
  const found = new Set<string>(lane.worktrees ?? []);
  const ours = (name: string) => name === lane.key || name.startsWith(`${lane.key}-`);
  for (const root of new Set([lane.cwd ?? "", ...extraRoots].filter(Boolean))) {
    const r = await run(["git", "-C", root, "worktree", "list", "--porcelain"]);
    if (r.code !== 0) continue;
    let path = "";
    for (const line of r.out.split("\n")) {
      if (line.startsWith("worktree ")) path = line.slice(9);
      else if (
        line.startsWith("branch ") &&
        path !== root &&
        (ours(line.split("/").pop() ?? "") || ours(path.split("/").pop() ?? ""))
      )
        found.add(path);
    }
  }
  return [...found];
};
export const unpushedWork = async (deps: FlowDeps, lane: Lane): Promise<string[]> => {
  const exists = deps.exists ?? existsSync;
  const reasons: string[] = [];
  // Check owned worktrees instead of blocking on changes in the human's checkout.
  // If the lane works directly in its cwd, that checkout must be checked instead.
  const owned = await discoverWorktrees(lane, deps.run, [deps.config.defaultCwd]);
  const roots = owned.length ? owned : [lane.cwd ?? deps.config.defaultCwd];
  for (const wt of roots) {
    if (!exists(wt)) continue;
    // Only the fallback cwd may be skipped when it is not a checkout (#42).
    if (!owned.length) {
      const inside = await deps.run(["git", "-C", wt, "rev-parse", "--is-inside-work-tree"]);
      if (inside.code !== 0 || inside.out.trim() !== "true") continue;
    }
    const dirty = await deps.run(["git", "-C", wt, "status", "--porcelain", "--untracked-files=no"]);
    const ahead = await deps.run(["git", "-C", wt, "rev-list", "--count", "HEAD", "--not", "--remotes"]);
    if (dirty.code !== 0 || ahead.code !== 0) reasons.push(`unpushed work in ${wt} (git state unreadable)`);
    else if (dirty.out.trim() || Number(ahead.out.trim()) > 0) reasons.push(`unpushed work in ${wt}`);
  }
  return reasons;
};
