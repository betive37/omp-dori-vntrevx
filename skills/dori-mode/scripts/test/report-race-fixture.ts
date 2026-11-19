import { expect } from "bun:test";

export async function marker(stream: ReadableStream<Uint8Array>, expected: string): Promise<void> {
  const reader = stream.getReader();
  let text = "";
  try {
    while (!text.includes("\n")) {
      const next = await reader.read();
      if (next.done) throw new Error(`child exited before ${expected}: ${text}`);
      text += new TextDecoder().decode(next.value);
    }
    expect(text.split("\n")[0]).toBe(expected);
  } finally {
    reader.releaseLock();
  }
}
