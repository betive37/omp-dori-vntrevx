import { afterEach, beforeEach, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { prompt } from "../src/harness.ts";

const skill = readFileSync(new URL("../skills/dori-mode/SKILL.md", import.meta.url), "utf8");
let promptOverride: string | undefined;
beforeEach(() => {
  promptOverride = process.env["DORI_PROMPTS_DIR"];
  delete process.env["DORI_PROMPTS_DIR"];
});
afterEach(() => {
  if (promptOverride === undefined) delete process.env["DORI_PROMPTS_DIR"];
  else process.env["DORI_PROMPTS_DIR"] = promptOverride;
});

for (const [name, render] of Object.entries({
  "lane footer": () => prompt("lane-footer.md", { key: "goal-owner", dori: "dori" }),
  "Dori skill": () => skill,
})) {
  test(`${name} reuses native or durable workflow ownership`, () => {
    const text = render();
    expect(text).toContain("Inspect the current native goal and any selected durable workflow");
    expect(text).toContain("Reuse the owner for this task");
    expect(text).toContain("Active, paused or budget-limited ownership is not an empty slot");
    expect(text).toContain("Do not add a native goal beside a durable workflow");
    expect(text).toContain("a worklog entry or lane registry record alone is not that owner");
    expect(text).toContain("Follow the host's goal and workflow rules");
  });

  test(`${name} keeps paused work paused without a user resume request`, () => {
    const text = render();
    expect(text).toContain("Leave paused work paused unless the user explicitly asks to resume it");
    expect(text).toContain("never replace another objective just to create a new one");
    expect(text).toContain("A nudge or wait event is not a resume request");
  });

  test(`${name} only creates an unowned executable objective`, () => {
    const text = render();
    expect(text).toContain("Only when no owner exists and the request calls for executable work");
    expect(text).toContain("observable `Done =` condition");
    expect(text).toContain("A question, status reply or waiting-only monitor is not a reason to create a goal");
  });
}

test("an external wait preserves ownership instead of creating an availability loop", () => {
  expect(skill).toContain("Waiting for CI, review or a monitor does not create a fresh objective");
  expect(skill).toContain("Keep the existing owner intact and use its event/wait protocol");
  expect(skill).toContain("idle without a standing availability goal");
  expect(skill).toContain("watch`, `freshness`, `dead-panes`, `guard`");
  expect(skill).toContain("reopen a session within the scope of the owner's still-open request for that lane's work");
  expect(skill).toContain("If recovery restores a paused goal, report the held work");
});
