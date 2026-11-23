import { expect, test } from "bun:test";
import { discordInbound, formatDiscordInbound } from "../src/messenger/discord-inbound.ts";
import { toInbound } from "../src/messenger/discord-inbound-api.ts";
import { withDiscordCli } from "./discord-fakes.ts";
import { discordRestWorld, memoryDiscordCursor, ownerMessage } from "./discord-inbound-fakes.ts";

const url = "https://cdn.discordapp.com/attachments/20/500/file.pdf?ex=1&hm=signed-secret";
const attachment = { id: "500", filename: "file.pdf", size: 7, url };
const owner = (attachments: unknown = [attachment]) => ownerMessage("101", { content: "read this", attachments });
const record = (group: string): Record<string, unknown> => {
  const line = group.split("\n").find((value) => value.startsWith("INBOUND_ATTACHMENT discord 20 101 "));
  if (!line) throw new Error("attachment output is missing");
  return JSON.parse(line.slice("INBOUND_ATTACHMENT discord 20 101 ".length)) as Record<string, unknown>;
};

test("default consumers keep the exact signed URL and gain an additive original-route reference", () => {
  const inbound = toInbound(owner(), "99");
  // Existing consumers read attachments[].url or the same field in the JSON record.
  expect(inbound.attachments[0]?.url).toBe(url);
  expect(record(formatDiscordInbound(inbound))).toEqual({
    filename: "file.pdf",
    size: 7,
    url,
    id: "500",
    ref: "discord-file:99:10:20:101:500",
  });
  const privateRecord = record(formatDiscordInbound(inbound, true));
  expect(privateRecord).toEqual({ filename: "file.pdf", size: 7, id: "500", ref: "discord-file:99:10:20:101:500" });
  expect(formatDiscordInbound(inbound, true)).not.toContain("signed-secret");
  expect(inbound.attachments[0]?.url).toBe(url); // Formatting never mutates the shared admitted payload.
});

test.each([undefined, "invalid", "0500"])("legacy attachment id %p keeps its original default URL record", (id) => {
  const inbound = toInbound(owner([{ ...attachment, id }]), "99");
  expect(record(formatDiscordInbound(inbound))).toEqual({ filename: "file.pdf", size: 7, url });
  expect(() => formatDiscordInbound(inbound, true)).toThrow("no unique file reference");
});

test("duplicate resource IDs retain legacy URLs but cannot become ambiguous reference-only records", () => {
  const inbound = toInbound(owner([attachment, { ...attachment, filename: "second.pdf" }]), "99");
  expect(inbound.attachments.map((value) => value.url)).toEqual([url, url]);
  expect(inbound.attachments.every((value) => value.ref === undefined)).toBe(true);
  expect(() => formatDiscordInbound(inbound, true)).toThrow("no unique file reference");
});

test("a reference-only refusal keeps the cursor before the owner, and default output can still deliver it", async () => {
  const world = discordRestWorld([owner([{ filename: "file.pdf", size: 7, url }])]);
  const cursor = memoryDiscordCursor("100");
  const intake = await discordInbound(world.discord, () => cursor.store, { ownerId: "10", channelIds: ["20"] });
  const groups: string[] = [];
  await expect(intake.poll((message) => groups.push(formatDiscordInbound(message, true)))).rejects.toThrow(
    "no unique file reference",
  );
  expect([groups, cursor.saved, cursor.store.load()]).toEqual([[], [], "100"]);
  await intake.poll((message) => groups.push(formatDiscordInbound(message)));
  expect([groups.length, cursor.saved, cursor.store.load()]).toEqual([1, ["101"], "101"]);
  expect(record(groups[0]!)["url"]).toBe(url);
});

test("the Discord-only opt in is rejected before starting another platform", async () => {
  await withDiscordCli(async (f) => {
    for (const platform of ["telegram", "slack"]) {
      const r = await f.invoke(["inbound", platform, "--loop", "0", "--attachment-refs"]);
      expect([r.code, r.err, r.keys]).toEqual([1, "--attachment-refs is supported for discord only", []]);
    }
  });
});
