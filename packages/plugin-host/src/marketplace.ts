import { chmodSync, cpSync, existsSync, lstatSync, mkdirSync, readdirSync, realpathSync, rmSync } from "node:fs";
import { dirname, join, resolve, sep } from "node:path";
import { isJsonObject, OgbError } from "@standin/contracts";
import { hashPluginDirectory, listPluginFiles } from "./files.ts";
import { isInsidePath } from "./manifest.ts";
import { loadPluginDirectory, type LoadedPlugin } from "./loader.ts";

export type Installation = "AVAILABLE" | "INSTALLED_BY_DEFAULT" | "NOT_AVAILABLE";

export interface MarketplaceEntry {
  name: string;
  source: { type: string; path?: string; [key: string]: unknown };
  /** `sha256:<hex>` of the plugin's files. When present, a plugin with other contents is refused until the owner updates the pin. */
  sha256?: string;
  policy: { installation: Installation; authentication?: "ON_INSTALL" | "ON_USE" };
  category?: string;
}

export interface Marketplace {
  name: string;
  plugins: MarketplaceEntry[];
}

const NAME = /^[a-z0-9]+(-[a-z0-9]+)*$/;
const INSTALLATION = new Set(["AVAILABLE", "INSTALLED_BY_DEFAULT", "NOT_AVAILABLE"]);

