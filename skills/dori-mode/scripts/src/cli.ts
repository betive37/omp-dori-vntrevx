#!/usr/bin/env bun
import { parseArgs } from "node:util";
import { releaseVersion } from "../../../../src/release/version.ts";
import type { Command } from "./cli-context.ts";
import type { FlowDeps } from "./done-flow.ts";
const [command = "", ...rest] = process.argv.slice(2);
const renderTablesUsage = "--render-tables requires dori send discord (with or without --edit)";
if (
  rest.includes("--render-tables") &&
  (command === "--version" ||
    (command === "harness" &&
      (await import("../../../../src/cli-args.ts")).parse([...rest, "--"]).flags.has("render-tables")))
) {
  console.error(renderTablesUsage);
  process.exit(1);
}
const qualifiedRoutesUsage = "--qualified-routes is supported for inbound slack only";
const adoptThreadsUsage = "--adopt-legacy-threads is supported for inbound slack only";
const slackInboundOption = /^(qualified-routes|adopt-legacy-threads)(?:=|$)/;
// Command-selected imports keep unrelated graphs out of short-lived CLI processes.
if (command === "harness") {
  if (rest.some((arg) => arg.startsWith("--") && slackInboundOption.test(arg.slice(2)))) {
    // Use the harness parser before it initializes state, preserving flag-like values and `--` forwarding.
    const { parse } = await import("../../../../src/cli-args.ts");
    const { flags } = parse([...rest, ""]); // Let the parser classify a trailing unknown option.
    const rejected = [...flags.keys()].find((name) => slackInboundOption.test(name));
    if (rejected) {
      console.error(rejected.startsWith("adopt-legacy-threads") ? adoptThreadsUsage : qualifiedRoutesUsage);
      process.exit(1);
    }
  }
  process.exit(await (await import("./cli-harness.ts")).runHarness(rest));
}
if (command === "--version") {
  const end = rest.indexOf("--");
  const rejected = rest
    .slice(0, end === -1 ? rest.length : end)
    .find((arg) => arg.startsWith("--") && slackInboundOption.test(arg.slice(2)));
  if (rejected) {
    console.error(rejected.startsWith("--adopt-legacy-threads") ? adoptThreadsUsage : qualifiedRoutesUsage);
    process.exit(1);
  }
  console.log(releaseVersion);
  process.exit(0);
}
if (command === "update" && rest[0] === "source")
  process.exit(await (await import("../../../../src/update/source-update-cli.ts")).runSourceUpdate(rest.slice(1)));
if (command === "update") process.exit(await (await import("../../../../src/release/cli.ts")).runConsumerUpdate(rest));
if (command === "upstream") process.exit(await (await import("../../../../src/update/cli.ts")).runUpdate(rest));
if (command === "idle-check")
  process.exit(await (await import("../../../../src/update/source-update-cli.ts")).runSourceUpdate([command, ...rest]));
if (command === "lead")
  process.exit(await (await import("../../../../src/update/source-update-cli.ts")).runSourceUpdate([command, ...rest]));
