import { type Command, die } from "./cli-context.ts";
import { channelOf, discordClient } from "./cli-discord-ops.ts";
import { type DcChannel, type Discord, isThreadType } from "./messenger/discord.ts";
import { ChannelPurposeError, DiscordChannels, type PurposeSource, purposeText } from "./messenger/discord-channels.ts";
import { inboundRequest, isOwnerMessage, type Message } from "./messenger/discord-inbound-api.ts";
import { discordInboundOptions } from "./messenger/discord-inbound-env.ts";
import { discordInboundEnv, isDiscordSnowflake } from "./messenger/discord-inbound-state.ts";

/** Manual notes remain available; --source restricts an invocation to its verified original conversation. */
export const channelDiscord: Command = async ({ positionals, opt, values, config }) => {
  const action = positionals[1];
  if (action !== "set" && action !== "clear" && action !== "list")
    return die("channel discord needs set, clear or list");
  const raw = positionals[2];
  if (action !== "list" && raw === undefined) die(`channel discord ${action} needs a channel or thread`);
  const purpose = action === "set" ? purposeText(opt("purpose") ?? "") : undefined;
  const store = new DiscordChannels(config.stateDir);
  let origin:
    | {
        client: Discord;
        channel: DcChannel;
        parent: string | undefined;
        identity: PurposeSource;
      }
    | undefined;
  const source = values["source"];
  if (source !== undefined) {
    const invalid = () => new ChannelPurposeError('--source must be "discord CHANNEL MESSAGE" with Discord IDs');
    if (typeof source !== "string") throw invalid();
    const match = /^discord ([1-9][0-9]*) ([1-9][0-9]*)$/.exec(source);
    const channelId = match?.[1];
    const messageId = match?.[2];
    if (match?.[0] !== source || !isDiscordSnowflake(channelId) || !isDiscordSnowflake(messageId)) throw invalid();
    if (action === "list" ? raw !== undefined : !isDiscordSnowflake(raw))
      throw new ChannelPurposeError("source-bound purpose targets must use Discord IDs; list takes no target");
    const options = discordInboundOptions();
    const client = discordClient();
    const request = inboundRequest(client);
    const me = await request<{ id?: unknown } | null>("/users/@me");
    const botId = me?.id;
    if (!isDiscordSnowflake(botId)) throw new ChannelPurposeError("Discord purpose source bot identity is invalid");
    const channel = await request<DcChannel>(`/channels/${channelId}`);
    if (!channel || channel.id !== channelId || !Number.isInteger(channel.type))
      throw new ChannelPurposeError("Discord purpose source channel identity is invalid");
    let parent: string | undefined;
    if (isThreadType(channel.type)) {
      if (!isDiscordSnowflake(channel.parent_id))
        throw new ChannelPurposeError("Discord purpose source parent is invalid");
      parent = channel.parent_id;
    }
    if (
      !options.all &&
      !options.channelIds.includes(channelId) &&
      !(options.threads !== false && parent !== undefined && options.channelIds.includes(parent))
    )
      throw new ChannelPurposeError("original source is outside the current Discord inbound scope");
    const message = await request<Message>(`/channels/${channelId}/messages/${messageId}`);
    if (
      !message ||
      message.id !== messageId ||
      message.channel_id !== channelId ||
      !isOwnerMessage(message, options.ownerId, botId)
    )
      throw new ChannelPurposeError("Discord purpose source is not the exact owner message");
    origin = { client, channel, parent, identity: { botId, ownerId: options.ownerId, channelId, messageId } };
  }
  const related = (id: string) => origin === undefined || id === origin.channel.id || id === origin.parent;
  if (action === "list") {
    for (const [id, entry] of Object.entries(store.read())) {
      if (!related(id)) continue;
      console.log(
        `CHANNEL ${id} name=${JSON.stringify(entry.name ?? "")} purpose=${JSON.stringify(entry.purpose)} updated=${entry.updatedAt}`,
      );
    }
    return;
  }
  // The non-list destination was required above, before any source lookup.
  const target = raw!;
  if (!related(target)) throw new ChannelPurposeError("purpose destination is unrelated to the original source");
  if (action === "clear") {
    // Manual clear by ID still works without credentials, including deleted channels.
    const id = /^\d+$/.test(target)
      ? discordInboundEnv("channel", target)
      : (await channelOf(discordClient(), target)).id;
    console.log(`${(await store.clear(id, origin?.identity)) ? "PURPOSE_CLEARED" : "PURPOSE_NONE"} ${id}`);
    return;
  }
  const channel =
    origin?.channel.id === target
      ? origin.channel
      : origin !== undefined
        ? await inboundRequest(origin.client)<DcChannel>(`/channels/${target}`)
        : await channelOf(discordClient(), target);
  if (!channel || (isDiscordSnowflake(target) && channel.id !== target))
    throw new ChannelPurposeError("Discord purpose destination identity is invalid");
  const name = typeof channel.name === "string" ? channel.name : undefined;
  const entry = await store.set(channel.id, purpose!, name, Date.now(), origin?.identity);
  console.log(`PURPOSE ${channel.id} ${JSON.stringify(entry.purpose)}`);
};
