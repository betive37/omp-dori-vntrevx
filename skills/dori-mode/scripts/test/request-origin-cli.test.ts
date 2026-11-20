import { expect, test } from "bun:test";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { Registry } from "../src/registry.ts";
import { Reports } from "../src/reports.ts";
import { withDiscordCli } from "./discord-fakes.ts";

const requestId = "discord:111111111111111111:222222222222222222";
const oldRun = "00000000-0000-4000-8000-000000000001";
const currentRun = "00000000-0000-4000-8000-000000000002";
const originalNative = { sessionId: "native-original", ref: { runtime: "herdr", id: "w1:p7" } };
const currentNative = { sessionId: "native-current", ref: { runtime: "herdr", id: "w1:p8" } };
const lane = {
  key: "request-origin",
  title: "One original request",
  thread: "discord:111111111111111111",
  brief: "/brief",
  done: "file /done",
  openedAt: "2026-01-01T00:00:00.000Z",
  reportProtocol: "jsonl-v1",
  lifecycleEpoch: "current-generation",
  requestId,
  runId: currentRun,
  session: currentNative.sessionId,
} as const;

async function prepare(stateDir: string) {
  await new Registry(stateDir).write(lane);
  const path = new Reports(stateDir).path(lane.key);
  mkdirSync(dirname(path), { recursive: true });
  const events = [
    [oldRun, "original-generation", originalNative],
    [currentRun, lane.lifecycleEpoch, currentNative],
  ] as const;
  writeFileSync(
    path,
    events
      .flatMap(([runId, generation, nativeRef]) =>
        (["started", "bound"] as const).map((phase) => ({
          type: "execution",
          key: lane.key,
          at: lane.openedAt,
          text: `Lane execution ${phase}`,
          phase,
          generation,
          requestId,
          runId,
          ...(phase === "bound" ? { nativeRef } : {}),
        })),
      )
      .map((event) => JSON.stringify(event) + "\n")
      .join(""),
  );
  return path;
}

const reportArgs = ["report", lane.key, "--kind", "milestone", "--text", "A late result", "--json"];

test("a late CLI report keeps the original request, run and native reference after reopen", async () => {
  await withDiscordCli(async (f) => {
    const stateDir = dirname(f.tmp);
    const path = await prepare(stateDir);
    const result = await f.invoke(reportArgs, { environment: { DORI_LANE_RUN: oldRun } });
    expect([result.code, result.err, result.keys]).toEqual([0, "", []]);
    const receipt = JSON.parse(result.out);
    expect(receipt.generation).toBe("original-generation");
    expect(receipt.provenance).toEqual({ requestId, runId: oldRun, nativeRef: originalNative });
    expect(receipt.delivery.state).toBe("unverified");
    const saved = JSON.parse(readFileSync(path, "utf8").trim().split("\n").at(-1)!);
    expect(saved.provenance).toEqual(receipt.provenance);
    const status = await f.invoke(["status", lane.key, "--json"]);
    expect(status.code).toBe(0);
    expect(JSON.parse(status.out).lanes[0].progress).toBeNull();
    const relayed = await f.invoke(["relayed", lane.key, "--report", receipt.id]);
    expect(relayed.code).not.toBe(0);
    expect((await new Registry(stateDir).read(lane.key))?.lastPostedReportId).toBeUndefined();
  });
});

test.each(["", "00000000-0000-4000-8000-000000000099"])(
  "an unbound CLI run cannot become the current sourced report: %s",
  async (runId) => {
    await withDiscordCli(async (f) => {
      const path = await prepare(dirname(f.tmp));
      const before = readFileSync(path, "utf8");
      const result = await f.invoke(reportArgs, { environment: { DORI_LANE_RUN: runId } });
      expect(result.code).not.toBe(0);
      expect(result.err).toContain("run");
      expect(result.keys).toEqual([]);
      expect(readFileSync(path, "utf8")).toBe(before);
    });
  },
);

test("a current sourced report exposes its immutable attribution and unverified delivery", async () => {
  await withDiscordCli(async (f) => {
    await prepare(dirname(f.tmp));
    const result = await f.invoke(reportArgs, { environment: { DORI_LANE_RUN: currentRun } });
    expect([result.code, result.err, result.keys]).toEqual([0, "", []]);
    const receipt = JSON.parse(result.out);
    expect(receipt.generation).toBe(lane.lifecycleEpoch);
    expect(receipt.provenance).toEqual({ requestId, runId: currentRun, nativeRef: currentNative });
    expect(receipt.delivery.state).toBe("unverified");
  });
});

test("an unsourced legacy lane does not acquire request or execution identity from ambient environment", async () => {
  await withDiscordCli(async (f) => {
    const { requestId: _request, runId: _run, ...legacy } = lane;
    await new Registry(dirname(f.tmp)).write(legacy);
    const result = await f.invoke(reportArgs, { environment: { DORI_LANE_RUN: oldRun } });
    expect([result.code, result.err, result.keys]).toEqual([0, "", []]);
    const receipt = JSON.parse(result.out);
    expect(receipt.generation).toBe(lane.lifecycleEpoch);
    expect(receipt.provenance).toBeUndefined();
    expect(receipt.delivery).toBeUndefined();
  });
});