if (command === "remote") process.exit(await (await import("./cli-remote.ts")).runRemote(rest));
if (command === "headless") process.exit(await (await import("./cli-headless.ts")).runHeadless(rest));
if (command === "usage") process.exit(await (await import("./cli-usage-report.ts")).runUsageReport(command, rest));
if (command === "quota") process.exit(await (await import("./cli-usage-report.ts")).runUsageReport(command, rest));
const { die, makeCli } = await import("./cli-context.ts");
const { invokeCommand, validateScheduleOptions } = await import("./cli-invoke.ts");
const { ConfigError, loadConfig } = await import("./config.ts");
const { Registry } = await import("./registry.ts");
const { realClock, run } = await import("./run.ts");
// Preserve config/native admission before argument parsing or any command execution.
const config = await loadConfig().catch((e: unknown) =>
  e instanceof ConfigError ? die(e.message) : Promise.reject(e),
);
const flags = parseArgs({
  args: rest,
  allowPositionals: true,
  strict: false,
  tokens: true,
  options: {
    title: { type: "string" },
    brief: { type: "string" },
    template: { type: "string" },
    set: { type: "string", multiple: true },
    after: { type: "string" },
    "expires-hours": { type: "string" },
    done: { type: "string" },
    thread: { type: "string" },
    request: { type: "string" },
    model: { type: "string" },
    runtime: { type: "string" },
    cwd: { type: "string" },
    pane: { type: "string" },
    evidence: { type: "string" },
    artifact: { type: "string", multiple: true },
    sha256: { type: "string" },
    receipt: { type: "string" },
    public: { type: "boolean" },
    reason: { type: "string", multiple: true },
    note: { type: "string" },
    abandon: { type: "boolean" },
    "resume-when": { type: "string" },
    write: { type: "boolean" },
    json: { type: "boolean" },
    repo: { type: "string" },
    loop: { type: "string" },
    gateway: { type: "boolean" },
    "qualified-routes": { type: "boolean" },
    context: { type: "boolean" },
    "activity-file": { type: "string" },
    "wake-lanes": { type: "boolean" },
    "adopt-legacy-threads": { type: "string", multiple: true },
    purpose: { type: "string" },
    to: { type: "string" },
    text: { type: "string" },
    status: { type: "boolean" },
    resolve: { type: "string" },
    edit: { type: "string" },
    "text-file": { type: "string" },
    reply: { type: "string" },
    "render-tables": { type: "boolean" },
    tag: { type: "string", multiple: true },
    archive: { type: "boolean" },
    unarchive: { type: "boolean" },
    message: { type: "string" },
    emoji: { type: "string" },
    remove: { type: "boolean" },
    kind: { type: "string" },
    owner: { type: "string" },
    report: { type: "string" },
    delivery: { type: "string" },
    step: { type: "string" },
    result: { type: "string" },
    "remote-effect": { type: "string", multiple: true },
    "evidence-file": { type: "string", multiple: true },
    "wall-minutes": { type: "string" },
    "token-limit": { type: "string" },
    "cost-limit": { type: "string" },
    "activity-path": { type: "string", multiple: true },
    rule: { type: "string" },
    outcome: { type: "string" },
    lesson: { type: "string" },
    "dry-run": { type: "boolean" },
    global: { type: "boolean" },
    source: { type: "string" },
    open: { type: "boolean" },
    limit: { type: "string" },
    option: { type: "string", multiple: true },
    recommend: { type: "string" },
    lane: { type: "string" },
    worklog: { type: "string" },
    "ignore-author": { type: "string", multiple: true },
    self: { type: "string" },
    cron: { type: "string" },
    tz: { type: "string" },
    deliver: { type: "string" },
    systemd: { type: "string" },
    system: { type: "boolean" },
    "ack-interrupted": { type: "boolean" },
  },
});
if (flags.values["activity-file"] !== undefined && command !== "inbound") die("--activity-file requires dori inbound");
if (flags.values.runtime !== undefined && command !== "launch") die("--runtime is supported only by dori launch");
if (flags.values["render-tables"] !== undefined && (command !== "send" || flags.positionals[0] !== "discord")) {
  if (command === "send" && ["slack", "telegram"].includes(flags.positionals[0] ?? ""))
    die("--render-tables is supported for discord only");
  die(renderTablesUsage);
}
if (flags.values["adopt-legacy-threads"] !== undefined && (command !== "inbound" || flags.positionals[0] !== "slack"))
  die(adoptThreadsUsage);
if (flags.values["qualified-routes"] !== undefined) {
  if (command !== "inbound" || flags.positionals[0] !== "slack") die(qualifiedRoutesUsage);
  if (flags.tokens.some((token) => token.kind === "option" && token.name === "qualified-routes" && token.inlineValue))
    die("--qualified-routes is a boolean flag; pass it without a value");
}
if (command === "inbound-abandon" && flags.tokens.filter((token) => token.kind === "option").length > 1)
  die("--reason needs one explicit operator abandonment reason; no other options are accepted");
const deps: FlowDeps = { run, clock: realClock, registry: new Registry(config.stateDir), config };
let commands: Readonly<Record<string, Command>> = {};
switch (command) {
  case "report":
  case "relayed":
  case "lesson":
  case "worklog":
  case "checkpoint":
  case "checkpoints":
    commands = (await import("./cli-journal.ts")).journalCommands;
    break;
  case "lanes":
  case "launch":
  case "queue":
  case "adopt":
  case "policy":
  case "claim-done":
  case "object-done":
  case "close":
  case "park":
  case "reopen":
  case "holds":
  case "pause":
  case "resume":
  case "tell":
    commands = (await import("./cli-lanes.ts")).laneCommands;
    break;
  case "status":
  case "board":
  case "eta":
    commands = (await import("./cli-status.ts")).statusCommands;
    break;
  case "sync":
  case "boot":
  case "doctor":
  case "monitor-presets":
  case "verify-pr":
  case "watch":
  case "freshness":
  case "dead-panes":
  case "guard":
  case "heavy":
  case "can-launch":
    commands = (await import("./cli-ops.ts")).opsCommands;
    break;
  case "send":
  case "presence":
  case "inbound":
  case "thread":
  case "react":
  case "channel":
  case "inbound-lag":
  case "transcribe":
    commands = (await import("./cli-messenger.ts")).messengerCommands;
    break;
  case "artifact":
  case "artifacts":
    commands = (await import("./cli-artifacts.ts")).artifactCommands;
    break;
  case "inbound-abandon":
    commands = { "inbound-abandon": (await import("./cli-discord-recovery.ts")).abandonDiscordInbound };
    break;
  case "decision":
    commands = (await import("./cli-decisions.ts")).decisionCommands;
    break;
  case "pr":
    commands = (await import("./cli-pr.ts")).prCommands;
    break;
  case "schedule":
  case "scheduler":
    validateScheduleOptions(command, flags.tokens);
    commands = (await import("./cli-schedule.ts")).scheduleCommands;
    break;
  case "recall":
    commands = { recall: (await import("./cli-recall.ts")).recallCommand };
    break;
  case "voice":
    // Keep the opt-in voice graph out of unrelated command startup paths.
    commands = { voice: (await import("./cli-voice.ts")).voiceCommand };
}
await invokeCommand(makeCli(command, rest, flags, config, deps), commands);
