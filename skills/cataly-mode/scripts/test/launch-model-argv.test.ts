import { expect, test } from "bun:test";
import { modelLaunchCommand, modelLaunchProblem } from "../src/launch-model.ts";

test("the launch guard stays in the native option region and never becomes an initial message", () => {
  const template = ["omp", "--cataly-role", "lane", "--model", "{model}", "--", "{prompt}"];
  expect(modelLaunchProblem(template, "subscription/exact")).toBeNull();
  expect(modelLaunchCommand(template, "subscription/exact", "Do the work")).toEqual([
    "omp",
    "--cataly-launch-model=subscription/exact",
    "--cataly-role=lane",
    "--model=subscription/exact",
  ]);
  expect(modelLaunchProblem([...template, "another message"], "subscription/exact")).not.toBeNull();
});

test("native launch preserves env and package-runner option separators", () => {
  for (const prefix of [
    ["env", "-i", "--"],
    ["npm", "exec", "--"],
    ["npx", "--yes", "--"],
  ]) {
    const template = [...prefix, "omp", "--model", "{model}", "--", "{prompt}"];
    expect(modelLaunchProblem(template, "subscription/exact")).toBeNull();
    expect(modelLaunchCommand(template, "subscription/exact", "Do the work")).toEqual([
      ...prefix,
      "omp",
      "--cataly-launch-model=subscription/exact",
      "--model=subscription/exact",
    ]);
  }
});

test("native option values and an overriding text mode remain eligible for verified delivery", () => {
  const template = [
    "omp",
    "--append-system-prompt",
    "--print",
    "--mode",
    "json",
    "--mode",
    "text",
    "--model",
    "{model}",
    "{prompt}",
  ];
  expect(modelLaunchProblem(template, "subscription/exact", true)).toBeNull();
  const command = modelLaunchCommand(template, "subscription/exact", "Do the work");
  expect(command).toContain("--append-system-prompt=--print");
  expect(command).toContain("--cataly-launch-model=subscription/exact");
  expect(command).not.toContain("Do the work");
});

test("native launch refuses initial positional, file and automatic work in its template", () => {
  for (const initial of [["Do work now"], ["@/tmp/brief.md"], ["--goal", "Do work now"], ["--restore"]]) {
    expect(
      modelLaunchProblem(["omp", "--model", "{model}", ...initial, "{prompt}"], "subscription/exact"),
    ).not.toBeNull();
  }
});
