import { artifactNote } from "./artifact-report.ts";
import { Artifacts } from "./artifacts.ts";
import { type Command, die } from "./cli-context.ts";
import { fileEvidence } from "./evidence.ts";
import { runContext } from "./lane-run.ts";
import { sameSession } from "../../../../src/refs.ts";
import { bindNativeWait, parseWait, recordWait, waitKey, type Wait } from "../../../../src/wait.ts";
import { bindCiWait } from "../../../../src/wait-ci.ts";
import { ghGet } from "./verify-pr.ts";
import { sessionOf, sameLaneGeneration } from "./registry.ts";
import { reportDelivery } from "./report-delivery.ts";
import { isReportKind, ReportError } from "./report-events.ts";
import { reportScope, reportId, reportLine, Reports } from "./reports.ts";
import { runtimesOf, realClock } from "./run.ts";

export const report: Command = async ({ key, need, opt, strings, values, lane, config, deps }) => {
  const target = await lane(key ?? die("report needs a lane key"));
  const kind = need("kind");
  if (!isReportKind(kind)) return die("--kind must be milestone, blocker, question, halted or done");
  const text = need("text");
  const owner = opt("owner");
  const reports = new Reports(config.stateDir);
  const before = reports.read(target.key, reportScope(target))?.lastReport;
  const previous = before && Date.parse(before.at) >= Date.parse(target.openedAt) ? before.wait : undefined;
  const selection = opt("for");
  let wait: Wait | undefined;
  if (selection !== undefined) {
    if (kind !== "blocker") throw new ReportError("--for needs --kind blocker");
    const request = parseWait(selection);
    const ref = sessionOf(target);
    let bound: Wait;
    if (request.kind === "ci") {
      const api = ghGet(deps.run, target.cwd);
      bound = await bindCiWait(
        request,
        async () => {
          const pr = (await api(`repos/${request.repo}/pulls/${request.number}`)) as {
            head?: { sha?: unknown };
          } | null;
          if (typeof pr?.head?.sha !== "string") throw new ReportError("CI wait has no observable PR head");
          return pr.head.sha;
        },
        api,
        realClock.now,
        previous,
      );
    } else {
      if (request.kind !== "label" && !ref) throw new ReportError("native wait needs a registered runtime session");
      const probe = request.kind === "label" || !ref ? undefined : await runtimesOf(deps).for(ref).probe(ref);
      bound = bindNativeWait(request, probe, realClock.now(), previous);
    }
    wait = recordWait(bound.target, bound.lastObservedState, bound.observedAt, realClock.now(), previous);
  }
  const evidence = strings("evidence-file").map((path) => fileEvidence(path, process.cwd()));
  const artifactSummary =
    kind === "done" && (target.requestId === undefined || target.runId === process.env["CATALY_LANE_RUN"])
      ? await artifactNote(new Artifacts(config, deps.registry), target.key)
      : "";
  const entry = await deps.registry.withCurrent(target.key, (current) => {
    if (!current) throw new ReportError(`no registered lane "${target.key}"`);
    if (wait) {
      const ref = sessionOf(target),
        currentRef = sessionOf(current);
      if (
        current.nativeCloseIntent !== undefined ||
        !sameLaneGeneration(target, current) ||
        (ref ? !currentRef || !sameSession(ref, currentRef) : currentRef !== undefined) ||
        JSON.stringify(reports.read(target.key, reportScope(current))?.lastReport) !== JSON.stringify(before) ||
        current.lastWaitNotice !== target.lastWaitNotice
      )
        throw new ReportError("lane state changed or a newer report arrived while observing its wait; report again");
      if (current.lastWaitNotice === `ended|${current.openedAt}|${waitKey(wait.target)}|${wait.startedAt}`)
        throw new ReportError("this wait has already ended; report a currently pending identity");
    }
    const context = runContext(reports, current, process.env["CATALY_LANE_RUN"]);
    if (!context)
      throw new ReportError("report: unknown or missing run (CATALY_LANE_RUN); no matching execution recorded");
    const { generation, provenance } = context;
    if (artifactSummary && (!sameLaneGeneration(target, current) || target.runId !== current.runId))
      throw new ReportError("report: lane changed while observing its registered artifacts");
    const body = artifactSummary ? `${text}\n${artifactSummary}` : text;
    return reports.report(target.key, kind, body, realClock.now(), generation, owner, provenance, evidence, wait);
  });
  const receipt = {
    ...entry,
    id: reportId(entry),
    ...(entry.provenance ? { delivery: reportDelivery(config.stateDir, entry) } : {}),
  };
  console.log(values["json"] ? JSON.stringify(receipt) : reportLine(entry));
};
