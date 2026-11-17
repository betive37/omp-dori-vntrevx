/**
 * The Discord side of a voice conversation over the existing Gateway client: owner presence from GUILD_CREATE and
 * VOICE_STATE_UPDATE, the bot's own voice updates handed to the voice library, one connection at a time, and the
 * original recovery: a connection that stays disconnected for 5 s is replaced 3 s later. No connection becoming ready
 * within 30 s of a join, rejoins included, ends the bridge with an error instead of retrying further.
 */
import type { Discord } from "../messenger/discord.ts";
import { discordGateway, type GatewayClock, type GatewaySocket } from "../messenger/discord-gateway.ts";
import type { Playback } from "./audio.ts";
import {
  type AdapterMethods,
  playbackSource,
  type VoiceDispatch,
  type VoiceDriver,
  type VoiceLink,
} from "./discord-link.ts";
import { ownerReceiver, watchDave } from "./discord-receive.ts";

const GUILDS = 1 << 0;
const GUILD_VOICE_STATES = 1 << 7;
const GUILD_VOICE = 2;

export type VoiceTarget = {
  token: string;
  ownerId: string;
  channelId: string;
  guildId: string;
  botId: string;
  playback: Playback;
  onOwnerPresence(present: boolean): void;
  onPcm(pcm: Buffer): void;
  log(line: string): void;
};
export type VoiceRuntime = { driver: VoiceDriver; open: (url: string) => GatewaySocket; clock: GatewayClock };

const record = (value: unknown): VoiceDispatch | undefined =>
  value && typeof value === "object" && !Array.isArray(value) ? (value as VoiceDispatch) : undefined;

/** The guild of a configured voice channel and the bot's own user id, read over REST. */
export const voiceIds = async (discord: Discord, channelId: string): Promise<{ guildId: string; botId: string }> => {
  const channel = record(await discord.call("GET", `/channels/${channelId}`));
  const guildId = channel?.["guild_id"];
  if (channel?.["type"] !== GUILD_VOICE || typeof guildId !== "string") {
    throw new Error(`Discord channel ${channelId} is not a guild voice channel`);
  }
  const botId = record(await discord.call("GET", "/users/@me"))?.["id"];
  if (typeof botId !== "string") throw new Error("Discord did not return the bot user id");
  return { guildId, botId };
};

