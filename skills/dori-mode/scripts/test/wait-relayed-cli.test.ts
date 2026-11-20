import { expect, test } from "bun:test";
import { readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { reportId } from "../src/reports.ts";
import { T0, waitFixture } from "./wait-fixture.ts";

const invokeFrom = (stateDir: string) => {
  const config = join(stateDir, "config.json");
  writeFileSync(config, JSON.stringify({ stateDir, runtime: "herdr" }));
  return async (...args: string[]) => {
    const child = Bun.spawn([process.execPath, join(import.meta.dir, "../src/cli.ts"), ...args], {
      env: {
        HOME: stateDir,
        TMPDIR: stateDir,
        PATH: dirname(process.execPath),
        DORI_CONFIG: config,
        DORI_STATE_DIR: stateDir,
        DORI_TELEMETRY: "0",
      },
      stdout: "pipe",
      stderr: "pipe",
    });
    const [out, err, code] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ]);
    return { out, err, code };
  };
};

test("relayed refuses an old receipt when only a same-ms wait's job start identity changed", async () => {
  const f = await waitFixture();
  try {
    const invoke = invokeFrom(f.state.dir);
    const first = (await f.report("job:bg_1")).record;
    if (first?.wait?.target.kind !== "job") throw new Error("first waiting job report missing");
    const oldId = reportId(first);
    expect((await invoke("relayed", f.lane.key, "--report", oldId)).code).toBe(0);
    f.observe({ running: [{ id: "bg_1", startTime: T0 + 1 }], recent: [] });
    const next = (await f.report("job:bg_1")).record;
    if (!next) throw new Error("replacement waiting report missing");
    expect([next.at, next.text, next.kind, next.owner, next.generation]).toEqual([
      first.at,
      first.text,
      first.kind,
      first.owner,
      first.generation,
    ]);
    expect(next.wait?.target).toEqual({ ...first.wait?.target, jobStartTime: T0 + 1 });
    const path = f.deps.registry.path(f.lane.key);
    const bytes = readFileSync(path);
    const inode = statSync(path).ino;
    const rejected = await invoke("relayed", f.lane.key, "--report", oldId);
    expect(rejected.code).not.toBe(0);
    expect(rejected.err).toContain("not the current journal report");
    expect(readFileSync(path)).toEqual(bytes);
    expect(statSync(path).ino).toBe(inode);
    expect((await f.deps.registry.read(f.lane.key))?.lastPostedReportId).toBe(oldId);
    const currentId = reportId(next);
    expect(currentId).not.toBe(oldId);
    const accepted = await invoke("relayed", f.lane.key, "--report", currentId);
    expect(accepted).toEqual({ code: 0, err: "", out: `RELAYED ${f.lane.key} ${currentId}\n` });
  } finally {
    f.done();
  }
}, 30_000);

test("report --for --owner --json preserves the structured wait in its exact relay receipt", async () => {
  const f = await waitFixture();
  try {
    const invoke = invokeFrom(f.state.dir);
    const written = await invoke(
      "report",
      f.lane.key,
      "--kind",
      "blocker",
      "--text",
      "Waiting for review",
      "--for",
      "upstream review",
      "--owner",
      "Owner summary",
      "--json",
    );
    expect({ code: written.code, err: written.err }).toEqual({ code: 0, err: "" });
    const receipt = JSON.parse(written.out);
    const entry = f.reports.read(f.lane.key)?.lastReport;
    if (!entry) throw new Error("structured JSON report missing");
    expect(receipt).toEqual({ ...entry, id: reportId(entry) });
    expect(entry.owner).toBe("Owner summary");
    expect(entry.wait?.target).toEqual({ kind: "label", text: "upstream review" });
    expect(entry.wait?.lastObservedState).toBe("unverified");
    const relayed = await invoke("relayed", f.lane.key, "--report", receipt.id);
    expect(relayed.code).toBe(0);
    expect((await f.deps.registry.read(f.lane.key))?.lastPostedReportId).toBe(receipt.id);
    expect((await f.deps.registry.read(f.lane.key))?.lastPostedReportOwner).toBe("Owner summary");
  } finally {
    f.done();
  }
}, 30_000);
