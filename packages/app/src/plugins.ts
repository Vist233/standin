import { existsSync, rmSync } from "node:fs";
import { type InstalledPlugin, installFromMarketplace, makeWritable, parseMarketplace } from "@standin/plugin-host";
import { FIRST_PARTY_PLUGINS } from "./config.ts";

export interface PluginInstall {
  installed: InstalledPlugin[];
  skipped: { name: string; reason: string }[];
}

/**
 * Installs the first-party plugins from the application's own `plugins/` directory into a read-only cache and loads them
 * from there (the plugin host checks hashes and refuses symbolic links). A plugin that cannot be installed is reported and
 * left out; the others still work.
 */
/** The cache is derived from the image, so it is rebuilt at every start: a plugin that changed without a new version would otherwise be refused as a conflict. */
function resetCache(cacheDir: string): void {
  if (!existsSync(cacheDir)) return;
  makeWritable(cacheDir);
  rmSync(cacheDir, { recursive: true, force: true });
}

export function installFirstPartyPlugins(options: { appRoot: string; cacheDir: string; names?: readonly string[] }): PluginInstall {
  resetCache(options.cacheDir);
  const names = options.names ?? FIRST_PARTY_PLUGINS;
  const marketplace = parseMarketplace({ name: "first-party", plugins: names.map((name) => ({ name, source: { type: "local", path: `./plugins/${name}` } })) });
  return installFromMarketplace({ marketplace, baseDir: options.appRoot, cacheDir: options.cacheDir });
}
