import { type Cli, type Command, die } from "./cli-context.ts";
import { reportCommandError } from "./cli-errors.ts";
import { USAGE } from "./cli-usage.ts";

export function validateScheduleOptions(
  command: "schedule" | "scheduler",
  tokens: readonly { kind: string; name?: string; inlineValue?: boolean | undefined }[],
): void {
  if (command === "scheduler" && (tokens.length > 1 || tokens.some((t) => t.kind !== "option" || t.name !== "loop")))
    die("usage: dori scheduler [--loop MIN]");
  if (command === "schedule")
    for (const token of tokens) {
      if (token.kind === "option" && token.inlineValue && (token.name === "system" || token.name === "ack-interrupted"))
        die(`--${token.name} is a boolean flag; pass it without a value`);
    }
}

export async function invokeCommand(cli: Cli, commands: Readonly<Record<string, Command>>): Promise<void> {
  const handler = Object.hasOwn(commands, cli.command) ? commands[cli.command] : undefined;
  if (!handler) {
    console.log(USAGE);
    process.exit(cli.command ? 1 : 0);
  }
  try {
    await handler(cli);
  } catch (error) {
    await reportCommandError(error, cli.command);
  }
}
