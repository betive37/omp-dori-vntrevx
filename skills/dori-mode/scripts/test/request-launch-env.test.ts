import { expect, test } from "bun:test";
import { join } from "node:path";
import { quoteForPane } from "../src/launch-footer.ts";
import { laneStartCommand } from "../src/launch-session.ts";
import { laneLaunchEnv } from "../src/slack-token.ts";
import { withState } from "./fakes.ts";

const parentRun = "00000000-0000-4000-8000-0000000000ff";
const laneRun = "00000000-0000-4000-8000-0000000000aa";

test("a launcher's own run never reaches a new pane shell and its env is left as it was", () => {
  const state = withState();
  try {
    const parent = { HOME: state.dir, DORI_LANE_RUN: parentRun, DORI_CONFIG: join(state.dir, "config.json") };
    const before = { ...parent };
    const env = laneLaunchEnv(parent, join(state.dir, "config.json"));
    expect(parent).toEqual(before);
    expect(Object.hasOwn(env, "DORI_LANE_RUN")).toBe(false);
    expect(Object.values(env)).not.toContain(parentRun);
  } finally {
    state.done();
  }
});

test.skipIf(process.platform === "win32")(
  "the run reaches only the started process; a manual restart in the same shell has none",
  () => {
    const state = withState();
    try {
      const shellEnv = {
        ...laneLaunchEnv({ HOME: state.dir, DORI_LANE_RUN: parentRun }, join(state.dir, "config.json")),
        PATH: "/usr/bin:/bin",
      };
      const probe = [process.execPath, "-e", 'console.log(process.env.DORI_LANE_RUN ?? "unset")'];
      const started = laneStartCommand({ key: "env-lane", thread: "none", runId: laneRun }, probe);
      expect(started).toStartWith(`DORI_LANE_RUN=${laneRun} `);
      const restart = probe.map(quoteForPane).join(" ");
      const shell = Bun.spawnSync(["sh", "-c", `${started}; ${restart}`], { env: shellEnv, cwd: state.dir });
      expect(shell.exitCode).toBe(0);
      expect(shell.stdout.toString().trim().split("\n")).toEqual([laneRun, "unset"]);
    } finally {
      state.done();
    }
  },
);
