import { resolve } from "node:path";
import type * as NativeStorage from "./node_modules/@oh-my-pi/pi-coding-agent/dist/types/session/agent-storage.d.ts";

const host = resolve(import.meta.dir);
const { AgentStorage }: typeof NativeStorage = await import(
  Bun.resolveSync("@oh-my-pi/pi-coding-agent/session/agent-storage", host)
);

/** Release process-cached agent.db handles before deleting an isolated native fixture. */
export const closeNativeStorage = (): void => AgentStorage.close();
