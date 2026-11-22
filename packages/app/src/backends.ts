import { existsSync } from "node:fs";
import { join } from "node:path";
import type { StartupLine } from "@vesper/contracts";

/** Where agent-tools keeps the runners of the browser and computer tools (scripts/sync-agent-tools.sh copies it to vendor/). */
const BROWSER_RUNNER = ["vendor", "agent-tools", "dist", "browser", "runner.js"];
const DESKTOP_RUNNER = ["vendor", "agent-tools", "dist", "computer", "runner", "runner.py"];

export interface BackendReport {
  browser: boolean;
  desktop: boolean;
  lines: StartupLine[];
}

/** Looks, without starting anything, for the runners of the browser and computer tools, so the start-up line can say what will not work. */
export function checkBackends(appRoot: string): BackendReport {
  const browser = existsSync(join(appRoot, ...BROWSER_RUNNER));
  const desktop = existsSync(join(appRoot, ...DESKTOP_RUNNER));
  return {
    browser,
    desktop,
    lines: [
      browser
        ? { level: "info", text: "browser tool: the agent-tools runner is present" }
        : {
            level: "warn",
            text: "browser tool: vendor/agent-tools is missing (run scripts/sync-agent-tools.sh), so the browser tool will answer with an error",
          },
      desktop
        ? { level: "info", text: "computer tool: the agent-tools runner is present" }
        : {
            level: "warn",
            text: "computer tool: vendor/agent-tools is missing (run scripts/sync-agent-tools.sh), so the computer tool will answer with an error",
          },
    ],
  };
}
