import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type * as NativeConfig from "../../test/fixtures/omp-native-host/node_modules/@oh-my-pi/pi-coding-agent/dist/types/config/settings.d.ts";

const host = resolve(import.meta.dir, "../../test/fixtures/omp-native-host");
const { Settings, withActiveSettings }: typeof NativeConfig = await import(
  Bun.resolveSync("@oh-my-pi/pi-coding-agent/config/settings", host)
);
import type { AsyncJobSnapshot } from "@oh-my-pi/pi-coding-agent";

import type { CommandOptions as Command, CatalyApi, CatalyContext, ToolDefinition as Tool } from "../index";

export const calls: string[] = [];

export type Entry = {
  id?: string;
  type: string;
  model?: string;
  thinkingLevel?: string | null;
  configured?: string | null;
  customType?: string;
  data?: unknown;
  mode?: string;
  message?: unknown;
};
export type FakeSession = { id: string; file?: string; entries: Entry[] };
type Agent = CatalyContext["agent"];
export type FakeOptions = {
  session: FakeSession;
  flags?: Record<string, string>;
  agent?: Agent;
  mode?: CatalyContext["mode"];
  hasUI?: boolean;
  active?: string[];
  model?: CatalyContext["model"];
  catalog?: NonNullable<CatalyContext["model"]>[];
  subscription?: boolean;
  settings?: NativeConfig.Settings;
  thinkingLevel?: string;
  thinking?: string;
  autoThinking?: boolean;
  native?: CatalyApi["pi"];
  idle?: boolean;
  pendingMessages?: boolean;
  asyncJobs?: ReturnType<NonNullable<CatalyContext["getAsyncJobSnapshot"]>>;
  descendantJobs?: readonly unknown[];
  setModel?: (model: NonNullable<CatalyContext["model"]>) => Promise<boolean>;
};

export type FakePi = {
  api: CatalyApi;
  settings: NativeConfig.Settings;
  handlers: Map<string, Array<(event: unknown, ctx: CatalyContext) => unknown>>;
  commands: Map<string, Command>;
  tools: Map<string, Tool>;
  active: string[];
  messages: Array<{ content: string; options: unknown }>;
  userMessages: string[];
  notes: string[];
  statuses: Map<string, string>;
  session: FakeSession;
  /** The agent the next context names; a subagent's context reads its own jobs. */
  agent: Agent;
  /** What `getAsyncJobSnapshot` returns; null is OMP's "no job manager". */
  jobs: AsyncJobSnapshot | null;
  ctx(): CatalyContext;
  /** Runs handlers in registration order, chaining before_agent_start prompt replacements as OMP does. */
  emit(event: string, payload?: unknown): Promise<unknown[]>;
  command(name: string, args?: string): Promise<void>;
};

const schema = { optional: () => schema, describe: () => schema };

