/**
 * Joins the configured Discord voice channel for the owner. The optional native dependencies (@discordjs/voice,
 * @discordjs/opus and the DAVE library it loads) are imported only when a connection is started, so importing this
 * module costs nothing on installs without voice.
 */
import type * as Voice from "@discordjs/voice";
import { discordClock, openDiscordSocket } from "../cli-discord.ts";
import type { Discord } from "../messenger/discord.ts";
import type { Playback } from "./audio.ts";
import type { VoiceDriver, VoiceLink } from "./discord-link.ts";
import { voiceServerUpdate, voiceStateUpdate } from "./discord-events.ts";
import { startDiscordVoice, voiceIds } from "./discord-session.ts";

const nativeLink = (
  voice: typeof Voice,
  connection: Voice.VoiceConnection,
  player: () => Voice.AudioPlayer | undefined,
): VoiceLink => ({
  status: () => connection.state.status,
  onStatus: (cb) => {
    connection.on("stateChange", (from, to) => cb(from.status, to.status));
  },
  onDebug: (cb) => {
    connection.on("debug", cb);
  },
  onError: (cb) => {
    connection.on("error", (error) => cb(error.message));
  },
  dave: () => {
    const state = connection.state;
    if (!("networking" in state)) return undefined;
    const networking = state.networking.state;
    return "dave" in networking ? networking.dave?.session : undefined;
  },
  attach: () => {
    const current = player();
    if (current) connection.subscribe(current);
  },
  destroy: () => {
    if (connection.state.status !== voice.VoiceConnectionStatus.Destroyed) connection.destroy();
  },
  subscribed: (userId) => connection.receiver.subscriptions.has(userId),
  speaking: (userId) => connection.receiver.speaking.users.has(userId),
  receive: (userId) => {
    const stream = connection.receiver.subscribe(userId, { end: { behavior: voice.EndBehaviorType.Manual } });
    return {
      onData: (cb) => {
        stream.on("data", cb);
      },
      onError: (cb) => {
        stream.on("error", (error) => cb(error.message));
      },
      onClose: (cb) => {
        stream.on("close", cb);
      },
      destroy: () => {
        stream.destroy();
      },
    };
  },
});

const nativeDriver = async (): Promise<VoiceDriver> => {
  // Dynamic on purpose: these are optional native dependencies, absent or unloadable where voice is not used.
  const voice = await import("@discordjs/voice");
  const { OpusEncoder } = await import("@discordjs/opus");
  let player: Voice.AudioPlayer | undefined;
  return {
    codec: () => new OpusEncoder(48_000, 2),
    play: (source, log) => {
      // Playing with no subscriber keeps the queue draining in real time while the connection is being replaced.
      player = voice.createAudioPlayer({
        behaviors: { noSubscriber: voice.NoSubscriberBehavior.Play, maxMissedFrames: Number.POSITIVE_INFINITY },
      });
      player.on("error", (error) => log(`PLAYER ERROR ${error.message}`));
      player.on("stateChange", (from, to) => log(`PLAYER ${from.status} -> ${to.status}`));
      player.play(voice.createAudioResource(source, { inputType: voice.StreamType.Opus }));
    },
    join: ({ guildId, channelId, adapter }) => {
      const connection = voice.joinVoiceChannel({
        guildId,
        channelId,
        selfDeaf: false,
        selfMute: false,
        debug: true,
        // Past this many consecutive failures the library throws, which kills the receive stream; with transition
        // id 0 its recovery path is skipped (falsy id). Undecryptable packets are dropped and counted instead.
        decryptionFailureTolerance: 1_000_000,
        adapterCreator: (methods) =>
          adapter({
            // The bridge forwards only this guild's VOICE_SERVER_UPDATE and the bot's own VOICE_STATE_UPDATE.
            onVoiceServerUpdate: (data) => methods.onVoiceServerUpdate(voiceServerUpdate(data)),
            onVoiceStateUpdate: (data) => methods.onVoiceStateUpdate(voiceStateUpdate(data)),
          }),
      });
      return nativeLink(voice, connection, () => player);
    },
    stop: () => {
      player?.stop(true);
    },
  };
};

export const connectDiscordVoice = async (options: {
  discord: Discord;
  token: string;
  ownerId: string;
  channelId: string;
  playback: Playback;
  onOwnerPresence(present: boolean): void;
  onPcm(pcm: Buffer): void;
  log(line: string): void;
}): Promise<{ done: Promise<void>; close(): void }> => {
  const driver = await nativeDriver();
  const ids = await voiceIds(options.discord, options.channelId);
  return startDiscordVoice(
    {
      token: options.token,
      ownerId: options.ownerId,
      channelId: options.channelId,
      ...ids,
      playback: options.playback,
      onOwnerPresence: options.onOwnerPresence,
      onPcm: options.onPcm,
      log: options.log,
    },
    { driver, open: openDiscordSocket, clock: discordClock },
  );
};
