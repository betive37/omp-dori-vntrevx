export const retryAfter = (body: string): number | undefined => {
  try {
    const n = (JSON.parse(body) as { retry_after?: number }).retry_after;
    return typeof n === "number" ? n : undefined;
  } catch {
    return undefined;
  }
};

export const discordErrorCode = (body: string): string | undefined => {
  try {
    const parsed = JSON.parse(body) as { code?: unknown } | null;
    return typeof parsed?.code === "number" ? String(parsed.code) : undefined;
  } catch {
    return undefined;
  }
};
