import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { checkBackends } from "../src/backends.ts";

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});
const root = () => {
  const dir = mkdtempSync(join(tmpdir(), "ogb-be-"));
  dirs.push(dir);
  return dir;
};

describe("what the start-up line says about the browser and computer tools", () => {
  it("warns, with the fix, when agent-tools is not in vendor/", () => {
    const report = checkBackends(root());
    expect(report).toMatchObject({ browser: false, desktop: false });
    expect(report.lines.every((line) => line.level === "warn" && line.text.includes("scripts/sync-agent-tools.sh"))).toBe(true);
  });

  it("finds both runners where the sync script puts them", () => {
    const dir = root();
    mkdirSync(join(dir, "vendor", "agent-tools", "dist", "browser"), { recursive: true });
    mkdirSync(join(dir, "vendor", "agent-tools", "dist", "computer", "runner"), { recursive: true });
    writeFileSync(join(dir, "vendor", "agent-tools", "dist", "browser", "runner.js"), "");
    writeFileSync(join(dir, "vendor", "agent-tools", "dist", "computer", "runner", "runner.py"), "");
    const report = checkBackends(dir);
    expect(report).toMatchObject({ browser: true, desktop: true });
    expect(report.lines.every((line) => line.level === "info")).toBe(true);
  });

  it("finds them in this repository", () => {
    expect(checkBackends(join(import.meta.dirname, "..", "..", ".."))).toMatchObject({ browser: true, desktop: true });
  });
});
