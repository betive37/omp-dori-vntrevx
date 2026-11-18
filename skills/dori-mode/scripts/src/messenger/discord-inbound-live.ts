import { discordGateway, type GatewayClock, type GatewaySocket } from "./discord-gateway.ts";
import { type Emit, isTransient, type Message } from "./discord-inbound-api.ts";
import type { DiscordInboundQueue } from "./discord-inbound-queue.ts";

const GUILD_MESSAGES = 1 << 9;
const DIRECT_MESSAGES = 1 << 12;
const MESSAGE_CONTENT = 1 << 15; // Privileged: enable it for the bot in the Developer Portal.

type Intake = {
  accepts(message: Message): boolean;
  sync(emit: Emit): Promise<void>;
  accept(message: Message, emit: Emit): void | Promise<void>;
};

/**
 * Live owner messages over the Gateway, with the REST history path as backfill. Every (re)connect first reads each
 * watched channel from its cursor; dispatches and backfills run on one queue, so a message that arrives both ways
 * is delivered once (the cursor rejects the second copy) and a channel's messages stay in ascending order.
 */
export const discordInboundLive = (
  intake: Intake,
  open: (url: string) => GatewaySocket,
  token: string,
  clock: GatewayClock,
  emit: Emit,
  report: (line: string) => void,
  queue: DiscordInboundQueue,
) => {
  let running = Promise.resolve();
  let draining = false;
  let failure: unknown;
  let dead = false;
  let timer: unknown;
  let wake: (() => void) | undefined;
  const pause = (ms: number) =>
    new Promise<void>((resolve) => {
      wake = resolve;
      timer = clock.setTimeout(resolve, ms);
    });
  /** Dispatches queue behind this: delivering one before the gap is read would move the cursor past it. */
  const backfill = async () => {
    for (let delay = 2_000; ; delay = Math.min(delay * 2, 30_000)) {
      try {
        return await intake.sync(emit);
      } catch (error) {
        if (dead || !isTransient(error)) throw error;
        report(`DISCORD_GATEWAY_BACKFILL_RETRY discord retry_in=${delay / 1000}s`);
        await pause(delay);
        if (dead) return;
      }
    }
  };
  const fail = (error: unknown) => {
    failure = error;
    dead = true; // Leave the failed record and every successor on disk, without advancing their cursors.
    gateway.close();
  };
  const drain = () => {
    if (draining || dead) return;
    draining = true;
    running = (async () => {
      try {
        for (let job = queue.first(); job && !dead; job = queue.first()) {
          if (job.kind === "sync") await backfill();
          else await intake.accept(JSON.parse(job.payload) as Message, emit);
          if (!dead) queue.remove(job.id);
        }
      } catch (error) {
        fail(error);
      } finally {
        draining = false;
      }
    })();
  };
  const enqueue = (kind: "sync" | "message", data?: unknown) => {
    if (dead) return;
    try {
      queue.push(kind, data);
      drain();
    } catch (error) {
      fail(error);
    }
  };
  const gateway = discordGateway(open, token, clock, report, {
    label: "DISCORD_GATEWAY",
    intents: GUILD_MESSAGES | DIRECT_MESSAGES | MESSAGE_CONTENT,
    online: false,
    onReady: () => enqueue("sync"),
    onDispatch: (type, data) => {
      if (type === "MESSAGE_CREATE" && intake.accepts(data as Message)) enqueue("message", data);
    },
  });
  const close = () => {
    dead = true;
    if (timer !== undefined) clock.clearTimeout(timer);
    wake?.();
    gateway.close();
  };
  const done = gateway.done.finally(async () => {
    close();
    await running; // An in-flight REST read may finish delivery; pending records remain for the next start.
    if (failure !== undefined) throw failure;
  });
  drain();
  return { done, close };
};
