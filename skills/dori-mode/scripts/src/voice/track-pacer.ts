/**
 * Real-time pacing of owner audio on the WebRTC Opus track. The session hands over PCM at real time on average, padding
 * silence (zero samples) whenever it falls behind, but in bursts: the wake preroll, and whatever piled up during an
 * event-loop stall. The pacer releases one 20 ms frame per 20 ms of track time and keeps the latency it adds bounded:
 * - a late timer releases at most three overdue frames together;
 * - beyond 100 ms of backlog, padding frames are dropped from the stream and voiced frames go out 15% fast, so a
 *   backlog shrinks instead of accumulating stall after stall;
 * - after the queue ran empty, track time resumes from the wall clock, so the RTP timestamp after a gap reflects it.
 */

/** 20 ms of 48 kHz mono PCM16: one Opus frame. */
export const FRAME_BYTES = 1920;
const FRAME_MS = 20;
const SAMPLES_PER_FRAME = 960;
const MAX_BURST_MS = 40;
const BACKLOG_FRAMES = 5;
const CATCH_UP = 1.15;
/** More pending audio than this means the pacing upstream broke. */
const MAX_PENDING_BYTES = 250 * FRAME_BYTES;

export class TrackPacer {
  private pending: Buffer[] = [];
  private bytes = 0;
  /** When the next frame is due, in the caller's clock. */
  private next = Number.NEGATIVE_INFINITY;
  /** Track time in frames since the first frame; drives the RTP timestamp. */
  private slot = 0;
  /** When the first frame went out; after an empty queue, track time resumes from the wall clock. */
  private start: number | undefined;
  private starved = false;

  /** False when the backlog would exceed 5 s. */
  push(pcm48: Buffer): boolean {
    if (this.bytes + pcm48.length > MAX_PENDING_BYTES) return false;
    if (pcm48.length) this.pending.push(pcm48);
    this.bytes += pcm48.length;
    return true;
  }

  backlogMs(): number {
    return (this.bytes / FRAME_BYTES) * FRAME_MS;
  }

  /** The frames due at `now`, each with its RTP timestamp. */
  take(now: number): { frame: Buffer; timestamp: number }[] {
    const out: { frame: Buffer; timestamp: number }[] = [];
    if (this.bytes < FRAME_BYTES) {
      this.starved = true;
      return out;
    }
    if (this.start === undefined) this.start = now;
    else if (this.starved) this.slot = Math.max(this.slot, Math.floor((now - this.start) / FRAME_MS));
    this.starved = false;
    this.next = Math.max(this.next, now - MAX_BURST_MS);
    while (this.next <= now && this.bytes >= FRAME_BYTES) {
      let frame = this.shift();
      while (this.behind() && frame.every((byte) => byte === 0)) frame = this.shift();
      out.push({ frame, timestamp: (this.slot * SAMPLES_PER_FRAME) >>> 0 });
      this.slot++;
      this.next += this.behind() ? FRAME_MS / CATCH_UP : FRAME_MS;
    }
    this.starved = this.bytes < FRAME_BYTES;
    return out;
  }

  private behind(): boolean {
    return this.bytes > BACKLOG_FRAMES * FRAME_BYTES;
  }

  private shift(): Buffer {
    const frame = Buffer.concat(this.pending, FRAME_BYTES);
    let left = FRAME_BYTES;
    while (left > 0) {
      const head = this.pending[0]!;
      if (head.length > left) {
        this.pending[0] = head.subarray(left);
        left = 0;
      } else {
        this.pending.shift();
        left -= head.length;
      }
    }
    this.bytes -= FRAME_BYTES;
    return frame;
  }
}
