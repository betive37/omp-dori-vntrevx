import { expect, test } from "bun:test";
import { FRAME_BYTES, TrackPacer } from "../src/voice/track-pacer.ts";

const voiced = (frames: number) => Buffer.alloc(frames * FRAME_BYTES, 0x11);
const silence = (frames: number) => Buffer.alloc(frames * FRAME_BYTES);

test("a preroll burst goes out at real time, at most three frames at once", () => {
  const pacer = new TrackPacer();
  pacer.push(voiced(5));
  expect(pacer.take(1000)).toHaveLength(3);
  expect(pacer.take(1000)).toHaveLength(0);
  expect(pacer.take(1020)).toHaveLength(1);
  expect(pacer.take(1040)).toHaveLength(1);
  expect(pacer.backlogMs()).toBe(0);
});

test("stall after stall, the backlog stays bounded instead of accumulating", () => {
  // The session feeds 20 ms per 20 ms of wall time; a 120 ms stall every second delivers the missed audio at once.
  const pacer = new TrackPacer();
  let now = 0;
  let fed = 0;
  let sent = 0;
  const backlog: number[] = [];
  for (let second = 0; second < 20; second++) {
    for (let tick = 0; tick < 50; tick++) {
      now += 20;
      if (tick >= 44) continue; // stalled: neither feed nor pump runs
      const owed = Math.floor(now / 20) - fed;
      pacer.push(voiced(owed));
      fed += owed;
      sent += pacer.take(now).length;
    }
    backlog.push(pacer.backlogMs());
  }
  expect(Math.max(...backlog)).toBeLessThanOrEqual(200);
  expect(sent + pacer.backlogMs() / 20).toBe(fed);
});

test("padding silence is dropped from a backlog; voiced audio is kept", () => {
  const pacer = new TrackPacer();
  pacer.push(Buffer.concat([voiced(2), silence(20), voiced(4)]));
  const frames = [];
  for (let now = 0; now <= 400; now += 20) frames.push(...pacer.take(now));
  const voicedOut = frames.filter(({ frame }) => frame.some((byte) => byte !== 0)).length;
  expect(voicedOut).toBe(6);
  expect(frames.length).toBeLessThan(26);
  expect(pacer.backlogMs()).toBe(0);
});

test("track time keeps running through a gap, so the next RTP timestamp reflects it", () => {
  const pacer = new TrackPacer();
  pacer.push(voiced(1));
  const [first] = pacer.take(0);
  for (let now = 20; now <= 200; now += 20) expect(pacer.take(now)).toHaveLength(0);
  pacer.push(voiced(1));
  const [next] = pacer.take(200);
  expect(first!.timestamp).toBe(0);
  expect(next!.timestamp).toBe(10 * 960);
});

test("more than five seconds of pending audio is refused", () => {
  const pacer = new TrackPacer();
  expect(pacer.push(voiced(250))).toBe(true);
  expect(pacer.push(voiced(1))).toBe(false);
});
