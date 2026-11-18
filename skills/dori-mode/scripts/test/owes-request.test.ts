import { expect, test } from "bun:test";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { openOwes, recordMark, recordOwes } from "../src/owes.ts";
import { ids, withDiscordCli } from "./discord-fakes.ts";

const inbound = (message: string) => `INBOUND discord ${ids.thread} ${message} from=owner ref=- "request"`;
const longAnswer = "verified result\n".repeat(300);

test("legacy, malformed and foreign-request receipts never settle an owe", async () => {
  await withDiscordCli(async (f) => {
    const state = dirname(f.tmp);
    const at = Date.now() - 100;
    recordOwes(state, inbound(ids.message), at);
    recordMark(state, ids.thread, ids.message, at + 1);
    const valid = {
      deliveryId: `discord:${ids.thread}:71`,
      requestId: `${ids.thread}:${ids.message}`,
      channel: ids.thread,
      remoteIds: ["71", "72"],
      at: at + 2,
    };
    for (const receipt of [
      { channel: ids.thread, at: at + 2 },
      { ...valid, deliveryId: "another-delivery" },
      { ...valid, requestId: `${ids.thread}:99` },
      { ...valid, requestId: 123 },
      { ...valid, channel: ids.text },
      { ...valid, remoteIds: [] },
      { ...valid, remoteIds: ["71", null] },
      { ...valid, remoteIds: ["71", "71"] },
      { ...valid, at: at - 1 },
    ]) {
      writeFileSync(join(state, "owes", "sent.jsonl"), `${JSON.stringify(receipt)}\n`);
      expect(openOwes(state, Date.now()).map((owe) => owe.message)).toEqual([ids.message]);
    }
    writeFileSync(join(state, "owes", "sent.jsonl"), `${JSON.stringify(valid)}\n`);
    expect(openOwes(state, Date.now())).toEqual([]);
  });
});

test("an accepted response without a remote message ID remains uncertain", async () => {
  await withDiscordCli(async (f) => {
    const state = dirname(f.tmp);
    recordOwes(state, inbound(ids.message), Date.now() - 100);
    recordMark(state, ids.thread, ids.message, Date.now() - 1);
    const result = await f.invoke(
      ["send", "discord", "--thread", ids.thread, "--reply", ids.message, "--text", "answer"],
      { routes: { [`POST /channels/${ids.thread}/messages`]: { body: {} } } },
    );
    expect([result.code, result.out, result.err]).toEqual([
      1,
      "",
      "discord send: incomplete delivery receipt; outcome uncertain",
    ]);
    expect(openOwes(state, Date.now()).map((owe) => owe.message)).toEqual([ids.message]);
    expect(existsSync(join(state, "owes", "sent.jsonl"))).toBe(false);
  });
}, 60_000);

test("a complete split reply settles only its exact request and retains every remote ID", async () => {
  await withDiscordCli(async (f) => {
    const state = dirname(f.tmp);
    const at = Date.now() - 100;
    for (const message of [ids.message, "99"]) {
      recordOwes(state, inbound(message), at);
      recordMark(state, ids.thread, message, at + 1);
    }
    const result = await f.invoke(
      ["send", "discord", "--thread", ids.thread, "--reply", ids.message, "--text", longAnswer],
      {
        routes: {
          [`POST /channels/${ids.thread}/messages`]: {
            sequence: ["71", "72", "73"].map((id) => ({ body: { id } })),
          },
        },
      },
    );
    expect([result.code, result.err, result.out]).toEqual([0, "", "SENT 71 72 73"]);
    expect(openOwes(state, Date.now()).map((owe) => owe.message)).toEqual(["99"]);
    const receipt = JSON.parse(readFileSync(join(state, "owes", "sent.jsonl"), "utf8").trim());
    expect(receipt).toMatchObject({
      deliveryId: `discord:${ids.thread}:71`,
      requestId: `${ids.thread}:${ids.message}`,
      channel: ids.thread,
      remoteIds: ["71", "72", "73"],
    });
  });
}, 60_000);

test("an unlinked post and a reaction do not answer an existing request", async () => {
  await withDiscordCli(async (f) => {
    const state = dirname(f.tmp);
    recordOwes(state, inbound(ids.message), Date.now() - 100);
    const reaction = await f.invoke(["react", "discord", "--thread", ids.thread, "--message", ids.message]);
    expect(reaction.code).toBe(0);
    const posted = await f.invoke(["send", "discord", "--thread", ids.thread, "--text", "unrelated update"]);
    expect(posted.code).toBe(0);
    expect(openOwes(state, Date.now()).map((owe) => owe.message)).toEqual([ids.message]);
    expect(existsSync(join(state, "owes", "sent.jsonl"))).toBe(false);
  });
}, 60_000);

test("a partially accepted reply never produces a complete delivery receipt", async () => {
  await withDiscordCli(async (f) => {
    const state = dirname(f.tmp);
    const at = Date.now() - 100;
    recordOwes(state, inbound(ids.message), at);
    recordMark(state, ids.thread, ids.message, at + 1);
    for (const failure of [{ status: 403, body: { message: "Denied" } }, { failure: "fetch" as const }]) {
      const result = await f.invoke(
        ["send", "discord", "--thread", ids.thread, "--reply", ids.message, "--text", longAnswer],
        {
          routes: {
            [`POST /channels/${ids.thread}/messages`]: {
              sequence: [{ body: { id: "71" } }, failure],
            },
          },
        },
      );
      expect(result.code).toBe(1);
      expect(result.err).toContain("already posted: 71");
      expect(openOwes(state, Date.now()).map((owe) => owe.message)).toEqual([ids.message]);
      expect(existsSync(join(state, "owes", "sent.jsonl"))).toBe(false);
    }
  });
}, 60_000);
