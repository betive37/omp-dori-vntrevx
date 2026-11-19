import { expect, test } from "bun:test";
import { dutyTick } from "../src/duty.ts";
import type { Deps } from "../src/harness.ts";
import { report } from "../src/lanes.ts";
import { waitLane } from "./wait-setup.ts";

const HEAD = "a".repeat(40);

test("root report binds the actual PR head/check and duty never polls GitHub", async () => {
  const s = await waitLane();
  const calls: string[][] = [];
  const d: Deps = {
    ...s.d,
    exec: async (command, args) => {
      if (command !== "gh") return s.d.exec(command, args);
      calls.push([...args]);
      const value = args[0] === "pr" ? { headRefOid: HEAD } : { id: 99, head_sha: HEAD, status: "queued" };
      return { code: 0, stdout: JSON.stringify(value), stderr: "" };
    },
  };
  const result = await report(d, s.lane.key, "CI pending", { status: "waiting", waitingFor: "ci:acme/project#7@99" });
  const wait = d.store.lane(s.lane.key)?.wait;
  expect(wait).toMatchObject({
    target: { kind: "ci", repo: "acme/project", number: 7, head: HEAD, checkRun: 99 },
    lastObservedState: "queued",
  });
  expect(result.progress.some((line) => line.includes(HEAD))).toBe(true);
  expect(calls.map((args) => args[0])).toEqual(["pr", "api", "pr"]);
  s.w.clock += 60_000;
  await report(d, s.lane.key, "Still pending", { status: "waiting", waitingFor: "ci:acme/project#7@99" });
  expect(d.store.lane(s.lane.key)?.wait?.startedAt).toBe(wait?.startedAt);
  calls.length = 0;
  await dutyTick(d);
  expect(calls).toEqual([]);
});

test("root report refuses a finished check without changing the lane", async () => {
  const s = await waitLane();
  const d: Deps = {
    ...s.d,
    exec: async (command, args) =>
      command !== "gh"
        ? s.d.exec(command, args)
        : {
            code: 0,
            stderr: "",
            stdout: JSON.stringify(
              args[0] === "pr"
                ? { headRefOid: HEAD }
                : {
                    id: 99,
                    head_sha: HEAD,
                    status: "completed",
                    conclusion: "success",
                  },
            ),
          },
  };
  const before = d.store.lane(s.lane.key);
  await expect(
    report(d, s.lane.key, "CI pending", { status: "waiting", waitingFor: "ci:acme/project#7@99" }),
  ).rejects.toThrow("completed");
  expect(d.store.lane(s.lane.key)).toEqual(before);
});
