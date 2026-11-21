/** A cursor failure must stop polling rather than acknowledge an uncertain write. */
export class TelegramCursorError extends Error {}