/** The catalogue is a JSON file in the Codex shape. Source types other than `local` are kept so a shared catalogue parses, and skipped at install. */
export function parseMarketplace(input: unknown): Marketplace {
  const problems: string[] = [];
  if (!isJsonObject(input)) throw new OgbError("invalid_input", "marketplace.json must hold a JSON object");
  if (typeof input.name !== "string" || !NAME.test(input.name)) problems.push("name: required, kebab-case");
  if (!Array.isArray(input.plugins)) problems.push("plugins: must be a list");
  const plugins: MarketplaceEntry[] = [];
  for (const [index, raw] of (Array.isArray(input.plugins) ? input.plugins : []).entries()) {
    const path = `plugins[${index}]`;
    if (!isJsonObject(raw)) {
      problems.push(`${path}: must be an object`);
      continue;
    }
    const before = problems.length;
    if (typeof raw.name !== "string" || !NAME.test(raw.name)) problems.push(`${path}.name: required, kebab-case`);
    if (!isJsonObject(raw.source) || typeof raw.source.type !== "string") problems.push(`${path}.source: needs a type`);
    else if (raw.source.type === "local" && (typeof raw.source.path !== "string" || !isInsidePath(raw.source.path.replace(/^\.\//, "")))) {
      problems.push(`${path}.source.path: a local source needs a relative path inside the marketplace directory`);
    }
    if (raw.sha256 !== undefined && !(typeof raw.sha256 === "string" && /^sha256:[0-9a-f]{64}$/.test(raw.sha256)))
      problems.push(`${path}.sha256: must be sha256:<64 hex digits>`);
    const policy = isJsonObject(raw.policy) ? raw.policy : {};
    const installation = policy.installation ?? "AVAILABLE";
    if (typeof installation !== "string" || !INSTALLATION.has(installation))
      problems.push(`${path}.policy.installation: must be AVAILABLE, INSTALLED_BY_DEFAULT or NOT_AVAILABLE`);
    if (problems.length === before) {
      plugins.push({ ...(raw as unknown as MarketplaceEntry), policy: { ...policy, installation: installation as Installation } });
    }
  }
  if (problems.length > 0) throw new OgbError("invalid_input", `marketplace.json is invalid:\n- ${problems.join("\n- ")}`);
  return { name: input.name as string, plugins };
}

export interface InstalledPlugin extends LoadedPlugin {
  /** `name@marketplace@version` */
  identity: string;
}

export interface InstallResult {
  installed: InstalledPlugin[];
  /** Entries that could not be installed, with the reason; one bad entry never stops the others. */
  skipped: { name: string; reason: string }[];
}

export interface InstallOptions {
  marketplace: Marketplace;
  /** The directory the marketplace file is in; `local` paths are relative to it and may not leave it. */
  baseDir: string;
  /** Plugins are copied to `<cacheDir>/<marketplace>/<plugin>/<version>/` and loaded from there. */
  cacheDir: string;
  /** Install only these names (default: every entry that is not NOT_AVAILABLE). */
  only?: string[];
}

/**
 * Copies each plugin into the cache, checks the copy's hash against the source and against the owner's pin, makes the
 * copy read-only, and loads it from there. The cache copy is what runs, so a source that changes after the check
 * cannot change what runs.
 */
export function installFromMarketplace(options: InstallOptions): InstallResult {
  const result: InstallResult = { installed: [], skipped: [] };
  for (const entry of options.marketplace.plugins) {
    if (options.only && !options.only.includes(entry.name)) continue;
    if (entry.policy.installation === "NOT_AVAILABLE") {
      result.skipped.push({ name: entry.name, reason: "marked NOT_AVAILABLE" });
      continue;
    }
    try {
      result.installed.push(installOne(entry, options));
    } catch (error) {
      result.skipped.push({ name: entry.name, reason: error instanceof Error ? error.message : String(error) });
    }
  }
  return result;
}

function installOne(entry: MarketplaceEntry, options: InstallOptions): InstalledPlugin {
  if (entry.source.type !== "local" || typeof entry.source.path !== "string") {
    throw new OgbError("unavailable", `source type '${entry.source.type}' is not supported yet (only 'local')`);
  }
  const base = resolve(options.baseDir);
  const source = resolve(base, entry.source.path);
  if (source !== base && !source.startsWith(base + sep)) throw new OgbError("denied", "local source leaves the marketplace directory");
  if (!existsSync(source)) throw new OgbError("not_found", `source '${entry.source.path}' does not exist`);

  const sourceHash = hashPluginDirectory(source);
  if (entry.sha256 !== undefined && entry.sha256 !== sourceHash) {
    throw new OgbError("denied", `contents of '${entry.name}' changed since they were pinned; the owner must review and update the pin in marketplace.json`);
  }
  const probe = loadPluginDirectory(source);
  if (probe.manifest.name !== entry.name)
    throw new OgbError("invalid_input", `plugin.json names '${probe.manifest.name}' but the marketplace lists '${entry.name}'`);

  const target = join(options.cacheDir, options.marketplace.name, entry.name, probe.manifest.version);
  if (existsSync(target)) {
    if (hashPluginDirectory(target) !== sourceHash) {
      throw new OgbError("conflict", `version ${probe.manifest.version} of '${entry.name}' is already installed with different contents; raise the version`);
    }
  } else {
    mkdirSync(dirname(target), { recursive: true });
    // Copy from the real directory: if the source path is itself a link, a copy of the link would point back into the source and
    // making the "cache" read-only would change the source.
    cpSync(realpathSync(source), target, { recursive: true, filter: (path) => !/(^|[\\/])(\.git|node_modules)([\\/]|$)/.test(path) });
    if (hashPluginDirectory(target) !== sourceHash) {
      makeWritable(target);
      rmSync(target, { recursive: true, force: true });
      throw new OgbError("conflict", `'${entry.name}' changed while it was being copied; try again`);
    }
    makeReadOnly(target);
  }
  const loaded = loadPluginDirectory(target);
  return { ...loaded, identity: `${loaded.manifest.name}@${options.marketplace.name}@${loaded.manifest.version}` };
}

function makeReadOnly(root: string): void {
  for (const file of listPluginFiles(root)) chmodSync(join(root, file), 0o444);
  chmodDirectories(root, 0o555);
}

/** Undoes `makeReadOnly`; used before removing a cache directory. */
export function makeWritable(root: string): void {
  chmodDirectories(root, 0o755);
  for (const file of listPluginFiles(root)) chmodSync(join(root, file), 0o644);
}

/** Opening: change the directory first, then enter it. Closing: finish inside first, then lock the directory. */
function chmodDirectories(dir: string, mode: number): void {
  const closing = mode === 0o555;
  if (!closing) chmodSync(dir, mode);
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (lstatSync(path).isDirectory()) chmodDirectories(path, mode);
  }
  if (closing) chmodSync(dir, mode);
}