export const fakePi = (options: FakeOptions): FakePi => {
  const flags = new Map<string, boolean | string>(Object.entries(options.flags ?? {}));
  const agent: Agent = options.agent ?? { kind: "main", id: "Main" };
  const settings = options.settings ?? Settings.isolated();
  const nativeListeners = new Set<(event: { readonly type: string }) => void>();
  const fake: FakePi = {
    settings,
    handlers: new Map(),
    commands: new Map(),
    tools: new Map(),
    active: options.active ?? ["read", "bash"],
    messages: [],
    userMessages: [],
    notes: [],
    statuses: new Map(),
    session: options.session,
    agent: options.agent ?? { kind: "main", id: "Main" },
    jobs: options.asyncJobs ?? null,
    ctx: () => ({
      cwd: tmpdir(),
      abort: () => void calls.push("abort"),
      isIdle: () => options.idle ?? true,
      hasPendingMessages: () => options.pendingMessages ?? false,
      getAsyncJobSnapshot: () => fake.jobs,
      mode: options.mode ?? "print",
      ...(options.hasUI === undefined ? {} : { hasUI: options.hasUI }),
      agent: fake.agent,
      get model() {
        return options.model;
      },
      modelRegistry: {
        getAvailableForProviders: (providers) =>
          (options.catalog ?? (options.model ? [options.model] : [])).filter(
            (model) => !!model.provider && providers.has(model.provider),
          ),
        isUsingSubscription: () => options.subscription ?? false,
      },
      sessionManager: {
        getSessionId: () => fake.session.id,
        getSessionFile: () => fake.session.file,
        getBranch: () => [...fake.session.entries],
        getEntries: () => [...fake.session.entries],
      },
      ui: {
        notify: (message: string) => void fake.notes.push(message),
        setStatus: (key, text) => {
          if (text === undefined) fake.statuses.delete(key);
          else fake.statuses.set(key, text);
        },
      },
    }),
    emit: async (event, payload = { type: event }) => {
      for (const listener of [...nativeListeners]) listener({ type: event });
      const results: unknown[] = [];
      let current = payload;
      for (const handler of [...(fake.handlers.get(event) ?? [])]) {
        // Native runs every handler in its session's settings scope.
        const result = await withActiveSettings(settings, () => handler(current, fake.ctx()));
        results.push(result);
        if (
          event === "before_agent_start" &&
          result &&
          typeof result === "object" &&
          "systemPrompt" in result &&
          result.systemPrompt !== undefined
        ) {
          current = {
            ...(typeof current === "object" && current !== null ? current : {}),
            systemPrompt: typeof result.systemPrompt === "string" ? [result.systemPrompt] : result.systemPrompt,
          };
        }
      }
      return results;
    },
    command: async (name, args = "") => {
      const command = fake.commands.get(name);
      if (!command) throw new Error(`no command ${name}`);
      await withActiveSettings(settings, () => command.handler(args, fake.ctx()));
    },
    api: {
      pi: options.native ?? {
        MAIN_AGENT_ID: agent.kind === "main" ? agent.id : "Main",
        AgentRegistry: { global: () => ({ get: () => ({ session: nativeSession }) }) },
      },
      getThinkingLevel: () => options.thinking ?? options.thinkingLevel,
      setModel: async (model) => {
        const accepted = options.setModel ? await options.setModel(model) : true;
        if (accepted) options.model = model;
        return accepted;
      },
      zod: {
        object: () => schema,
        string: () => schema,
        number: () => schema,
        array: () => schema,
        enum: () => schema,
        union: () => schema,
      },
      setLabel: () => {},
      registerFlag: (name, flag) => {
        if (flag.default !== undefined && !flags.has(name)) flags.set(name, flag.default);
      },
      getFlag: (name) => flags.get(name),
      registerCommand: (name, command) => void fake.commands.set(name, command),
      registerTool: (tool) => void fake.tools.set(tool.name, tool as Tool),
      on: (event: string, handler: (event: never, ctx: CatalyContext) => unknown) => {
        const list = fake.handlers.get(event) ?? [];
        list.push(handler as (event: unknown, ctx: CatalyContext) => unknown);
        fake.handlers.set(event, list);
      },
      appendEntry: (customType, data) => void fake.session.entries.push({ type: "custom", customType, data }),
      sendMessage: (message, sendOptions) =>
        void fake.messages.push({ content: message.content, options: sendOptions }),
      sendUserMessage: async (text) => void fake.userMessages.push(text),
      getActiveTools: () => [...fake.active],
      setActiveTools: async (names) => {
        fake.active = [...names];
      },
    },
  };
  const nativeSession = {
    settings,
    sessionManager: {
      ...fake.ctx().sessionManager,
      appendModelChange: (model: string) => void fake.session.entries.push({ type: "model_change", model }),
      appendThinkingLevelChange: (thinkingLevel?: string, configured?: string) =>
        void fake.session.entries.push({
          type: "thinking_level_change",
          thinkingLevel: thinkingLevel ?? null,
          configured: configured ?? null,
        }),
    },
    agent: {
      state: {
        get model() {
          return options.model;
        },
      },
    },
    getAsyncJobTree: () => ({ running: options.descendantJobs ?? [] }),
    configuredThinkingLevel: () => (options.autoThinking ? "auto" : options.thinkingLevel),
    subscribe: (listener: (event: { readonly type: string }) => void) => {
      nativeListeners.add(listener);
      return () => {
        nativeListeners.delete(listener);
      };
    },
  };
  // omp-ulw talks to these too; they are outside omp-dori's own API surface.
  // omp-ulw talks to these too; they are outside omp-cataly's own API surface.
  Object.assign(fake.api, {
    recordTestCall: (event: string) => void calls.push(event),
    getAllTools: () => fake.active.map((name) => ({ name })),
  });
  return fake;
};

/** Points the Cataly config at `ompUlwPath` and a fresh state dir; returns the state dir. */
export const useConfig = (ompUlwPath: string): string => {
  const dir = mkdtempSync(join(tmpdir(), "omp-cataly-ext-"));
  const stateDir = join(dir, "state");
  writeFileSync(join(dir, "config.json"), JSON.stringify({ stateDir, ompUlwPath }));
  process.env.CATALY_CONFIG = join(dir, "config.json");
  delete process.env.CATALY_STATE_DIR;
  return stateDir;
};

export const load = async (options: FakeOptions): Promise<FakePi> => {
  const fake = fakePi(options);
  // The native preparer canonicalizes Cataly's optional host import; only the unit API is fake.
  const { nativeExtensionFactory } = await import("../../test/fixtures/omp-native-host/compose.ts");
  const factory: unknown = await nativeExtensionFactory(join(import.meta.dir, "../index.ts"));
  if (typeof factory !== "function") throw new Error("native Cataly fixture has no factory");
  await factory(fake.api);
  return fake;
};

export const until = async (condition: () => boolean, timeoutMs = 5000): Promise<void> => {
  const deadline = Date.now() + timeoutMs;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error("condition not met in time");
    await Bun.sleep(10);
  }
};
