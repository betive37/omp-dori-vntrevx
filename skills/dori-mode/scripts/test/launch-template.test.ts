import { afterEach, beforeEach, expect, test } from "bun:test";
import { existsSync, mkdirSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { renderTemplate } from "../src/launch-template.ts";
import { TemplateError } from "../src/launch-errors.ts";
import { launchLane, prepareLaunch } from "../src/launch.ts";
import { LaunchQueue } from "../src/launch-queue-store.ts";
import { queueFixture, type QueueFixture } from "./launch-queue-fixture.ts";

let f: QueueFixture;
let config: string;
let templates: string;
beforeEach(async () => {
  f = await queueFixture();
  config = join(f.state.dir, "config.json");
  templates = join(f.state.dir, "templates");
  mkdirSync(templates);
  writeFileSync(config, JSON.stringify(f.deps.config));
});
afterEach(() => f.state.done());
const template = (name: string, text: string) => writeFileSync(join(templates, name + ".md"), text);
const cli = async (...args: string[]) => {
  const p = Bun.spawn([process.execPath, join(import.meta.dir, "../src/cli.ts"), ...args], {
    env: { HOME: f.state.dir, PATH: process.env["PATH"], DORI_CONFIG: config },
    stdout: "pipe",
    stderr: "pipe",
  });
  const [out, err, code] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text(), p.exited]);
  return { out, err, code };
};

test("includes and variables render literally without evaluating shell or replacement syntax", () => {
  template("common", "Check {{target}}.");
  template("deploy", "{{>common}}\nUse {{branch}} and {{branch}}.");
  expect(renderTemplate("deploy", { target: "beta", branch: "$(touch nope) $& {{untouched}}" }, config)).toBe(
    "Check beta.\nUse $(touch nope) $& {{untouched}} and $(touch nope) $& {{untouched}}.",
  );
  expect(existsSync(join(f.state.dir, "nope"))).toBe(false);
});

test("missing variables, malformed expressions and unavailable templates are explicit refusals", () => {
  template("needs", "{{branch}}");
  expect(() => renderTemplate("needs", {}, config)).toThrow("missing template variable");
  template("bad", "{{branch");
  expect(() => renderTemplate("bad", {}, config)).toThrow("malformed");
  expect(() => renderTemplate("absent", {}, config)).toThrow("template unavailable");
  expect(() => renderTemplate("../escape", {}, config)).toThrow("invalid template name");
});

test("include cycles and symlink escapes are rejected by physical file identity", () => {
  template("a", "{{>b}}");
  template("b", "{{>a}}");
  expect(() => renderTemplate("a", {}, config)).toThrow("cycle");
  template("self", "{{>alias}}");
  symlinkSync(join(templates, "self.md"), join(templates, "alias.md"));
  expect(() => renderTemplate("self", {}, config)).toThrow("cycle");
  symlinkSync(f.input.brief, join(templates, "outside.md"));
  expect(() => renderTemplate("outside", {}, config)).toThrow(TemplateError);
});

test("template dry-run has no files, queue, registry or runtime side effects", async () => {
  template("deploy", "Deploy {{branch}} to {{target}}.");
  const result = await cli(
    "launch",
    "from-template",
    "--title",
    "Template run",
    "--template",
    "deploy",
    "--set",
    "branch=main",
    "--set",
    "target=beta",
    "--done",
    "closed acme/app#3",
    "--dry-run",
  );
  expect(result.code).toBe(0);
  expect(result.out).toContain("Deploy main to beta.");
  expect(existsSync(join(f.state.dir, "briefs"))).toBe(false);
  expect(new LaunchQueue(f.state.dir).scan().entries).toEqual([]);
  expect(await f.deps.registry.read("from-template")).toBeNull();
});

test("ordinary preparation remains unchanged and a rendered template uses the normal startup contract", async () => {
  expect((await prepareLaunch(f.deps, f.input)).preamble).toContain("Implement the recorded request");
  template("task", "Implement {{change}}.");
  const brief = join(f.state.dir, "briefs", "rendered.md");
  const started = await launchLane(f.deps, {
    ...f.input,
    brief,
    template: "task",
    variables: { change: "the requested feature" },
  });
  expect(started.startup).toContain("STARTUP_OK");
  expect(await Bun.file(brief).text()).toContain("Implement the requested feature.");
  expect(f.creates()).toBe(1);
});

test("real CLI queues a rendered snapshot, lists it after restart, and explicitly cancels it", async () => {
  template("task", "Implement {{change}}.");
  const queued = await cli(
    "launch",
    f.input.key,
    "--title",
    "Queued template",
    "--template",
    "task",
    "--set",
    "change=the requested feature",
    "--done",
    f.input.done,
    "--after",
    f.prior.key,
  );
  expect(queued.code).toBe(0);
  expect(queued.out).toContain("QUEUED");
  template("task", "Changed template.");
  const listed = await cli("queue", "list");
  expect(listed.code).toBe(0);
  expect(JSON.parse(listed.out)[0].briefText).toContain("Implement the requested feature.");
  expect((await cli("queue", "cancel", f.input.key)).code).toBe(0);
  expect(new LaunchQueue(f.state.dir).read(f.input.key)?.status).toBe("cancelled");
  expect(await f.deps.registry.read(f.input.key)).toBeNull();
});

test("real CLI refuses ambiguous template input and missing values before effects", async () => {
  template("task", "{{required}}");
  const base = ["launch", f.input.key, "--title", "Task", "--done", f.input.done];
  expect((await cli(...base, "--brief", f.input.brief, "--template", "task")).err).toContain(
    "choose --brief or --template",
  );
  expect((await cli(...base, "--template", "task", "--dry-run")).err).toContain("missing template variable");
  expect((await cli(...base, "--template", "task", "--set", "broken")).err).toContain("name=value");
  expect(existsSync(join(f.state.dir, "briefs"))).toBe(false);
});
