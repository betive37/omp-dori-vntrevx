import { expect, test } from "bun:test";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Playback } from "../src/voice/audio.ts";
import { liveSocket, parseLiveEvent } from "../src/voice/provider.ts";
import { Replies } from "../src/voice/replies.ts";
import { VoiceSession } from "../src/voice/session.ts";
import type { Wire } from "../src/voice/types.ts";
import { VoiceUsage } from "../src/voice/usage.ts";
import { settings, temporaryVoice } from "./voice-fixture.ts";

type Ledger = { days: Record<string, { liveSeconds: number; pausedSeconds: number }> };
const ledger = (directory: string): Ledger => JSON.parse(readFileSync(join(directory, "usage.json"), "utf8"));

// A loopback stand-in for the Live primary WebSocket; no OpenAI endpoint or key is used.
test("gpt-live-1.1 over a loopback Live socket records billed and paused seconds from the usage breakdown", async () => {
  const temp = temporaryVoice();
  const received: Wire[] = [];
  let authorization: string | null = null;
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch(request, srv) {
      authorization = request.headers.get("authorization");
      return srv.upgrade(request) ? undefined : new Response("upgrade required", { status: 426 });
    },
    websocket: {
      message(ws, data) {
        const event: Wire = JSON.parse(String(data));
        received.push(event);
        if (event["type"] === "session.start") {
          ws.send(JSON.stringify({ type: "session.started", session: { id: "live_loopback" } }));
          ws.send(JSON.stringify({ type: "session.usage.updated", usage: { seconds: 12, active_seconds: 12 } }));
          ws.send(
            JSON.stringify({
              type: "session.usage.updated",
              usage: { seconds: 15, active_seconds: 11, paused_seconds: 4 },
              context_window: { usage_ratio: 0.1 },
            }),
          );
        }
        if (event["type"] === "session.close") {
          ws.send(
            JSON.stringify({
              type: "session.closed",
              reason: "close_requested",
              usage: { seconds: 20, active_seconds: 14, paused_seconds: 6 },
            }),
          );
          ws.close();
        }
      },
    },
  });
  const config = settings({ liveModel: "gpt-live-1.1", voice: "marin", dailyMinuteCap: 0.3 });
  const started = Promise.withResolvers<void>();
  const paused = Promise.withResolvers<void>();
  const usage = new (class extends VoiceUsage {
    override live(seconds: number, pausedSeconds = 0): void {
      super.live(seconds, pausedSeconds);
      if (pausedSeconds) paused.resolve();
    }
  })(temp.directory, config, () => 1000);
  const session = new VoiceSession(
    config,
    {
      now: () => 1000,
      key: "synthetic-no-paid-key",
      open: liveSocket(`ws://127.0.0.1:${server.port}/v1/live/sessions`),
      playback: new Playback(),
      replies: new Replies(temp.directory, () => {}),
      usage,
      tool: async () => ({ ok: true, result: "unused" }),
      log: () => {},
      started: () => started.resolve(),
      finished: async () => {},
    },
    false,
  );
  try {
    session.open();
    await started.promise;
    expect(received[0]).toMatchObject({
      type: "session.start",
      session: {
        model: "gpt-live-1.1",
        audio: { format: { type: "audio/pcm", rate: 24_000 }, output: { voice: "marin" } },
      },
    });
    expect(Object.keys(received[0]!["session"] as object)).not.toContain("wake_policy");
    expect(authorization).toBe("Bearer synthetic-no-paid-key");
    await paused.promise;
    // Cumulative usage is recorded once, not added per update.
    expect(Object.values(ledger(temp.directory).days)).toEqual([
      { liveSeconds: 15, pausedSeconds: 4, sessions: 1, backendUsd: 0 },
    ]);
    session.close("shutdown");
    await session.done;
    expect(session.failed).toBe(false);
    expect(Object.values(ledger(temp.directory).days)).toEqual([
      { liveSeconds: 20, pausedSeconds: 6, sessions: 1, backendUsd: 0 },
    ]);
    // Minute caps count all billed seconds, including the paused part (20 s >= 18 s cap).
    expect(usage.capReason()).toContain("Daily");
  } finally {
    if (session.state !== "closed") session.close("shutdown");
    server.stop(true);
    temp.cleanup();
  }
});

test("usage breakdown must add up to the billed total", () => {
  expect(
    parseLiveEvent({ type: "session.usage.updated", usage: { seconds: 9, active_seconds: 6, paused_seconds: 3 } }),
  ).toEqual({ type: "session.usage.updated", usage: { seconds: 9, active_seconds: 6, paused_seconds: 3 } });
  expect(parseLiveEvent({ type: "session.usage.updated", usage: { seconds: 9 } }).usage).toEqual({ seconds: 9 });
  for (const usage of [
    { seconds: 9, active_seconds: 6, paused_seconds: 4 },
    { seconds: 9, paused_seconds: 10 },
    { active_seconds: 6, paused_seconds: 3 },
    { seconds: 9, paused_seconds: -1 },
  ])
    expect(() => parseLiveEvent({ type: "session.usage.updated", usage })).toThrow();
});

test("ledgers without pausedSeconds still load; invalid paused values are refused, never reset", () => {
  const temp = temporaryVoice();
  try {
    const cfg = settings();
    const now = () => Date.parse("2026-11-20T00:00:00Z");
    const file = join(temp.directory, "usage.json");
    writeFileSync(file, '{"days":{"2026-11-20":{"liveSeconds":30,"sessions":1,"backendUsd":0}}}\n');
    const usage = new VoiceUsage(temp.directory, cfg, now);
    usage.live(5, 2);
    expect(ledger(temp.directory).days["2026-11-20"]).toEqual({
      liveSeconds: 35,
      pausedSeconds: 2,
      sessions: 1,
      backendUsd: 0,
    });
    expect(() => usage.live(1, -1)).toThrow("Invalid Live usage");
    writeFileSync(file, '{"days":{"2026-11-20":{"liveSeconds":30,"pausedSeconds":-1,"sessions":1,"backendUsd":0}}}');
    expect(() => new VoiceUsage(temp.directory, cfg, now)).toThrow("refusing to reset");
  } finally {
    temp.cleanup();
  }
});
