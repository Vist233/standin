import { createHash } from "node:crypto";
import { lstatSync, readdirSync, readFileSync, realpathSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { OgbError } from "@standin/contracts";

const SKIPPED = new Set([".git", "node_modules"]);

/** Every file of a plugin as a sorted list of relative paths. Symlinks are refused: a plugin is plain files, so what is hashed is what runs. */
export function listPluginFiles(root: string): string[] {
  const found: string[] = [];
  const walk = (dir: string) => {
    for (const name of readdirSync(dir).sort()) {
      if (SKIPPED.has(name)) continue;
      const path = join(dir, name);
      const info = lstatSync(path);
      if (info.isSymbolicLink()) throw new OgbError("denied", `plugin contains a symbolic link (${relative(root, path)}); plugins must be plain files`);
      if (info.isDirectory()) walk(path);
      else if (info.isFile()) found.push(relative(root, path).split(sep).join("/"));
    }
  };
  walk(root);
  return found;
}

/** A hash of names and contents of all files, so a changed or added byte changes it. Format: `sha256:<hex>`. */
export function hashPluginDirectory(root: string): string {
  const hash = createHash("sha256");
  for (const file of listPluginFiles(root)) {
    const content = readFileSync(join(root, file));
    hash.update(`${file}\0${content.length}\0`);
    hash.update(content);
    hash.update("\0");
  }
  return `sha256:${hash.digest("hex")}`;
}

/** Resolves a path inside a plugin and checks it is still inside after links are followed. */
export function resolveInside(root: string, path: string): string {
  const full = join(root, path);
  const realRoot = realpathSync(root);
  let real: string;
  try {
    real = realpathSync(full);
  } catch (cause) {
    throw new OgbError("not_found", `plugin file '${path}' does not exist`, { cause });
  }
  if (real !== realRoot && !real.startsWith(realRoot + sep)) throw new OgbError("denied", `plugin path '${path}' leaves the plugin directory`);
  return real;
}
