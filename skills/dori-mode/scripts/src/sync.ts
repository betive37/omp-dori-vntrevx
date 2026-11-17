import { formatRef } from "../../../../src/runtime/types.ts";
import type { FlowDeps } from "./done-flow.ts";
import { statusOf } from "./registry.ts";
import { type Ran, type Runner, runtimesOf } from "./run.ts";
import { procTable, resolveSession } from "./session-id.ts";
import { listSessions, listWatched } from "./sessions.ts";

export type SyncRow = {
  readonly key: string;
  readonly thread: string;
  readonly pane: string;
  readonly session: string;
  readonly status: string;
};
export type SyncResult = { readonly rows: SyncRow[]; readonly drift: string[]; readonly unregistered: SyncRow[] };

// A read-only pass reads the full process table once (each OMP probe re-reads it otherwise) and herdr's full pane list
// once (herdr filters groups locally). hc lists a group by asking for it, so its calls are never shared. The snapshot
// lives for this pass only; a --write pass, which records what it resolves, reads everything fresh.
const PASS_SHARED = /^(?:ps -A -o pid=,ppid=,command=|herdr (?:--session \S+ )?pane list)$/;
const passRunner = (run: Runner): Runner => {
  const seen = new Map<string, Ran>();
  return async (argv, opts) => {
    const key = JSON.stringify(argv);
    if (opts || !PASS_SHARED.test(argv.join(" "))) return run(argv, opts);
    const ran = seen.get(key) ?? (await run(argv));
    if (ran.code === 0) seen.set(key, ran);
    return ran;
  };
};

export const syncRegistry = async (flow: FlowDeps, write: boolean): Promise<SyncResult> => {
  const deps = write ? flow : { ...flow, run: passRunner(flow.run) };
  const rts = runtimesOf(deps);
  const lanes = await deps.registry.open();
  const sessions = await listSessions(rts, { lanes });
  const live = new Map(sessions.map((s) => [formatRef(s.ref), s]));
  const table = await procTable(deps.run);
  const rows: SyncRow[] = [];
  const drift: string[] = [];
  const resolveDeps = { run: deps.run, sessionsDir: deps.config.sessionsDir, stateDir: deps.config.stateDir, rts };
  for (const lane of lanes) {
    const session = lane.sessionRef ? live.get(formatRef(lane.sessionRef)) : undefined;
    if (!session) drift.push(`${lane.key}: pane ${lane.pane ?? "(none)"} is gone but the lane is ${statusOf(lane)}`);
    const hit = session
      ? await resolveSession(session.ref, session.cwd ?? "", table, resolveDeps)
      : { id: "", via: "none" };
    if (lane.session && hit.id && hit.id !== lane.session)
      drift.push(`${lane.key}: pane now runs session ${hit.id} (registry has ${lane.session})`);
    if (!lane.done) drift.push(`${lane.key}: empty Done line, so a done claim can never close it`);
    if (write && hit.id && hit.id !== lane.session)
      await deps.registry.update(
        lane.key,
        (current) => current && { ...current, session: hit.id, sessionVia: hit.via },
      );
    rows.push({
      key: lane.key,
      thread: lane.thread,
      pane: lane.pane ?? "-",
      session: hit.id ? `${hit.id} (${hit.via})` : (lane.session ?? "-"),
      status: statusOf(lane),
    });
  }
  const owned = new Set(lanes.flatMap((l) => (l.sessionRef ? [formatRef(l.sessionRef)] : [])));
  const skip = new Set([deps.config.leadPane, ...deps.config.ignorePanes]);
  const watched = deps.config.workspaces.length > 0 ? await listWatched(rts, deps.config.workspaces, lanes) : sessions;
  const unregistered: SyncRow[] = [];
  for (const s of watched) {
    const id = s.ref.id;
    if (owned.has(formatRef(s.ref)) || skip.has(id)) continue;
    if (s.agent === undefined) continue;
    const hit = await resolveSession(s.ref, s.cwd ?? "", table, resolveDeps);
    unregistered.push({
      key: s.title ?? s.name ?? id,
      thread: "-",
      pane: id,
      session: hit.id ? `${hit.id} (${hit.via})` : "-",
      status: "unregistered",
    });
  }
  return { rows, drift, unregistered };
};
