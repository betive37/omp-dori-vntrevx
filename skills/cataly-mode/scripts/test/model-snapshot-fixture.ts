import { randomUUID } from "node:crypto";
import { realpathSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { exactModelIdentity, type ModelSnapshot, type PaneState } from "../src/lane-state.ts";
import { createModelProfileFile } from "../src/model-profile.ts";

export const snapshotFor = (model: string, requested = model): ModelSnapshot => {
  const identity = exactModelIdentity(model);
  if (!identity) throw new Error(`invalid fixture model ${model}`);
  return {
    version: 1,
    id: randomUUID(),
    model: identity,
    modelRoles: { default: model, task: model },
    defaultThinkingLevel: "high",
    configuredThinkingLevel: "high",
    thinkingLevel: "high",
    capturedAt: "2026-01-01T12:00:00.000Z",
    provenance: {
      kind: "launch",
      requested,
      modelRoles: { default: "global", task: "global" },
      defaultThinkingLevel: "global",
    },
  };
};

/** A saved native session file carrying its model snapshot, plus the pane evidence a reopened process would report. */
export const savedNativeSession = (sessionDir: string, stateDir: string, session: string, cwd: string) => {
  // Lifecycle receipts and resume commands use canonical transcript paths, even under a symlinked TMPDIR.
  const file = join(realpathSync(sessionDir), `2026-01-01T12-00-00-000Z_${session}.jsonl`);
  const snapshot = snapshotFor("fixture/saved");
  const initialProfile = createModelProfileFile(stateDir);
  const nativeModel = {
    modelSnapshot: snapshot,
    modelReadback: {
      requested: snapshot.model,
      observed: snapshot.model,
      status: "matched",
      billing: "unknown",
      source: "native-extension",
      checkedAt: snapshot.capturedAt,
    },
  } satisfies Partial<PaneState>;
  const entries = [
    { type: "session", id: session, cwd },
    { type: "custom", customType: "omp-cataly:model-snapshot", data: snapshot },
  ];
  writeFileSync(file, `${entries.map((entry) => JSON.stringify(entry)).join("\n")}\n`);
  return { file, initialProfile, nativeModel };
};
