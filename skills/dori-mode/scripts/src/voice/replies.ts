import { existsSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export type LeadReply = { re: string; text: string; start: number };

/** Byte offsets advance only after speech AND playback, never on the commentary acknowledgement. */
export class Replies {
  readonly file: string;
  private readonly stateFile: string;
  private scanned = 0;
  private identity: string | undefined;
  private readonly queue: LeadReply[] = [];

  constructor(
    directory: string,
    private readonly log: (line: string) => void,
  ) {
    this.file = join(directory, "lead-replies.jsonl");
    this.stateFile = join(directory, "lead-replies.state.json");
    if (existsSync(this.stateFile)) {
      const state: unknown = JSON.parse(readFileSync(this.stateFile, "utf8"));
      if (
        !state ||
        typeof state !== "object" ||
        !("offset" in state) ||
        typeof state.offset !== "number" ||
        !Number.isSafeInteger(state.offset) ||
        state.offset < 0
      )
        throw new Error("Invalid voice reply offset; restore the reply ledger before starting voice");
      this.scanned = state.offset;
      this.identity = "identity" in state && typeof state.identity === "string" ? state.identity : undefined;
    }
  }

  scan(): void {
    if (!existsSync(this.file)) return;
    const info = statSync(this.file);
    const identity = `${info.dev}:${info.ino}`;
    const data = readFileSync(this.file);
    if ((this.identity && this.identity !== identity) || data.length < this.scanned) {
      this.scanned = 0;
      this.queue.length = 0;
    }
    this.identity = identity;
    for (;;) {
      const end = data.indexOf(10, this.scanned);
      if (end < 0) return; // An append still in progress is not a malformed line.
      const start = this.scanned;
      const line = data.subarray(start, end).toString("utf8").trim();
      this.scanned = end + 1;
      if (!line) continue;
      try {
        const reply: unknown = JSON.parse(line);
        if (
          !reply ||
          typeof reply !== "object" ||
          !("text" in reply) ||
          typeof reply.text !== "string" ||
          !reply.text.trim()
        )
          throw new Error("Invalid reply");
        this.queue.push({ re: "re" in reply && typeof reply.re === "string" ? reply.re : "", text: reply.text, start });
      } catch {
        this.log("VOICE_REPLY_INVALID_LINE");
      }
    }
  }

  first(): LeadReply | undefined {
    return this.queue[0];
  }

  spoken(reply: LeadReply): void {
    // A replaced log cannot be acknowledged by an old session's in-flight reply.
    if (this.queue[0] !== reply) return;
    this.queue.shift();
    const offset = this.queue[0]?.start ?? this.scanned;
    writeFileSync(`${this.stateFile}.tmp`, `${JSON.stringify({ offset, identity: this.identity })}\n`, { mode: 0o600 });
    renameSync(`${this.stateFile}.tmp`, this.stateFile);
  }
}

export type ReplyFlight = {
  reply: LeadReply;
  eventId: string;
  sentAt: number;
  ackedAt?: number;
  spokenChars: number;
  playbackGeneration: number;
  text: string;
  end: number;
};
export const replySpokenEnough = (flight: ReplyFlight): boolean =>
  flight.ackedAt !== undefined &&
  flight.spokenChars >=
    Math.min(
      flight.text.replace(/\s/g, "").length,
      Math.max(8, Math.floor(flight.text.replace(/\s/g, "").length * 0.3)),
    );
