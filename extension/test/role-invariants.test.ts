import { beforeEach, expect, test } from "bun:test";
import { join } from "node:path";
import { nativeComposition, SOL_MODEL } from "../../test/fixtures/omp-native-host/compose.ts";
import { LANE_BOOKKEEPING } from "../lane-bookkeeping.ts";
import { ROLE_INVARIANTS } from "../role-invariants.ts";
import { load, useConfig } from "./fake-pi.ts";

const dori = join(import.meta.dir, "../index.ts");
const ASTRA = { ...SOL_MODEL, id: "gpt-6-astra", name: "GPT-6 Astra" };

beforeEach(() => {
  useConfig("");
});

for (const role of ["dori", "lane"] as const) {
  for (const model of [SOL_MODEL, ASTRA]) {
    test(`${role} root on ${model.id} retains its core through native compaction`, async () => {
      const base = ["Host system policy", "Retained downstream context"];
      const original = [...base];
      const expected = [
        ...base,
        ROLE_INVARIANTS[role],
        ...(role === "lane" && model.id === SOL_MODEL.id ? [LANE_BOOKKEEPING] : []),
      ];
      const result = await nativeComposition([dori], base, { role, model, compactBetweenTurns: true });
      expect(JSON.stringify(result.beforeMessages)).toContain("History-only role instruction");
      expect(JSON.stringify(result.afterMessages)).not.toContain("History-only role instruction");
      expect(JSON.stringify(result.afterMessages)).toContain("Earlier work summarized without role instructions.");
      expect(result.entries.filter((entry) => entry.type === "compaction")).toHaveLength(1);
      expect(result.first).toEqual(expected);
      expect(result.second).toEqual(expected);
      expect(result.afterAll).toEqual([expected, expected]);
      expect(JSON.stringify(result.second)).toContain("Paused work waits for the user's explicit resume instruction");
      expect(JSON.stringify(result.second)).toContain("Use the applicable explicit authorization");
      expect(base).toEqual(original);
    });
  }
}

test("plain native sessions stay unchanged before and after compaction", async () => {
  const base = ["Host system policy"];
  const result = await nativeComposition([dori], base, { model: ASTRA, compactBetweenTurns: true });
  expect(result.firstResult).toBeUndefined();
  expect(result.secondResult).toBeUndefined();
  expect(result.afterAll).toEqual([base, base]);
  expect(JSON.stringify(result.afterMessages)).not.toContain("History-only role instruction");
});

test("an inherited child role gets no root invariant block after compaction", async () => {
  const parent = { kind: "main", id: "InvariantParent", name: "Main", depth: 0 } as const;
  await nativeComposition([dori], ["Parent policy"], { role: "lane", agent: parent });
  const base = ["Child policy"];
  const result = await nativeComposition([dori], base, {
    agent: { kind: "sub", id: "InvariantChild", name: "Child", depth: 1, parentId: parent.id },
    compactBetweenTurns: true,
  });
  expect(result.firstResult).toBeUndefined();
  expect(result.secondResult).toBeUndefined();
  expect(result.afterAll).toEqual([base, base]);
  expect(JSON.stringify(result.afterMessages)).not.toContain("History-only role instruction");
});

test("already composed role and Sol bookkeeping blocks are not appended again", async () => {
  const pi = await load({
    session: { id: "invariant-repeat", entries: [] },
    flags: { "dori-role": "lane" },
    model: SOL_MODEL,
  });
  await pi.emit("session_start");
  const systemPrompt = ["Host policy", ROLE_INVARIANTS.lane, LANE_BOOKKEEPING];
  const original = [...systemPrompt];
  expect(await pi.emit("before_agent_start", { systemPrompt })).toEqual([undefined]);
  expect(systemPrompt).toEqual(original);
});

test("invalid host prompt payloads are not replaced with an invented prompt", async () => {
  const pi = await load({
    session: { id: "invariant-invalid", entries: [] },
    flags: { "dori-role": "dori" },
    model: ASTRA,
  });
  await pi.emit("session_start");
  for (const systemPrompt of [undefined, "host", ["host", 1]])
    expect(await pi.emit("before_agent_start", { systemPrompt })).toEqual([undefined]);
});
