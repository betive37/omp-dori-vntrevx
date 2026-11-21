import { die } from "./cli-context.ts";
import { QueueError, TemplateError } from "./launch-errors.ts";

export async function reportCommandError(error: unknown, command: string): Promise<never> {
  if (command === "schedule" || command === "scheduler") {
    const { ScheduleError } = await import("./schedule-types.ts");
    if (error instanceof ScheduleError) return die(error.message);
  }
  const { LaunchError } = await import("./launch.ts");
  const { PolicyError } = await import("./lane-policy.ts");
  const { messengerErrors } = await import("./cli-messenger.ts");
  const { journalErrors } = await import("./cli-journal.ts");
  const { decisionErrors } = await import("./cli-decisions.ts");
  const { prErrors } = await import("./cli-pr.ts");
  const { statusErrors } = await import("./cli-status.ts");
  const launchErrors = [LaunchError, PolicyError, QueueError, TemplateError, ...statusErrors];
  if (
    [...launchErrors, ...messengerErrors, ...journalErrors, ...decisionErrors, ...prErrors].some(
      (type) => error instanceof type,
    )
  )
    return die((error as Error).message);
  throw error;
}
