import type { Clock } from "../run.ts";

export type HttpRequest = {
  readonly method: "GET" | "POST" | "PATCH" | "PUT" | "DELETE";
  readonly url: string;
  /** Explicit read-only RPCs may use POST; unknown operations remain mutations. */
  readonly readOnly?: boolean;
  /** Safe operation label, never a credential-bearing URL. */
  readonly operation?: string;
  readonly headers?: Readonly<Record<string, string>>;
  readonly body?: string | FormData | Uint8Array<ArrayBuffer>;
};
export type HttpResponse = {
  readonly status: number;
  readonly headers: Readonly<Record<string, string>>;
  readonly body: string;
};
export type Http = (req: HttpRequest) => Promise<HttpResponse>;

export const fetchHttp: Http = async (req) => {
  const res = await fetch(req.url, {
    method: req.method,
    ...(req.headers === undefined ? {} : { headers: req.headers }),
    ...(req.body === undefined ? {} : { body: req.body }),
  });
  const headers: Record<string, string> = {};
  res.headers.forEach((v, k) => {
    headers[k.toLowerCase()] = v;
  });
  return { status: res.status, headers, body: await res.text() };
};

export class MessengerError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code?: string,
    readonly outcome: "rejected" | "uncertain" | "confirmed" = "rejected",
    readonly receipt?: { readonly channel: string; readonly messageId: string },
  ) {
    super(message);
  }
}

export class DeliveryUncertainError extends MessengerError {
  constructor(operation: string, status = 0) {
    super(
      `${operation}: delivery uncertain${status ? ` (HTTP ${status})` : ""}; the request may have succeeded; do not resend. Inspect the original remote target and reconcile its IDs before retrying.`,
      status,
      "DELIVERY_UNCERTAIN",
      "uncertain",
    );
  }
}

export class UnsafeMessageError extends Error {}

export const guardText = (text: string): string => {
  if (text.includes("$("))
    throw new UnsafeMessageError("message text contains $( ; build messages as data, never through a shell string");
  return text;
};

export type RetryPolicy = { readonly attempts: number; readonly baseMs: number; readonly maxMs: number };
export const DEFAULT_RETRY: RetryPolicy = { attempts: 5, baseMs: 1_000, maxMs: 60_000 };

export const withBackoff = async (
  http: Http,
  clock: Clock,
  req: HttpRequest,
  policy: RetryPolicy = DEFAULT_RETRY,
  retryAfterFromBody?: (body: string) => number | undefined,
): Promise<HttpResponse> => {
  const mutation = req.method !== "GET" && req.readOnly !== true;
  const operation = req.operation ?? `messenger ${req.method}`;
  let last: HttpResponse | undefined;
  for (let attempt = 0; attempt < policy.attempts; attempt++) {
    try {
      last = await http(req);
    } catch (error) {
      if (mutation) {
        const code = error !== null && typeof error === "object" && "code" in error ? error.code : undefined;
        const safeCode =
          typeof code === "string" &&
          ["ECONNREFUSED", "ECONNRESET", "ENOTFOUND", "ETIMEDOUT", "EAI_AGAIN"].includes(code)
            ? ` (${code})`
            : "";
        throw new DeliveryUncertainError(`${operation}${safeCode}`);
      }
      throw error;
    }
    if (mutation && (last.status === 408 || last.status >= 500))
      throw new DeliveryUncertainError(operation, last.status);
    // Platform 429 responses reject the request; 5xx on reads can be retried safely.
    if (last.status !== 429 && last.status < 500) return last;
    const header = Number(last.headers["retry-after"]);
    const fromBody = retryAfterFromBody?.(last.body);
    const waitS = [header, fromBody].find(
      (seconds) => seconds !== undefined && Number.isFinite(seconds) && seconds > 0,
    );
    const waitMs = waitS !== undefined ? waitS * 1000 : Math.min(policy.maxMs, policy.baseMs * 2 ** attempt);
    if (attempt < policy.attempts - 1) await clock.sleep(last.status === 429 ? waitMs : Math.min(policy.maxMs, waitMs));
  }
  return last as HttpResponse;
};
