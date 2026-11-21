import { randomUUID } from "node:crypto";
import { closeSync, fsyncSync, openSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";

/** A marker that cannot replace an existing owner, even after a crash. Requires a trusted local state directory. */
export function tryScheduleOwnership(path: string): (() => void) | undefined {
  let fd: number;
  try {
    fd = openSync(path, "wx", 0o600);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") return undefined;
    throw error;
  }
  const identity = JSON.stringify({ pid: process.pid, nonce: randomUUID() }) + "\n";
  try {
    writeFileSync(fd, identity);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  let released = false;
  return () => {
    if (released) return;
    if (readFileSync(path, "utf8") !== identity) throw new Error("schedule ownership marker changed; preserved it");
    unlinkSync(path);
    released = true;
  };
}
