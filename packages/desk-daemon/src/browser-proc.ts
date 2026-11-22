import { existsSync, mkdirSync, readdirSync, rmSync } from "node:fs";
import { request } from "node:http";
import { join } from "node:path";
import type { PluginLogger, ScreenSize } from "@standin/contracts";
import type { DaemonConfig } from "./config.ts";
import { SupervisedProcess } from "./supervisor.ts";

export interface BrowserOptions {
  readonly name: string;
  readonly display: string;
  readonly profileDir: string;
  /** Browser home (config and cache directories); private to the workspace. */
  readonly homeDir: string;
  readonly cdpPort: number;
  /** Where the process records its pid (see `sweepStaleProcesses`). */
  readonly runDir: string;
  readonly screen: ScreenSize;
}

/** Flags that make Chromium run headed inside a container. Each one has a reason; see docs/decisions.md D-T3-4. */
export function chromiumArgs(options: BrowserOptions, noSandbox: boolean): string[] {
  return [
    `--user-data-dir=${options.profileDir}`,
    `--remote-debugging-port=${options.cdpPort}`,
    "--remote-debugging-address=127.0.0.1", // never reachable from outside the container
    `--window-size=${options.screen.width},${options.screen.height}`,
    "--window-position=0,0",
    "--no-first-run",
    "--no-default-browser-check",
    "--disable-session-crashed-bubble", // after a kill the next start must not ask about restoring pages
    "--hide-crash-restore-bubble",
    "--disable-dev-shm-usage", // the container's /dev/shm is small; Chromium falls back to /tmp
    "--password-store=basic", // no keyring in the box; cookies stay in the profile
    "--disable-infobars", // hides the "Chrome for Testing is only for automated testing" bar in the live picture
    ...(noSandbox ? ["--no-sandbox", "--test-type"] : []), // --no-sandbox is required as root; --test-type hides the bar that warns about it
    "about:blank",
  ];
}

/** True when `GET /json/version` on the DevTools port answers. */
function cdpAnswers(port: number, timeoutMs = 1000): Promise<boolean> {
  return new Promise((resolve) => {
    const req = request({ host: "127.0.0.1", port, path: "/json/version", timeout: timeoutMs }, (res) => {
      res.resume();
      resolve(res.statusCode === 200);
    });
    req.on("timeout", () => {
      req.destroy();
      resolve(false);
    });
    req.on("error", () => resolve(false));
    req.end();
  });
}

/** Chromium leaves these behind when it is killed; only one Chromium ever uses a profile, so they are stale. */
function removeStaleProfileLocks(profileDir: string): void {
  if (!existsSync(profileDir)) return;
  for (const entry of readdirSync(profileDir)) {
    if (entry.startsWith("Singleton")) rmSync(join(profileDir, entry), { force: true });
  }
}

/** Headed Chromium with its own profile directory and a DevTools port on 127.0.0.1. */
export function createBrowserProcess(options: BrowserOptions, config: DaemonConfig, log: PluginLogger): SupervisedProcess {
  return new SupervisedProcess({
    spec: {
      name: `browser-${options.name}`,
      command: config.chromium.command,
      args: [...(config.chromium.args ?? []), ...chromiumArgs(options, config.noSandbox)],
      env: { DISPLAY: options.display, OGB_X11_DIR: config.x11Dir, HOME: options.homeDir },
    },
    log,
    pidFile: join(options.runDir, "browser.pid"),
    backoff: config.backoff,
    probe: () => cdpAnswers(options.cdpPort),
    probeIntervalMs: config.probeIntervalMs,
    beforeStart: () => {
      mkdirSync(options.profileDir, { recursive: true });
      mkdirSync(options.homeDir, { recursive: true });
      removeStaleProfileLocks(options.profileDir);
    },
  });
}
