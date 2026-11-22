import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { isJsonObject, type JsonValue, OgbError } from "@standin/contracts";
import { hashPluginDirectory, resolveInside } from "./files.ts";
import { parseManifest, type PluginManifest } from "./manifest.ts";

export interface SkillInfo {
  name: string;
  description: string;
  /** Path of SKILL.md relative to the plugin directory. */
  path: string;
}

export interface McpServerEntry {
  name: string;
  config: { [key: string]: JsonValue };
}

export interface LoadedPlugin {
  manifest: PluginManifest;
  /** The directory the plugin is loaded from (the read-only cache copy after an install). */
  root: string;
  skills: SkillInfo[];
  mcpServers: McpServerEntry[];
  /** Text of the file named by `promptSection`, when there is one. */
  promptSection?: string;
  /** `sha256:...` of all files. */
  hash: string;
}

/** Reads `name:` and `description:` from the frontmatter of a SKILL.md (the same format as Codex plugins). */
export function parseSkillFrontmatter(text: string): { name?: string; description?: string } {
  const match = /^---\r?\n([\s\S]*?)\r?\n---/.exec(text);
  if (!match) return {};
  const result: { name?: string; description?: string } = {};
  for (const line of (match[1] as string).split(/\r?\n/)) {
    const field = /^(name|description):\s*(.*)$/.exec(line);
    if (field) result[field[1] as "name" | "description"] = (field[2] as string).replace(/^["']|["']$/g, "").trim();
  }
  return result;
}

function readSkills(root: string): SkillInfo[] {
  const base = join(root, "skills");
  if (!existsSync(base)) return [];
  const skills: SkillInfo[] = [];
  for (const dir of readdirSync(base).sort()) {
    const relative = `skills/${dir}/SKILL.md`;
    if (!existsSync(join(root, relative))) continue;
    resolveInside(root, relative);
    const front = parseSkillFrontmatter(readFileSync(join(root, relative), "utf8"));
    if (!front.name || !front.description) throw new OgbError("invalid_input", `${relative}: the frontmatter needs name and description`);
    if (front.name !== dir) throw new OgbError("invalid_input", `${relative}: the skill name '${front.name}' must equal its directory '${dir}'`);
    skills.push({ name: front.name, description: front.description, path: relative });
  }
  return skills;
}

function readMcpServers(root: string): McpServerEntry[] {
  if (!existsSync(join(root, "mcp.json"))) return [];
  resolveInside(root, "mcp.json");
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(join(root, "mcp.json"), "utf8"));
  } catch (cause) {
    throw new OgbError("invalid_input", "mcp.json is not valid JSON", { cause });
  }
  if (!isJsonObject(parsed) || !isJsonObject(parsed.mcpServers)) throw new OgbError("invalid_input", "mcp.json must have an 'mcpServers' object");
  return Object.entries(parsed.mcpServers).map(([name, config]) => {
    if (!isJsonObject(config)) throw new OgbError("invalid_input", `mcp.json: server '${name}' must be an object`);
    return { name, config };
  });
}

/**
 * Reads one plugin directory: manifest, skills, MCP servers, content hash. Does not run any plugin code, so loading is
 * safe to do for a plugin the owner has not accepted yet. The onboarding skill, when named, must exist.
 */
export function loadPluginDirectory(root: string): LoadedPlugin {
  const manifestPath = join(root, "plugin.json");
  if (!existsSync(manifestPath)) throw new OgbError("not_found", "plugin.json is missing");
  let json: unknown;
  try {
    json = JSON.parse(readFileSync(manifestPath, "utf8"));
  } catch (cause) {
    throw new OgbError("invalid_input", "plugin.json is not valid JSON", { cause });
  }
  const manifest = parseManifest(json);
  for (const key of ["tools", "sources"] as const) {
    const path = manifest.ogb[key];
    if (path !== undefined) resolveInside(root, path);
  }
  const skills = readSkills(root);
  const onboarding = manifest.ogb.onboardingSkill;
  if (onboarding !== undefined && !skills.some((s) => s.name === onboarding))
    throw new OgbError("invalid_input", `onboardingSkill '${onboarding}' is not in skills/`);
  const loaded: LoadedPlugin = { manifest, root, skills, mcpServers: readMcpServers(root), hash: hashPluginDirectory(root) };
  const section = manifest.ogb.promptSection;
  if (section !== undefined) loaded.promptSection = readFileSync(resolveInside(root, section), "utf8").trim();
  return loaded;
}
