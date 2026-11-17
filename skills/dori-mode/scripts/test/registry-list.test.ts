import { afterEach, beforeEach, expect, spyOn, test } from "bun:test";
import { rmSync, writeFileSync } from "node:fs";
import { type Lane, Registry, statusOf } from "../src/registry.ts";
import { withState } from "./fakes.ts";

let state: ReturnType<typeof withState>;
beforeEach(() => {
  state = withState();
});
afterEach(() => state.done());

const lane = (key: string, patch: Partial<Lane> = {}): Lane => ({
  key,
  title: key,
  thread: "none",
  brief: "/b.md",
  done: "closed acme/app#1",
  openedAt: "2026-01-01T00:00:00.000Z",
  ...patch,
});

test("a listing registry parses a closed record again only after a write, from any writer; open records every time", async () => {
  // Given three records and a watcher that keeps one Registry across ticks.
  const writer = new Registry(state.dir);
  for (const key of ["a-lane", "b-lane", "c-lane"]) await writer.write(lane(key, { closedAt: "2026-01-02T00:00:00Z" }));
  const watcher = new Registry(state.dir);
  // Every parse reads the record by its key's path, so the path lookups count the parses.
  const reads = spyOn(watcher, "path");
  try {
    const listed = async (): Promise<{ statuses: string[]; parsed: number }> => {
      reads.mockClear();
      const lanes = await watcher.list();
      return { statuses: lanes.map((l) => `${l.key}:${statusOf(l)}`).sort(), parsed: reads.mock.calls.length };
    };
    expect((await listed()).parsed).toBe(3);
    // When nothing changed, the next tick parses none of the closed records.
    expect(await listed()).toEqual({ statuses: ["a-lane:closed", "b-lane:closed", "c-lane:closed"], parsed: 0 });
    // A record renamed into place by another writer is parsed again, and only that one.
    await writer.write(lane("b-lane", { status: "done-claimed" }));
    expect(await listed()).toEqual({ statuses: ["a-lane:closed", "b-lane:done-claimed", "c-lane:closed"], parsed: 1 });
    // An open record, which the loops act on, is read on every list.
    expect((await listed()).parsed).toBe(1);
    // A record rewritten in place (same inode) and a removed record are seen too.
    writeFileSync(writer.path("a-lane"), JSON.stringify(lane("a-lane", { status: "paused" })));
    rmSync(writer.path("c-lane"));
    expect(await listed()).toEqual({ statuses: ["a-lane:paused", "b-lane:done-claimed"], parsed: 2 });
  } finally {
    reads.mockRestore();
  }
});
