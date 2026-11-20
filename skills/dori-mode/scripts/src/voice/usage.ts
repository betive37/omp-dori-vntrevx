import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { VoiceSettings } from "./settings.ts";
import type { Usage } from "./types.ts";

/** liveSeconds is all billed Live time and drives the minute caps; pausedSeconds is the part billed at the standby rate. */
type Day = { liveSeconds: number; pausedSeconds: number; sessions: number; backendUsd: number };

/** Turns one session's cumulative billed and paused seconds into ledger increments. */
export class LiveMeter {
  seconds = 0;
  private paused = 0;
  constructor(private readonly usage: VoiceUsage) {}
  /** seconds is cumulative billed time; paused is the provider's cumulative paused part of it, when reported. */
  record(seconds: number, paused = 0): void {
    const delta = Math.max(0, seconds - this.seconds);
    this.seconds += delta;
    // Paused time is billed time too, so it never exceeds what has been recorded and never lowers the cap count.
    const pausedDelta = Math.max(0, Math.min(paused, this.seconds) - this.paused);
    this.paused += pausedDelta;
    if (delta || pausedDelta) this.usage.live(delta, pausedDelta);
  }
}

/** Operator prices are estimates; in-flight provider usage can arrive after a cap is reached. */
export class VoiceUsage {
  private readonly file: string;
  private readonly days: Record<string, Day>;
  constructor(
    directory: string,
    private readonly settings: VoiceSettings,
    private readonly now: () => number,
  ) {
    this.file = join(directory, "usage.json");
    this.days = {};
    if (!existsSync(this.file)) return;
    const raw: unknown = JSON.parse(readFileSync(this.file, "utf8"));
    if (
      !raw ||
      typeof raw !== "object" ||
      !("days" in raw) ||
      !raw.days ||
      typeof raw.days !== "object" ||
      Array.isArray(raw.days)
    )
      throw new Error("Invalid voice usage ledger");
    for (const [key, day] of Object.entries(raw.days)) {
      if (
        !day ||
        typeof day !== "object" ||
        !("liveSeconds" in day) ||
        !("sessions" in day) ||
        !("backendUsd" in day) ||
        typeof day.liveSeconds !== "number" ||
        typeof day.sessions !== "number" ||
        typeof day.backendUsd !== "number" ||
        [day.liveSeconds, day.sessions, day.backendUsd].some((n) => !Number.isFinite(n) || n < 0)
      )
        throw new Error("Invalid voice usage ledger; refusing to reset spending history");
      // Ledgers written before the paused breakdown have no pausedSeconds.
      const paused = "pausedSeconds" in day ? day.pausedSeconds : 0;
      if (typeof paused !== "number" || !Number.isFinite(paused) || paused < 0)
        throw new Error("Invalid voice usage ledger; refusing to reset spending history");
      this.days[key] = {
        liveSeconds: day.liveSeconds,
        pausedSeconds: paused,
        sessions: day.sessions,
        backendUsd: day.backendUsd,
      };
    }
  }

  private day(): Day {
    const key = new Intl.DateTimeFormat("en-CA", {
      timeZone: this.settings.timeZone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    }).format(this.now());
    this.days[key] ??= { liveSeconds: 0, pausedSeconds: 0, sessions: 0, backendUsd: 0 };
    return this.days[key];
  }
  private save(): void {
    writeFileSync(`${this.file}.tmp`, `${JSON.stringify({ days: this.days })}\n`, { mode: 0o600 });
    renameSync(`${this.file}.tmp`, this.file);
  }
  started(): void {
    this.day().sessions++;
    this.save();
  }
  /** Adds billed seconds and, separately, newly reported paused seconds already included in billed time. */
  live(seconds: number, pausedSeconds = 0): void {
    if ([seconds, pausedSeconds].some((n) => !Number.isFinite(n) || n < 0)) throw new Error("Invalid Live usage");
    const day = this.day();
    day.liveSeconds += seconds;
    day.pausedSeconds += pausedSeconds;
    this.save();
  }
  backend(usage: Usage | undefined, model: string): number {
    if (!usage) return 0;
    const price = this.settings.prices[model]!;
    const cached = usage.input_tokens_details?.cached_tokens ?? 0;
    const written = usage.input_tokens_details?.cache_write_tokens ?? 0;
    const input = usage.input_tokens ?? 0;
    const output = usage.output_tokens ?? 0;
    if ([cached, written, input, output].some((n) => !Number.isFinite(n) || n < 0) || cached + written > input)
      throw new Error("Invalid backend usage");
    const cost =
      ((input - cached - written) * price.input +
        cached * price.cached +
        written * price.cacheWrite +
        output * price.output) /
      1e6;
    this.day().backendUsd += cost;
    this.save();
    return cost;
  }
  search(): void {
    this.day().backendUsd += this.settings.webSearchUsdPerCall;
    this.save();
  }
  capReason(): string | undefined {
    const day = this.day();
    const totals = Object.values(this.days).reduce(
      (sum, d) => ({ seconds: sum.seconds + d.liveSeconds, usd: sum.usd + d.backendUsd }),
      { seconds: 0, usd: 0 },
    );
    if (day.liveSeconds >= this.settings.dailyMinuteCap * 60) return "Daily voice time limit reached";
    if (this.settings.totalMinuteCap > 0 && totals.seconds >= this.settings.totalMinuteCap * 60)
      return "Total voice time limit reached";
    if (totals.usd >= this.settings.backendUsdCap) return "Backend spending limit reached";
    return undefined;
  }
}
