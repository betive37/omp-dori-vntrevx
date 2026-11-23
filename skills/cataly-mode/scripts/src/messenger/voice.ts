import { closeSync, mkdtempSync, openSync, rmSync, writeFileSync } from "node:fs";
import { audioMimes } from "./audio-signature.ts";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { type ArgvTemplate, fill } from "../config.ts";
import type { Runner } from "../run.ts";

export class TranscriptionError extends Error {}

/** The platform resolver keeps credentials and resource URLs inside the immediate download. */
export type RemoteMedia = (
  signal: AbortSignal,
  maxBytes: number,
) => Promise<{
  name: string;
  response: Response;
  expectedSize: number;
}>;

/** Local paths stay untouched; only this invocation owns the downloaded file and directory. */
export const withLocalFile = async (
  source: string | RemoteMedia,
  maxBytes: number,
  use: (file: string) => Promise<string>,
  audio = true,
): Promise<string> => {
  if (typeof source === "string" && !/^https?:\/\//i.test(source)) return await use(source);
  const command = audio ? "transcribe" : "download";
  const kind = audio ? "audio" : "file";
  const limit = audio ? "transcribeMaxBytes" : "--max-bytes";
  if (!Number.isSafeInteger(maxBytes) || maxBytes <= 0)
    throw new TranscriptionError(`${command}: invalid ${limit}; set ${limit} to a positive safe integer byte count`);
  const rejected = (reason: string, fix: string): TranscriptionError =>
    new TranscriptionError(`${command}: ${reason}; ${fix} (${audio ? "config: " : ""}${limit}=${maxBytes})`);
  const dir = mkdtempSync(join(tmpdir(), `cataly-${kind}-`));
  try {
    let file: string;
    const abort = new AbortController();
    try {
      let opened: { name: string; response: Response; expectedSize?: number };
      if (typeof source === "string") {
        const url = new URL(source);
        opened = { name: basename(url.pathname) || kind, response: await fetch(url, { signal: abort.signal }) };
      } else opened = await source(abort.signal, maxBytes);
      const { response, expectedSize } = opened;
      const capacity = Math.min(maxBytes, expectedSize ?? maxBytes);
      if (!response.ok) throw rejected(`GET answered ${response.status}`, "check access or use a local file");
      const declared = response.headers.get("content-length");
      // Content-Length can include compression overhead; SDK size bounds decoded bytes below.
      if (declared !== null && /^\d+$/.test(declared) && Number(declared) > maxBytes)
        throw rejected(`declared ${kind} size exceeds the limit`, `use smaller ${kind} or raise ${limit}`);
      if (!response.body) throw rejected(`URL response has no ${kind} body`, `provide ${kind} or use a local file`);
      file = join(dir, basename(opened.name) || kind);
      const fd = openSync(file, "wx+", 0o600);
      try {
        const reader = response.body.getReader();
        let total = 0;
        try {
          for (;;) {
            const chunk = await reader.read();
            if (chunk.done) break;
            // Count actual, decompressed bytes. Missing, zero or dishonest metadata never grants extra capacity.
            if (chunk.value.byteLength > capacity - total)
              throw rejected(`downloaded ${kind} exceeds the limit`, `use smaller ${kind} or raise ${limit}`);
            writeFileSync(fd, chunk.value);
            total += chunk.value.byteLength;
          }
        } finally {
          reader.releaseLock();
        }
        if (expectedSize !== undefined && total !== expectedSize)
          throw rejected(
            "attachment size does not match metadata",
            "check the original attachment or use a local file",
          );
        if (audio) {
          if (total === 0) throw rejected("URL audio is empty", "provide nonempty audio or use a local file");
          const mimes = audioMimes(fd, total);
          if (!mimes.length)
            throw rejected(
              "unsupported or truncated audio signature",
              "convert to WAV, MP3, Ogg, M4A or FLAC, or use a local file",
            );
          const mime = response.headers.get("content-type")?.split(";")[0]?.trim().toLowerCase();
          if (mime && !["application/octet-stream", "binary/octet-stream"].includes(mime) && !mimes.includes(mime))
            throw rejected(
              "Content-Type does not match the audio signature",
              "correct the server MIME type or use a local file",
            );
        }
      } finally {
        closeSync(fd);
      }
    } catch (error) {
      if (error instanceof TranscriptionError) throw error;
      throw rejected(`could not download ${kind}`, "check the URL/network and temporary storage, or use a local file");
    } finally {
      // Also abort unopened/error response bodies; never keep receiving after a limit failure.
      abort.abort();
    }
    return await use(file);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
};

export const transcribe = async (run: Runner, hook: ArgvTemplate | undefined, audioPath: string): Promise<string> => {
  if (!hook?.length) throw new TranscriptionError("no hooks.transcribe configured");
  const r = await run(fill(hook, { file: audioPath }));
  const text = r.out.trim();
  if (r.code !== 0 || !text)
    throw new TranscriptionError(`transcription failed (exit ${r.code}): ${r.err.slice(0, 160)}`);
  return text;
};

export const withLocalAudio = (
  source: string | RemoteMedia,
  maxBytes: number,
  use: (file: string) => Promise<string>,
): Promise<string> => withLocalFile(source, maxBytes, use);
