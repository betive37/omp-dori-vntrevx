import { afterEach, beforeEach, expect, test } from "bun:test";
import { freshnessTick } from "../src/freshness.ts";
import { waitFixture } from "./wait-fixture.ts";

let f: Awaited<ReturnType<typeof waitFixture>>;
const HEAD = "a".repeat(40);
beforeEach(async () => {
  f = await waitFixture();
});
afterEach(() => f.done());

test("CI reporting binds an actual PR head and check run; freshness does not start a GitHub polling loop", async () => {
  f.control.api = (endpoint) =>
    endpoint.endsWith("/pulls/7") ? { head: { sha: HEAD } } : { id: 99, head_sha: HEAD, status: "in_progress" };
  const first = await f.report("ci:Acme/Project#7@99");
  expect(first.record?.wait).toMatchObject({
    target: { kind: "ci", repo: "acme/project", number: 7, head: HEAD, checkRun: 99 },
    lastObservedState: "in_progress",
  });
  expect(f.world.calls.filter((call) => call[0] === "gh").map((call) => call[4])).toEqual([
    "repos/acme/project/pulls/7",
    "repos/acme/project/check-runs/99",
    "repos/acme/project/pulls/7",
  ]);
  f.advance(60_000);
  expect((await f.report("ci:acme/project#7@99")).record?.wait?.startedAt).toBe(first.record?.wait?.startedAt);
  f.world.calls = [];
  await freshnessTick(f.deps, "/home/test");
  expect(f.world.calls.filter((call) => call[0] === "gh")).toEqual([]);
  expect(f.reports.read(f.lane.key)?.state).toBe("blocked");
});

test.each([
  { id: 100, head_sha: HEAD, status: "queued" },
  { id: 99, head_sha: "b".repeat(40), status: "queued" },
  { id: 99, head_sha: HEAD, status: "completed", conclusion: "success" },
  { id: 99, head_sha: HEAD, status: "completed", conclusion: "failure" },
])("an unrelated or finished check is refused without a report %#", async (check) => {
  f.control.api = (endpoint) => (endpoint.endsWith("/pulls/7") ? { head: { sha: HEAD } } : check);
  await expect(f.report("ci:acme/project#7@99")).rejects.toThrow();
  expect(f.reports.read(f.lane.key)).toBeNull();
});

test("a PR head change during lookup refuses a stale CI binding", async () => {
  let heads = 0;
  f.control.api = (endpoint) =>
    endpoint.endsWith("/pulls/7")
      ? { head: { sha: ++heads === 1 ? HEAD : "b".repeat(40) } }
      : { id: 99, head_sha: HEAD, status: "queued" };
  await expect(f.report("ci:acme/project#7@99")).rejects.toThrow(
    "PR head moved while binding the CI wait; report again",
  );
  expect(f.reports.read(f.lane.key)).toBeNull();
});

test("an unreadable PR cannot become a fabricated CI identity", async () => {
  f.control.api = () => ({ head: {} });
  await expect(f.report("ci:acme/project#7")).rejects.toThrow("no observable PR head");
  expect(f.reports.read(f.lane.key)).toBeNull();
});
