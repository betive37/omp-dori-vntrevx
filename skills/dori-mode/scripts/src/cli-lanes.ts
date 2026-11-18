/** dori launch, adopt, claim-done, object-done, close, pause, resume and tell. */
import { join } from "node:path";
import { type Command, die } from "./cli-context.ts";
import { enqueueLaunch, startQueued, cancelQueued } from "./launch-queue.ts";
import { LaunchQueue } from "./launch-queue-store.ts";
import { autoTrackLinks } from "./cli-pr.ts";
import { claimDone, closeLane, objectDone } from "./done-flow.ts";
import { adoptLane, launchLane, prepareLaunch } from "./launch.ts";
import type { LaunchInput } from "./launch-input.ts";
import { pauseLane, resumeLane } from "./pause.ts";
import { tellLane } from "./tell.ts";

const launch: Command = async ({ key, opt, need, ceiling, strings, values, deps }) => {
  const wallMinutes = ceiling("wall-minutes"),
    tokens = ceiling("token-limit"),
    costUsd = ceiling("cost-limit");
  const thread = opt("thread"),
    model = opt("model"),
    cwd = opt("cwd");
  const template = opt("template");
  if (template && opt("brief")) die("choose --brief or --template, not both");
  if (!template && strings("set").length) die("--set requires --template");
  const variables = Object.fromEntries(
    strings("set").map((setting) => {
      const at = setting.indexOf("=");
      const name = setting.slice(0, at);
      if (at < 1 || !/^[a-zA-Z_][a-zA-Z0-9_.-]*$/.test(name)) return die("--set requires name=value");
      return [name, setting.slice(at + 1)];
    }),
  );
  const input: LaunchInput = {
    key: key ?? "",
    title: need("title"),
    brief: template ? join(deps.config.stateDir, "briefs", `${key}.md`) : need("brief"),
    ...(template ? { template, variables } : {}),
    done: need("done"),
    ...(thread !== undefined ? { thread } : {}),
    ...(model !== undefined ? { model } : {}),
    ...(cwd !== undefined ? { cwd } : {}),
    budget: {
      ...(wallMinutes !== undefined ? { wallMinutes } : {}),
      ...(tokens !== undefined ? { tokens } : {}),
      ...(costUsd !== undefined ? { costUsd } : {}),
    },
    activityPaths: strings("activity-path"),
  };
  if (values["dry-run"]) {
    const prepared = await prepareLaunch(deps, input);
    for (const warning of prepared.warnings) console.error(warning);
    console.log(prepared.preamble);
    return;
  }
  const after = opt("after");
  if (after !== undefined) {
    const entry = await enqueueLaunch(
      deps,
      input,
      after.split(",").map((s) => s.trim()),
      Number(opt("expires-hours") ?? 24),
    );
    console.log(
      `QUEUED ${entry.input.key} after=${entry.after.join(",")} expires=${entry.expiresAt}; explicit dori queue start required`,
    );
    return;
  }
  if (opt("expires-hours") !== undefined) die("--expires-hours requires --after");
  const r = await launchLane(deps, input);
  for (const warning of r.warnings) console.error(warning);
  console.log(`LAUNCHED ${r.lane.key} pane=${r.lane.pane} tab=${r.lane.tab ?? "?"}`);
  console.log(r.startup);
  process.exit(r.startup.startsWith("STARTUP_OK") || r.startup.startsWith("STARTUP_DONE") ? 0 : 3);
};

const adopt: Command = async ({ key, opt, need, deps }) => {
  const thread = opt("thread");
  const l = await adoptLane(deps, {
    key: key ?? "",
    title: need("title"),
    brief: need("brief"),
    done: need("done"),
    ...(thread !== undefined ? { thread } : {}),
    pane: need("pane"),
  });
  console.log(`ADOPTED ${l.key} pane=${l.pane} thread=${l.thread}`);
};

const close: Command = async ({ key, opt, lane, deps }) => {
  const target = await lane(key ?? die("close needs a lane key"));
  const rule = opt("lesson");
  const r = await closeLane(
    deps,
    target,
    opt("note") ?? "closed by the lead",
    rule === undefined ? undefined : { rule, evidence: opt("evidence") ?? target.done },
  );
  for (const line of r.lines) console.log(line);
  process.exit(r.closed ? 0 : r.lines.at(-1)?.startsWith("LANE_CHANGED") ? 3 : 2);
};

/** Prints a done-flow result; `LANE_CHANGED` (another writer moved the lane on, nothing recorded) exits 3. */
const recorded = (line: string): void => {
  console.log(line);
  if (line.startsWith("LANE_CHANGED")) process.exit(3);
};

const pauseOrResume: Command = async ({ command, key, opt, lane, deps }) => {
  const act = command === "pause" ? pauseLane : resumeLane;
  const r = await act(
    deps,
    await lane(key ?? die(`${command} needs a lane key`)),
    opt("note") ?? `${command}d by the lead`,
  );
  for (const line of r.lines) console.log(line);
  process.exit(r.code);
};

const tell: Command = async ({ key, need, lane, deps }) => {
  const target = await lane(key ?? die("tell needs a lane key"));
  const r = await tellLane(deps, target, need("text"));
  console.log(r.line);
  process.exit(r.code);
};

export const laneCommands: Readonly<Record<string, Command>> = {
  launch,
  queue: async ({ key: action, positionals, deps }) => {
    if (action === "list") {
      const scan = new LaunchQueue(deps.config.stateDir).scan();
      console.log(JSON.stringify(scan.entries, null, 2));
      for (const problem of scan.problems) console.error(`QUEUE_UNREADABLE ${problem}`);
      process.exitCode = scan.problems.length ? 1 : 0;
      return;
    }
    const key = positionals[1] ?? die("queue needs list, start <key>, or cancel <key>");
    if (action === "cancel") {
      console.log(await cancelQueued(deps, key));
      return;
    }
    if (action !== "start") die("queue needs list, start <key>, or cancel <key>");
    const result = await startQueued(deps, key);
    for (const line of result.lines) console.log(line);
    process.exit(result.code);
  },
  adopt,
  "claim-done": async (cli) => {
    const target = await cli.lane(cli.key);
    const evidence = cli.need("evidence");
    recorded(
      await claimDone(cli.deps, target, evidence, () =>
        autoTrackLinks(cli, target, evidence, `claim-done ${target.key}`),
      ),
    );
  },
  "object-done": async ({ key, values, lane, deps }) => {
    const reasons = (values["reason"] as string[] | undefined)?.map((r) => r.trim()).filter(Boolean) ?? [];
    if (!reasons.length) die("--reason is required");
    recorded(await objectDone(deps, await lane(key ?? die("object-done needs a lane key")), reasons));
  },
  close,
  pause: pauseOrResume,
  resume: pauseOrResume,
  tell,
};
