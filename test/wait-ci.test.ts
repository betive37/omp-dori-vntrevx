import { expect, test } from "bun:test";
import { bindCiWait } from "../src/wait-ci.ts";
import { observeWait, waitEnded, waitKey } from "../src/wait.ts";

const head = "1".repeat(40);
const nextHead = "2".repeat(40);
const request = { kind: "ci", repo: "team/app", number: 123 } as const;
const noCheck = async (): Promise<never> => {
  throw new Error("a head-only wait must not read a check-run");
};

test("head-only CI waits bind a real head without claiming a running or successful job", async () => {
  const first = await bindCiWait(
    request,
    async () => head,
    noCheck,
    () => 100,
  );
  expect(first).toEqual({ target: { ...request, head }, startedAt: 100, observedAt: 100, lastObservedState: "bound" });
  const repeated = await bindCiWait(
    request,
    async () => head,
    noCheck,
    () => 200,
    first,
  );
  expect(repeated.startedAt).toBe(100);
  const changed = await bindCiWait(
    request,
    async () => nextHead,
    noCheck,
    () => 300,
    first,
  );
  expect(changed.startedAt).toBe(300);
  expect(waitKey(changed.target)).not.toBe(waitKey(first.target));
  expect(observeWait(first, { status: "unknown", shellInFront: false })).toEqual(first);
  expect(waitEnded(first)).toBe(false);
});

test("check-run id, repository endpoint and PR head are checked together", async () => {
  const reads: string[] = [];
  const result = await bindCiWait(
    { ...request, checkRun: 456 },
    async () => {
      reads.push("head");
      return head;
    },
    async (endpoint) => {
      reads.push(endpoint);
      return { id: 456, head_sha: head, status: "in_progress" };
    },
    () => 100,
  );
  expect(reads).toEqual(["head", "repos/team/app/check-runs/456", "head"]);
  expect(result.target).toEqual({ ...request, head, checkRun: 456 });
  expect(result.lastObservedState).toBe("in_progress");
});

test.each([
  { id: 999, head_sha: head, status: "queued" },
  { id: 456, head_sha: nextHead, status: "queued" },
  { id: 456, status: "queued" },
])("a mismatched check-run is refused before a wait exists: %j", async (check) => {
  await expect(
    bindCiWait(
      { ...request, checkRun: 456 },
      async () => head,
      async () => check,
      () => 100,
    ),
  ).rejects.toThrow("does not belong");
});

test.each(["success", "failure", "cancelled", "timed_out"])(
  "a completed check (%s) cannot establish a wait",
  async (conclusion) => {
    await expect(
      bindCiWait(
        { ...request, checkRun: 456 },
        async () => head,
        async () => ({ id: 456, head_sha: head, status: "completed", conclusion }),
        () => 100,
      ),
    ).rejects.toThrow("already completed");
  },
);

test("a moved head during check-run observation is refused", async () => {
  let calls = 0;
  await expect(
    bindCiWait(
      { ...request, checkRun: 456 },
      async () => (++calls === 1 ? head : nextHead),
      async () => ({ id: 456, head_sha: head, status: "queued" }),
      () => 100,
    ),
  ).rejects.toThrow("PR head moved");
});

test("incomplete external observations are not promoted to verified waits", async () => {
  await expect(
    bindCiWait(
      request,
      async () => "main",
      noCheck,
      () => 100,
    ),
  ).rejects.toThrow("complete PR head SHA");
  await expect(
    bindCiWait(
      { ...request, checkRun: 456 },
      async () => head,
      async () => null,
      () => 100,
    ),
  ).rejects.toThrow("unobservable");
  await expect(
    bindCiWait(
      { ...request, checkRun: 456 },
      async () => head,
      async () => ({ id: 456, head_sha: head, status: "unknown" }),
      () => 100,
    ),
  ).rejects.toThrow("no observable pending state");
});
