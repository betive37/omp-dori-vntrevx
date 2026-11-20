import { expect, spyOn, test } from "bun:test";
import { makeCli } from "../src/cli-context.ts";
import { journalCommands } from "../src/cli-journal.ts";
import { freshnessTick } from "../src/freshness.ts";
import { reportId } from "../src/reports.ts";
import { waitFixture } from "./wait-fixture.ts";

const cases = [
  { postRaw: false, owner: "Review pending" },
  { postRaw: true, owner: "Review pending" },
  { postRaw: true },
];

test.each(cases)("a structured wait preserves owner-only delivery and the full receipt %#", async (policy) => {
  const f = await waitFixture();
  const output = spyOn(console, "log").mockImplementation(() => {});
  try {
    await f.deps.registry.write({ ...f.lane, thread: "discord:123" });
    const deps = {
      ...f.deps,
      config: {
        ...f.deps.config,
        freshness: { postRaw: policy.postRaw, autoPostKinds: ["blocker" as const] },
        hooks: { threadReply: ["notify", "{thread}", "{text}"] },
      },
    };
    const handler = journalCommands["report"];
    if (!handler) throw new Error("report handler missing");
    await handler(
      makeCli(
        "report",
        [],
        {
          positionals: [f.lane.key],
          values: {
            kind: "blocker",
            text: "Internal lead detail",
            for: "internal vendor escalation",
            ...(policy.owner ? { owner: policy.owner } : {}),
          },
        },
        deps.config,
        deps,
      ),
    );
    const entry = f.reports.read(f.lane.key)?.lastReport;
    if (!entry?.wait) throw new Error("structured wait report missing");
    const id = reportId(entry);
    expect(entry.wait.target).toEqual({ kind: "label", text: "internal vendor escalation" });
    f.advance(21 * 60_000);
    expect((await freshnessTick(deps, "/home/test")).map((act) => act.kind)).toEqual(["posted"]);
    const calls = f.world.calls.filter((call) => call[0] === "notify");
    expect(calls).toHaveLength(1);
    const text = calls[0]?.[2];
    if (policy.owner) {
      expect(text).toBe("Progress (from the lane's last report): Review pending");
    } else {
      expect(text).toContain("Internal lead detail WAIT ");
      expect(text).toContain("internal vendor escalation");
    }
    expect(f.reports.read(f.lane.key)?.lastReport).toEqual(entry);
    const posted = await deps.registry.read(f.lane.key);
    expect(posted?.lastPostedReportId).toBe(id);
    expect(posted?.lastPostedReportOwner).toBe(policy.owner);
    expect(posted?.lastPostedReport).toContain("internal vendor escalation");
    f.advance(30 * 60_000);
    await freshnessTick(deps, "/home/test");
    expect(f.world.calls.filter((call) => call[0] === "notify")).toHaveLength(1);
  } finally {
    output.mockRestore();
    f.done();
  }
});
