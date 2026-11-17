import { mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";

import type { SessionRef } from "../../../../src/runtime/types.ts";
import { takeLock } from "./checkpoint-lock.ts";
import type { BudgetLimits } from "./supervision-observe.ts";

// A writer holds a lane's lock for one synchronous read and write, so a short wait covers any live contention.
const LOCK_WAIT_MS = 5_000;
const LOCK_RETRY_MS = 10;

export const LANE_KEY = /^[a-z0-9][a-z0-9._-]{1,60}$/;
// Reserve the exact lowercase lead key for launch/adopt; legacy lead records and lead-only checks remain valid.
export const RESERVED_LANE_KEY = "lead";

export type LaneStatus = "working" | "paused" | "done-claimed" | "verified-done" | "not-done" | "closed";
export type Claim = { readonly at: string; readonly evidence: string; readonly emitted?: boolean };
export type Objection = { readonly at: string; readonly reasons: readonly string[] };
export type HistoryEntry = { readonly at: string; readonly status: LaneStatus; readonly note: string };

export type Lane = {
  readonly key: string;
  readonly title: string;
  readonly thread: string;
  /** The lane's session on its runtime. `pane`/`tab` mirror its id and container for older readers. */
  readonly sessionRef?: SessionRef;
  readonly pane?: string | undefined;
  readonly tab?: string;
  readonly session?: string;
  readonly sessionVia?: string;
  readonly brief: string;
  readonly done: string;
  readonly cwd?: string;
  readonly model?: string;
  readonly worktrees?: readonly string[];
  readonly status?: LaneStatus;
  readonly claim?: Claim;
  readonly objection?: Objection;
  readonly history?: readonly HistoryEntry[];
  readonly openedAt: string;
  readonly closedAt?: string;
  readonly lastReplyAt?: number;
  readonly lastNudgeAt?: number;
  readonly lastAutoReplyAt?: number;
  /** The [REPORT] line the freshness sweep last posted, so a stale screen is never posted twice. */
  readonly lastPostedReport?: string | undefined;
  /** The [REPORT] line seen on the previous freshness tick (a line is posted only once it holds across two ticks). */
  readonly lastSeenReport?: string | undefined;
  /** The last held-back freshness outcome, so a quiet lane logs each state change once, not every tick. */
  readonly lastFreshnessNote?: string | undefined;
  /** A paused lane whose pane read working on the previous freshness tick (two in a row is reported, never a resume). */
  readonly pausedSeenWorking?: boolean | undefined;
  /** The status a paused lane had before it was paused; `resume` restores it. */
  readonly pausedFrom?: LaneStatus | undefined;
  readonly reportProtocol?: "jsonl-v1" | undefined;
  readonly budget?: BudgetLimits;
  readonly activityPaths?: readonly string[];
  /** The last supervision failure printed by `freshness`, so the same one is printed once. */
  readonly lastSupervisionError?: string | undefined;
  readonly receipt?: unknown;
};

/** Records written before runtimes existed name a herdr pane (and tab): the only runtime the skill spoke then. */
const LEGACY_RUNTIME = "herdr" as const;

/** A record as read: an older one gains `sessionRef` from its `pane`/`tab`; a newer one keeps what it stored. */
export const upgradeLane = (lane: Lane): Lane =>
  lane.sessionRef || !lane.pane
    ? lane
    : { ...lane, sessionRef: { runtime: LEGACY_RUNTIME, id: lane.pane, ...(lane.tab ? { container: lane.tab } : {}) } };

/** The lane's session, whichever way the record was written (or built in memory). */
export const sessionOf = (lane: Lane): SessionRef | undefined => upgradeLane(lane).sessionRef;

/** The fields a lane record stores for a session: the ref itself and the `pane`/`tab` mirror. */
export const sessionFields = (ref: SessionRef): Pick<Lane, "sessionRef" | "pane" | "tab"> => ({
  sessionRef: ref,
  pane: ref.id,
  ...(ref.container ? { tab: ref.container } : {}),
});

const sameSession = (a: SessionRef | undefined, b: SessionRef): boolean =>
  a !== undefined && a.runtime === b.runtime && a.id === b.id;

export const statusOf = (lane: Lane): LaneStatus => (lane.closedAt ? "closed" : (lane.status ?? "working"));

/** History counts even same-status transitions; freshness notes, receipts and emitted claims leave it unchanged. */
const generation = (lane: Lane): string => `${lane.openedAt} ${lane.history?.length ?? 0} ${statusOf(lane)}`;

export const withStatus = (
  lane: Lane,
  status: LaneStatus,
  note: string,
  at: string,
  patch: Partial<Lane> = {},
): Lane => ({
  ...lane,
  ...patch,
  status,
  history: [...(lane.history ?? []), { at, status, note }],
});

export class Registry {
  readonly dir: string;
  /** Parsed closed records by file, each with the stat stamp it was read under; list() keeps only files it saw. */
  private parsed = new Map<string, { readonly stamp: string; readonly lane: Lane }>();
  constructor(stateDir: string) {
    this.dir = join(stateDir, "lanes");
  }

  path(key: string): string {
    return join(this.dir, `${key}.json`);
  }

  async read(key: string): Promise<Lane | null> {
    return this.readNow(key);
  }

  /** Lock synchronous read/write only; wait for live holders, reclaim dead/stale ones, never await external I/O. */
  private async locked<T>(key: string, fn: () => T): Promise<T> {
    mkdirSync(this.dir, { recursive: true });
    const lock = `${this.path(key)}.lock`;
    const fail = (m: string) => new Error(`lane registry lock of ${key} ${m}`);
    const deadline = Date.now() + LOCK_WAIT_MS;
    for (;;) {
      const held = takeLock(lock, Date.now(), fail);
      if (typeof held !== "string") {
        try {
          return fn();
        } finally {
          held();
        }
      }
      if (Date.now() >= deadline) throw new Error(`lane registry locked: ${key} (${held})`);
      await Bun.sleep(LOCK_RETRY_MS);
    }
  }

  private readNow(key: string): Lane | null {
    try {
      return upgradeLane(JSON.parse(readFileSync(this.path(key), "utf8")) as Lane);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw error;
    }
  }

  // temp file + rename so a concurrent reader never sees a half-written lane
  private writeNow(lane: Lane): void {
    const tmp = `${this.path(lane.key)}.${process.pid}.tmp`;
    writeFileSync(tmp, JSON.stringify(lane, null, 1));
    renameSync(tmp, this.path(lane.key));
  }

  async write(lane: Lane): Promise<void> {
    await this.locked(lane.key, () => this.writeNow(lane));
  }

  /** Registers a new lane only while its key has no record (false: another launch or adopt holds the key). */
  async create(lane: Lane): Promise<boolean> {
    return (await this.update(lane.key, (current) => (current ? null : lane))) !== null;
  }

  /** Removes `lane`'s record while it is still that registration: a launch undoing its own failed start. */
  discard(lane: Lane): Promise<void> {
    return this.locked(lane.key, () => {
      const current = this.readNow(lane.key);
      if (current && generation(current) === generation(lane)) rmSync(this.path(lane.key), { force: true });
    });
  }

  /** Locked read-modify-write: null keeps current state; never overwrite a record held across external I/O. */
  update(key: string, fn: (current: Lane | null) => Lane | null): Promise<Lane | null> {
    return this.locked(key, () => {
      const next = fn(this.readNow(key));
      if (next) this.writeNow(next);
      return next;
    });
  }

  // Apply only to the same status generation, preserving later claims, pauses and repeated objections.
  transition(seen: Lane, next: (current: Lane) => Lane): Promise<Lane | null> {
    return this.update(seen.key, (current) =>
      current && generation(current) === generation(seen) ? next(current) : null,
    );
  }

  // Reading never creates the lanes directory (dori boot is read-only); write() creates it.
  private files(): string[] {
    try {
      return readdirSync(this.dir)
        .filter((f) => f.endsWith(".json"))
        .map((f) => join(this.dir, f));
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw e;
    }
  }

  // Cache closed records only while inode/size/mtime/ctime match; always read open records.
  // Stamp before reading so racing writes cause a fresh read next tick; retain only files seen this tick.
  async list(): Promise<Lane[]> {
    const lanes: Lane[] = [];
    const parsed = new Map<string, { readonly stamp: string; readonly lane: Lane }>();
    for (const f of this.files()) {
      // A record removed since the directory was listed (a failed launch's rollback) is skipped, as readNow does.
      const st = statSync(f, { bigint: true, throwIfNoEntry: false });
      if (!st) continue;
      const stamp = `${st.ino}:${st.size}:${st.mtimeNs}:${st.ctimeNs}`;
      const cached = this.parsed.get(f);
      const lane = cached?.stamp === stamp ? cached.lane : this.readNow(basename(f, ".json"));
      if (lane === null) continue;
      if (statusOf(lane) === "closed") parsed.set(f, { stamp, lane });
      lanes.push(lane);
    }
    this.parsed = parsed;
    return lanes;
  }

  /** Like list(), but a lane file that cannot be read, parsed, or holds no lane key is returned in `unreadable` instead of throwing. */
  async scan(): Promise<{ lanes: Lane[]; unreadable: string[] }> {
    const lanes: Lane[] = [];
    const unreadable: string[] = [];
    for (const f of this.files()) {
      try {
        const lane: unknown = this.readNow(basename(f, ".json"));
        if (lane === null) continue;
        if (typeof lane !== "object" || !("key" in lane) || typeof lane.key !== "string")
          throw new Error("not a lane record");
        lanes.push(lane as Lane);
      } catch {
        unreadable.push(f);
      }
    }
    return { lanes, unreadable };
  }

  async open(): Promise<Lane[]> {
    return (await this.list()).filter((l) => statusOf(l) !== "closed");
  }

  // Never identify a legacy lead record as a lane; it remains readable by key, listed and closable by hand.
  async bySession(ref: SessionRef | undefined): Promise<Lane | null> {
    if (!ref) return null;
    return (await this.open()).find((l) => sameSession(l.sessionRef, ref) && l.key !== RESERVED_LANE_KEY) ?? null;
  }
}
