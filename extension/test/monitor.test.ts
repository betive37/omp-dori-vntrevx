import { beforeEach, describe, expect, test } from "bun:test";
import { join } from "node:path";

import { Monitors } from "../monitor";
import { type FakePi, load, until, useConfig } from "./fake-pi";

const alive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

const collect = (): { messages: string[]; monitors: Monitors; current: { session: string } } => {
  const messages: string[] = [];
  const current = { session: "s1" };
  return {
    messages,
    current,
    monitors: new Monitors(
      (content) => messages.push(content),
      () => current.session,
      100,
    ),
  };
};

describe("Monitors", () => {
  test("drops lines when the session has changed since the monitor started", async () => {
    const { messages, monitors, current } = collect();
    monitors.start("stale", ["sh", "-c", "echo hit; exec sleep 30"], ".", "/", "s1");
    current.session = "s2";
    const { pid } = monitors.start("fresh", ["sh", "-c", "echo hit; exec sleep 30"], ".", "/", "s2");
    await until(() => messages.length > 0);
    expect(messages).toEqual(["[fresh] hit"]);
    monitors.stopAll();
    await until(() => !alive(pid));
  });

  test("delivers only matching stdout/stderr lines, a burst as one message, then the exit", async () => {
    const { messages, monitors } = collect();
    monitors.start(
      "inbox",
      ["sh", "-c", "echo 'msg 1'; echo noise; echo 'msg 2' >&2; echo 'msg 3'"],
      "^msg",
      "/",
      "s1",
    );
    await until(() => messages.join("\n").includes("exited"));
    const lines = messages.join("\n").split("\n");
    expect(lines.filter((line) => !line.includes("exited")).sort()).toEqual([
      "[inbox] msg 1",
      "[inbox] msg 2",
      "[inbox] msg 3",
    ]);
    expect(messages[0]?.split("\n").length).toBeGreaterThanOrEqual(3);
    expect(lines.at(-1)).toBe(
      "[inbox] monitor exited (code 0): sh -c echo 'msg 1'; echo noise; echo 'msg 2' >&2; echo 'msg 3'",
    );
    expect(monitors.list()).toEqual([]);
  });

  test("lines far apart arrive as separate messages", async () => {
    const { messages, monitors } = collect();
    // the gap is produced by a real child process, which fake timers cannot drive
    monitors.start("slow", ["sh", "-c", "echo a; sleep 0.4; echo b; exec sleep 5"], ".", "/", "s1");
    await until(() => messages.length >= 2);
    expect(messages).toEqual(["[slow] a", "[slow] b"]);
    monitors.stopAll();
  });

  test("reports a monitor that dies with its exit code", async () => {
    const { messages, monitors } = collect();
    monitors.start("watch", ["sh", "-c", "exit 3"], ".", "/", "s1");
    await until(() => messages.length > 0);
    expect(messages).toEqual(["[watch] monitor exited (code 3): sh -c exit 3"]);
  });

  test("rejects a duplicate name and stops without an exit report", async () => {
    const { messages, monitors } = collect();
    const { pid } = monitors.start("dup", ["sleep", "30"], ".", "/", "s1");
    expect(() => monitors.start("dup", ["sleep", "30"], ".", "/", "s1")).toThrow('monitor "dup" is already running');
    expect(monitors.list().map((m) => m.name)).toEqual(["dup"]);
    expect(monitors.stop("dup")).toBe(true);
    await until(() => !alive(pid));
    // asserting that no exit report arrives: wait past the 100ms batch window of the real child process
    await Bun.sleep(150);
    expect(messages).toEqual([]);
    expect(monitors.stop("dup")).toBe(false);
  });

  test("a batch of notices is delivered without waking; any other line or an exit wakes", async () => {
    const batches: Array<{ content: string; wake: boolean }> = [];
    const monitors = new Monitors(
      (content, wake) => batches.push({ content, wake }),
      () => "s1",
      100,
    );
    const notices = ["LANE_WATCH_READY", "NUDGED a-lane 16 min silent, delivery delivered", "PENDING-REPORT a-lane x"];
    const { pid } = monitors.start(
      "notes",
      ["sh", "-c", `${notices.map((line) => `echo '${line}'`).join("; ")}; exec sleep 30`],
      ".",
      "/",
      "s1",
    );
    await until(() => batches.flatMap((b) => b.content.split("\n")).length === notices.length);
    expect(batches.every((b) => !b.wake)).toBe(true);
    monitors.stop("notes");
    await until(() => !alive(pid));
    batches.length = 0;
    // INBOUND_READY, a stall, HOST_GUARD COMPUTE_READY and a nudge that did not land wake even beside a notice, while
    // the monitor is still running.
    for (const line of [
      "INBOUND_READY discord owner=1",
      "STALLED a-lane idle",
      "HOST_GUARD COMPUTE_READY load 1 < 2",
      "NUDGED a-lane 16 min silent, delivery failed",
      "NUDGED a-lane 16 min silent, delivery unconfirmed",
      // Freshness prints POSTED whatever the thread hook's exit status was.
      "POSTED a-lane Progress (from the lane's last report): x",
      // A silent lane with nothing to post leaves its thread without an update: the lead is told, as before.
      "NO-REPORT a-lane report journal has no report",
      // So does one whose last report was already posted: the thread still has nothing new.
      "STALE-REPORT a-lane the last [REPORT] line was already posted",
    ]) {
      const running = monitors.start(
        "mixed",
        ["sh", "-c", `echo 'PENDING-REPORT a-lane x'; echo "${line}"; exec sleep 30`],
        ".",
        "/",
        "s1",
      );
      await until(() => batches.flatMap((b) => b.content.split("\n")).length === 2);
      expect(batches.map((b) => b.wake)).toEqual([true]);
      expect(batches[0]?.content).toContain(line);
      monitors.stop("mixed");
      await until(() => !alive(running.pid));
      batches.length = 0;
    }
    // A monitor's own exit wakes even after only notices.
    monitors.start("ends", ["sh", "-c", "echo 'PENDING-REPORT a-lane x'"], ".", "/", "s1");
    await until(() => batches.some((b) => b.content.includes("exited")));
    expect(batches.find((b) => b.content.includes("exited"))?.wake).toBe(true);
  });

  test("rejects an invalid filter before spawning", () => {
    const { monitors } = collect();
    expect(() => monitors.start("bad", ["sleep", "30"], "(", "/", "s1")).toThrow();
    expect(monitors.list()).toEqual([]);
  });
});

