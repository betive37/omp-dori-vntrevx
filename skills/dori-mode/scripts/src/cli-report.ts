import { artifactNote } from "./artifact-report.ts";
import { Artifacts } from "./artifacts.ts";
import { type Command, die } from "./cli-context.ts";
import { fileEvidence } from "./evidence.ts";
import { runContext } from "./lane-run.ts";
import { sameLaneGeneration } from "./registry.ts";
import { reportDelivery } from "./report-delivery.ts";
import { isReportKind, ReportError } from "./report-events.ts";
import { reportId, reportLine, Reports } from "./reports.ts";
import { realClock } from "./run.ts";

export const report: Command = async ({ key, need, opt, strings, values, lane, config, deps }) => {
  const target = await lane(key ?? die("report needs a lane key"));
  const kind = need("kind");
  if (!isReportKind(kind)) return die("--kind must be milestone, blocker, question, halted or done");
  const text = need("text");
  const owner = opt("owner");
  const reports = new Reports(config.stateDir);
  const evidence = strings("evidence-file").map((path) => fileEvidence(path, process.cwd()));
  const artifactSummary =
    kind === "done" && (target.requestId === undefined || target.runId === process.env["DORI_LANE_RUN"])
      ? await artifactNote(new Artifacts(config, deps.registry), target.key)
      : "";
  const entry = await deps.registry.withCurrent(target.key, (current) => {
    if (!current) throw new ReportError(`no registered lane "${target.key}"`);
    const context = runContext(reports, current, process.env["DORI_LANE_RUN"]);
    if (!context)
      throw new ReportError("report: unknown or missing run (DORI_LANE_RUN); no matching execution recorded");
    const { generation, provenance } = context;
    if (artifactSummary && (!sameLaneGeneration(target, current) || target.runId !== current.runId))
      throw new ReportError("report: lane changed while observing its registered artifacts");
    const body = artifactSummary ? `${text}\n${artifactSummary}` : text;
    return reports.report(target.key, kind, body, realClock.now(), generation, owner, provenance, evidence);
  });
  const receipt = {
    ...entry,
    id: reportId(entry),
    ...(entry.provenance ? { delivery: reportDelivery(config.stateDir, entry) } : {}),
  };
  console.log(values["json"] ? JSON.stringify(receipt) : reportLine(entry));
};
