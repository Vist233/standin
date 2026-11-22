import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { PluginLogger } from "@standin/contracts";

export const silentLog: PluginLogger = { info: () => {}, warn: () => {}, error: () => {} };

/** Short path on purpose: a Unix socket path is limited to about 100 bytes. */
export function tempRoot(): { dir: string; remove(): void } {
  const dir = mkdtempSync(join(tmpdir(), "ogbd-"));
  return { dir, remove: () => rmSync(dir, { recursive: true, force: true }) };
}

export async function eventually<T>(read: () => T | Promise<T>, accept: (value: T) => boolean, timeoutMs = 8000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await read();
    if (accept(value)) return value;
    if (Date.now() > deadline) throw new Error(`condition not met in ${timeoutMs} ms; last value: ${JSON.stringify(value)}`);
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

export function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}
