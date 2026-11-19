import { expect, test } from "bun:test";
import { writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { waitFixture } from "./wait-fixture.ts";

test("the actual CLI parses --for and preserves plain report compatibility without external executables", async () => {
  const f = await waitFixture();
  try {
    const config = join(f.state.dir, "config.json");
    writeFileSync(config, JSON.stringify({ stateDir: f.state.dir, runtime: "herdr" }));
    const invoke = async (...args: string[]) => {
      const child = Bun.spawn([process.execPath, join(import.meta.dir, "../src/cli.ts"), ...args], {
        env: {
          HOME: f.state.dir,
          TMPDIR: f.state.dir,
          PATH: dirname(process.execPath),
          DORI_CONFIG: config,
          DORI_STATE_DIR: f.state.dir,
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
    const bound = await invoke(
      "report",
      f.lane.key,
      "--kind",
      "blocker",
      "--text",
      "Needs maintainer review",
      "--for",
      "upstream review",
    );
    expect({ code: bound.code, err: bound.err }).toEqual({ code: 0, err: "" });
    expect(bound.out).toContain("WAIT");
    expect(bound.out).toContain("unverified");
    expect(f.reports.read(f.lane.key)?.lastReport?.wait?.target).toEqual({ kind: "label", text: "upstream review" });
    const rejected = await invoke(
      "report",
      f.lane.key,
      "--kind",
      "milestone",
      "--text",
      "Working",
      "--for",
      "job:bg_1",
    );
    expect(rejected.code).not.toBe(0);
    expect(rejected.err).toContain("--for needs --kind blocker");
    expect(f.reports.read(f.lane.key)?.state).toBe("blocked");
    const plain = await invoke("report", f.lane.key, "--kind", "milestone", "--text", "Working again");
    expect(plain).toEqual({ code: 0, err: "", out: "[REPORT] waiting-lane | milestone | Working again\n" });
    expect(f.reports.read(f.lane.key)?.lastReport).not.toHaveProperty("wait");
  } finally {
    f.done();
  }
}, 30_000);
