#!/usr/bin/env node
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import type { PluginLogger } from "@vesper/contracts";
import { defaultConfig, parseViewFilter } from "./config.ts";
import { DeskHost } from "./host.ts";
import { serveWorkspaceHost } from "./server.ts";

/** Structured JSON logs on standard error, one object per line (docs/09: module, workspace, ... as fields). */
function jsonLogger(): PluginLogger {
  const write = (level: string) => (message: string, fields?: Record<string, unknown>) =>
    process.stderr.write(`${JSON.stringify({ at: new Date().toISOString(), level, module: "desk-daemon", message, ...fields })}\n`);
  return { info: write("info"), warn: write("warn"), error: write("error") };
}

/** Configuration comes from the environment; only paths and numbers, no secrets. */
function configFromEnvironment() {
  const env = process.env;
  const dataDir = env.OGB_DESK_DATA_DIR ?? "/data/desk";
  return defaultConfig({
    dataDir,
    socketPath: env.OGB_DESK_SOCKET ?? "/run/ogb/desk-daemon.sock",
    ...(env.OGB_X11_DIR ? { x11Dir: env.OGB_X11_DIR } : {}),
    ...(env.OGB_CHROMIUM_PATH ? { chromium: { command: env.OGB_CHROMIUM_PATH } } : {}),
    viewFilter: parseViewFilter(env.OGB_DESK_VIEW_FILTER),
    ...(env.OGB_DESK_A11Y === "off" ? {} : { accessibilityBus: { command: "dbus-daemon" } }),
    ...(env.OGB_MAX_WORKSPACES ? { maxWorkspaces: Number(env.OGB_MAX_WORKSPACES) } : {}),
  });
}

async function main(): Promise<void> {
  const log = jsonLogger();
  const config = configFromEnvironment();
  mkdirSync(dirname(config.socketPath), { recursive: true });
  mkdirSync(config.dataDir, { recursive: true });
  const host = new DeskHost(config, log);
  const server = await serveWorkspaceHost(host, { socketPath: config.socketPath });
  log.info("desk-daemon listening", { socket: config.socketPath });
  const stop = () => {
    server.close();
    void host.shutdown().finally(() => process.exit(0));
  };
  process.once("SIGTERM", stop);
  process.once("SIGINT", stop);
}

main().catch((error) => {
  process.stderr.write(`desk-daemon failed to start: ${String(error)}\n`);
  process.exit(1);
});