describe("monitor tool", () => {
  let dori: FakePi;
  beforeEach(async () => {
    useConfig(join(import.meta.dir, "fake-ulw.ts"));
    dori = await load({ session: { id: "dori", entries: [] }, flags: { "dori-role": "dori" } });
    await dori.emit("session_start");
  });

  const run = (pi: FakePi, params: Record<string, unknown>) =>
    pi.tools.get("monitor")?.execute("call", params, undefined, undefined, pi.ctx());

  test("wakes the Dori session with an aside message and stops every monitor at session shutdown", async () => {
    await run(dori, { op: "start", name: "inbox", argv: ["sh", "-c", "echo 'msg hi'; exec sleep 30"], filter: "^msg" });
    await until(() => dori.messages.length > 0);
    expect(dori.messages).toEqual([{ content: "[inbox] msg hi", options: { triggerTurn: true, deliverAs: "aside" } }]);
    const listed = await run(dori, { op: "list" });
    const pid = Number(/pid (\d+)/.exec(listed?.content[0]?.text ?? "")?.[1]);
    expect(alive(pid)).toBe(true);

    await dori.emit("session_shutdown");
    await until(() => !alive(pid));
    expect((await run(dori, { op: "list" }))?.content[0]?.text).toBe("no monitors running");
  });

  test("a notice is recorded for the next turn without starting one", async () => {
    await run(dori, {
      op: "start",
      name: "fresh",
      argv: ["sh", "-c", "echo 'NUDGED a-lane 16 min silent, delivery delivered'; exec sleep 30"],
      filter: ".",
    });
    await until(() => dori.messages.length > 0);
    expect(dori.messages).toEqual([
      {
        content: "[fresh] NUDGED a-lane 16 min silent, delivery delivered",
        options: { triggerTurn: false, deliverAs: "nextTurn" },
      },
    ]);
    await dori.emit("session_shutdown");
  });

  test("monitors stop when the Dori session switches away", async () => {
    await run(dori, { op: "start", name: "w", argv: ["sleep", "30"], filter: "." });
    const pid = Number(/pid (\d+)/.exec((await run(dori, { op: "list" }))?.content[0]?.text ?? "")?.[1]);
    dori.session = { id: "plain", entries: [] };
    await dori.emit("session_switch", { type: "session_switch", reason: "resume" });
    await until(() => !alive(pid));
    expect(dori.session.entries).toEqual([]);
    expect(dori.active).not.toContain("monitor");
    await expect(run(dori, { op: "list" })).rejects.toThrow(
      "monitor works only in the Dori session (omp --dori-role dori)",
    );
  });

  test("monitors stop when /tree moves the Dori session to a point before its role was recorded", async () => {
    await run(dori, { op: "start", name: "w", argv: ["sleep", "30"], filter: "." });
    const pid = Number(/pid (\d+)/.exec((await run(dori, { op: "list" }))?.content[0]?.text ?? "")?.[1]);
    dori.session = { id: "dori", entries: [] };
    await dori.emit("session_tree", { type: "session_tree", newLeafId: null });
    await until(() => !alive(pid));
    expect(dori.active).not.toContain("monitor");
  });

  test("refuses to run outside the Dori session", async () => {
    const lane = await load({ session: { id: "lane", entries: [] }, flags: { "dori-role": "lane" } });
    await lane.emit("session_start");
    expect(lane.active).not.toContain("monitor");
    await expect(run(lane, { op: "list" })).rejects.toThrow(
      "monitor works only in the Dori session (omp --dori-role dori)",
    );
  });
});
