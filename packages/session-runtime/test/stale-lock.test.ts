import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createRig } from "../src/testing/index.ts";

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("a restart of the box (testers' B-12)", () => {
  it("opens every session again although its old lock names a pid that is alive now (the container reused it)", async () => {
    const root = mkdtempSync(join(tmpdir(), "ogb-lock-"));
    dirs.push(root);
    const before = createRig({ root });
    const made = await before.runtime.createSession({});
    await before.cleanup();

    // What the previous run left behind after `docker restart`: a lock whose pid now belongs to another live process.
    const lock = join(root, "sessions", made.id, "agent.jsonl.lock");
    writeFileSync(lock, String(process.ppid));

    const after = createRig({ root });
    try {
      expect(await after.runtime.resumeAll()).toEqual({ opened: [made.id], failed: [] });
      expect(existsSync(lock)).toBe(true);
      expect(readFileSync(lock, "utf8")).toBe(String(process.pid)); // held by this process now
    } finally {
      await after.cleanup();
    }
  });
});