export const startDiscordVoice = (t: VoiceTarget, rt: VoiceRuntime): { done: Promise<void>; close(): void } => {
  const { clock, driver } = rt;
  const done = Promise.withResolvers<void>();
  let stopped = false;
  let link: VoiceLink | undefined;
  let adapter: AdapterMethods | undefined;
  let dave: { stop(): void } | undefined;
  let ownerPresent = false;
  let observedOwner = false;
  let observedBot = false;
  t.playback.audible = false;
  let readyTimer: unknown;
  let recoverTimer: unknown;
  let rejoinTimer: unknown;
  const cancel = (timer: unknown) => {
    clock.clearTimeout(timer);
  };

  const receiver = ownerReceiver({
    ownerId: t.ownerId,
    clock,
    codec: () => driver.codec(),
    onPcm: t.onPcm,
    log: t.log,
  });
  const source = playbackSource(t.playback, driver.codec());
  driver.play(source, t.log);

  const setPresence = (present: boolean) => {
    if (stopped || present === ownerPresent) return;
    ownerPresent = present;
    t.log(present ? "OWNER in channel" : "OWNER left channel");
    receiver.presence(present);
    t.onOwnerPresence(present);
  };

  const teardown = () => {
    const previous = link;
    link = undefined;
    adapter = undefined;
    cancel(recoverTimer);
    recoverTimer = undefined;
    receiver.attach(undefined);
    dave?.stop();
    dave = undefined;
    previous?.destroy();
  };

  const finish = (error?: Error) => {
    if (stopped) return;
    setPresence(false);
    t.playback.audible = false;
    t.playback.clear();
    stopped = true;
    if (error) t.log(`VOICE STOPPED ${error.message}`);
    cancel(rejoinTimer);
    cancel(readyTimer);
    rejoinTimer = readyTimer = undefined;
    teardown(); // Leaves the channel while the Gateway can still carry the request.
    receiver.stop();
    driver.stop();
    source.destroy();
    gateway.close();
    if (error) done.reject(error);
    else done.resolve();
  };

  const onStatus = (current: VoiceLink, to: string) => {
    if (current !== link) return;
    t.playback.audible = to === "ready" && observedBot;
    if (to !== "ready") {
      t.playback.clear();
      receiver.attach(undefined);
      // One deadline covers every recovery transition, including the SDK's internal reconnects.
      readyTimer ??= clock.setTimeout(() => {
        readyTimer = undefined;
        finish(new Error("voice connection was not ready within 30s"));
      }, 30_000);
    }
    if (to === "ready") {
      cancel(readyTimer);
      readyTimer = undefined;
      current.attach(); // Idempotent in the library: an existing player subscription is reused.
      receiver.attach(current);
      setPresence(observedOwner && observedBot);
    }
    if (to === "signalling" || to === "connecting" || to === "ready") {
      cancel(recoverTimer);
      recoverTimer = undefined;
    } else if (to === "disconnected" && recoverTimer === undefined) {
      recoverTimer = clock.setTimeout(() => {
        recoverTimer = undefined;
        if (current !== link) return;
        t.log("VOICE disconnected for good; rejoining");
        setPresence(false);
        teardown();
        rejoinTimer = clock.setTimeout(() => {
          rejoinTimer = undefined;
          join();
        }, 3_000);
      }, 5_000);
    }
  };

  const join = () => {
    if (stopped || link) return;
    const current = driver.join({
      guildId: t.guildId,
      channelId: t.channelId,
      adapter: (methods) => {
        adapter = methods;
        return {
          sendPayload: (payload) => gateway.send(payload),
          destroy: () => {
            if (adapter === methods) adapter = undefined;
          },
        };
      },
    });
    link = current;
    current.onStatus((from, to) => {
      // The library also emits same-status changes, e.g. when attach() stores the player subscription; reacting to
      // those would re-enter attach() without end.
      if (current !== link || from === to) return;
      t.log(`VOICE ${from} -> ${to}`);
      onStatus(current, to);
    });
    current.onError((message) => t.log(`VOICE ERROR ${message}`));
    dave = watchDave(current, { ownerId: t.ownerId, ownerPresent: () => ownerPresent, clock, log: t.log });
    // A join request that could not be sent leaves the connection disconnected before the listener existed.
    onStatus(current, current.status());
  };

  const onDispatch = (type: string, raw: unknown) => {
    const data = record(raw);
    if (stopped || !data) return;
    if (type === "GUILD_CREATE" && data["id"] === t.guildId) {
      const states: unknown[] = Array.isArray(data["voice_states"]) ? data["voice_states"] : [];
      const owner = states.map(record).find((state) => state?.["user_id"] === t.ownerId);
      observedOwner = owner?.["channel_id"] === t.channelId;
      setPresence(observedOwner && observedBot && link?.status() === "ready");
    } else if (type === "VOICE_STATE_UPDATE" && data["guild_id"] === t.guildId) {
      if (data["user_id"] === t.ownerId) {
        observedOwner = data["channel_id"] === t.channelId;
        setPresence(observedOwner && observedBot && link?.status() === "ready");
      } else if (data["user_id"] === t.botId) {
        if (data["channel_id"] !== t.channelId && data["channel_id"] !== null) {
          finish(new Error("bot moved outside the configured voice channel"));
          return;
        }
        observedBot = data["channel_id"] === t.channelId;
        if (!observedBot) {
          setPresence(false);
          t.playback.audible = false;
          t.playback.clear();
        }
        adapter?.onVoiceStateUpdate(data);
      }
    } else if (type === "VOICE_SERVER_UPDATE" && data["guild_id"] === t.guildId) {
      adapter?.onVoiceServerUpdate(data);
    }
  };

  const gateway = discordGateway(rt.open, t.token, clock, t.log, {
    label: "VOICE_GATEWAY",
    intents: GUILDS | GUILD_VOICE_STATES,
    online: false,
    onReady: () => {
      try {
        if (!link && rejoinTimer === undefined) join();
      } catch {
        finish(new Error("Discord voice join failed"));
      }
    },
    onDispatch: (type, data) => {
      try {
        onDispatch(type, data);
      } catch {
        finish(new Error("Invalid Discord voice event"));
      }
    },
  });
  gateway.done.then(
    () => finish(new Error("Discord Gateway stopped")),
    (error: unknown) => finish(error instanceof Error ? error : new Error(String(error))),
  );

  return { done: done.promise, close: () => finish() };
};
