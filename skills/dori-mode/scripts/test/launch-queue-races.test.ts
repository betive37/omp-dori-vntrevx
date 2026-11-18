import { afterEach, beforeEach, expect, test } from "bun:test";
import { cancelQueued, enqueueLaunch, startQueued } from "../src/launch-queue.ts";
import { LaunchQueue } from "../src/launch-queue-store.ts";
import { queueFixture, roomy, type QueueFixture } from "./launch-queue-fixture.ts";

let f: QueueFixture;
beforeEach(async () => {
  f = await queueFixture();
});
afterEach(() => f.state.done());

test.each(["Done", "host"])("expiry during the asynchronous %s check cannot authorize startup", async (stage) => {
  await enqueueLaunch(f.deps, f.input, [f.prior.key], 1 / 3600);
  const deps = {
    ...f.deps,
    run: async (...args: Parameters<typeof f.deps.run>) => {
      if (stage === "Done" && args[0][0] === "gh") f.advance(2000);
      return f.deps.run(...args);
    },
  };
  const sample = async () => {
    if (stage === "host") f.advance(2000);
    return roomy();
  };
  const result = await startQueued(deps, f.input.key, sample);
  expect(result.code).toBe(4);
  expect(result.lines[0]).toContain("expired");
  expect(f.creates()).toBe(0);
  expect(new LaunchQueue(f.state.dir).read(f.input.key)?.status).toBe("pending");
  expect(await f.deps.registry.read(f.input.key)).toBeNull();
});

test("concurrent requeues cannot introduce a dependency cycle", async () => {
  const other = { ...f.input, key: "other-lane" };
  await enqueueLaunch(f.deps, f.input, [f.prior.key]);
  await enqueueLaunch(f.deps, other, [f.prior.key]);
  await cancelQueued(f.deps, f.input.key);
  await cancelQueued(f.deps, other.key);
  const results = await Promise.allSettled([
    enqueueLaunch(f.deps, f.input, [other.key]),
    enqueueLaunch(f.deps, other, [f.input.key]),
  ]);
  expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
  expect(results.filter((r) => r.status === "rejected")).toHaveLength(1);
  expect(String(results.find((r) => r.status === "rejected")?.reason)).toContain("cycle");
  const entries = new LaunchQueue(f.state.dir).scan().entries;
  expect(entries.filter((entry) => entry.status === "pending")).toHaveLength(1);
  expect(f.creates()).toBe(0);
});
