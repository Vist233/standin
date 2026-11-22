import { isJsonObject, type JsonValue, OgbError } from "@standin/contracts";

const EFFECTS = ["read", "write", "exec", "network", "irreversible"] as const;
export type Effect = (typeof EFFECTS)[number];
export type ApprovalMode = "auto" | "ask" | "never";

/** Our block in `plugin.json`, under `extensions.vesper` (docs/08 section 2). Everything is optional. */
export interface OgbExtension {
  /** Path of the module with `export function createTools(ctx)`, relative to the plugin directory. */
  tools?: string;
  /** Path of the module with `export function createSources(ctx)`. */
  sources?: string;
  /** JSON schema of the plugin's settings; values come from the accounts file. */
  config?: { [key: string]: JsonValue };
  /** Names of the secret references the plugin needs (never values). */
  secrets?: string[];
  /** What the plugin's tools do, for the review. Required when `tools` is set; a tool with another effect is refused. */
  effects?: Effect[];
  approval?: Record<string, ApprovalMode>;
  requires?: string[];
  defaultEnabled?: boolean;
  /** Name of a skill in `skills/` that walks a new user through setting the plugin up. */
  onboardingSkill?: string;
  /** Markdown file (relative path) that becomes a section of the session's AGENTS.md. Its first line `# Title` is the heading. */
  promptSection?: string;
}

export interface PluginManifest {
  name: string;
  version: string;
  description: string;
  license?: string;
  author?: JsonValue;
  homepage?: string;
  repository?: JsonValue;
  keywords?: string[];
  ogb: OgbExtension;
}

const NAME = /^[a-z0-9]+(-[a-z0-9]+)*$/;
const VERSION = /^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/;
const OGB_KEYS = new Set(["tools", "sources", "config", "secrets", "effects", "approval", "requires", "defaultEnabled", "onboardingSkill", "promptSection"]);

/** A path inside the plugin directory: relative, no `..`, no drive or root. */
export function isInsidePath(path: string): boolean {
  return path !== "" && !path.startsWith("/") && !/^[A-Za-z]:/.test(path) && !path.split(/[\\/]/).includes("..");
}

/**
 * Checks `plugin.json`. Codex's own fields are accepted and unknown top-level fields are ignored (so a Codex plugin with
 * only skills and MCP servers loads as it is). Inside our own block an unknown key is an error: a typo there would
 * silently switch off a check.
 */
export function parseManifest(input: unknown, label = "plugin.json"): PluginManifest {
  const problems: string[] = [];
  if (!isJsonObject(input)) throw new OgbError("invalid_input", `${label}: must hold a JSON object`);
  if (typeof input.name !== "string" || !NAME.test(input.name)) problems.push("name: required, kebab-case (lower-case letters, digits, '-')");
  if (typeof input.version !== "string" || !VERSION.test(input.version)) problems.push("version: required, like 1.2.3");
  if (typeof input.description !== "string" || input.description === "") problems.push("description: required");
  for (const key of ["license", "homepage"] as const) if (input[key] !== undefined && typeof input[key] !== "string") problems.push(`${key}: must be text`);
  if (input.keywords !== undefined && !(Array.isArray(input.keywords) && input.keywords.every((k) => typeof k === "string")))
    problems.push("keywords: must be a list of text");

  const extensions = input.extensions;
  if (extensions !== undefined && !isJsonObject(extensions)) problems.push("extensions: must be an object");
  const rawOgb = isJsonObject(extensions) ? extensions.vesper : undefined;
  const ogb = rawOgb === undefined ? {} : checkExtension(rawOgb, problems);

  if (problems.length > 0) throw new OgbError("invalid_input", `${label} is invalid:\n- ${problems.join("\n- ")}`);
  const manifest: PluginManifest = { name: input.name as string, version: input.version as string, description: input.description as string, ogb };
  for (const key of ["license", "homepage"] as const) if (typeof input[key] === "string") manifest[key] = input[key];
  if (input.author !== undefined) manifest.author = input.author;
  if (input.repository !== undefined) manifest.repository = input.repository;
  if (input.keywords !== undefined) manifest.keywords = input.keywords as string[];
  return manifest;
}

function checkExtension(raw: unknown, problems: string[]): OgbExtension {
  const path = "extensions.vesper";
  if (!isJsonObject(raw)) {
    problems.push(`${path}: must be an object`);
    return {};
  }
  for (const key of Object.keys(raw)) if (!OGB_KEYS.has(key)) problems.push(`${path}.${key}: unknown key`);
  for (const key of ["tools", "sources", "promptSection"] as const) {
    if (raw[key] !== undefined && (typeof raw[key] !== "string" || !isInsidePath(raw[key])))
      problems.push(`${path}.${key}: must be a path inside the plugin directory`);
  }
  if (raw.config !== undefined && !isJsonObject(raw.config)) problems.push(`${path}.config: must be a JSON schema object`);
  for (const key of ["secrets", "requires"] as const) {
    if (raw[key] !== undefined && !(Array.isArray(raw[key]) && raw[key].every((v) => typeof v === "string" && v !== "")))
      problems.push(`${path}.${key}: must be a list of names`);
  }
  if (raw.effects !== undefined && !(Array.isArray(raw.effects) && raw.effects.every((e) => (EFFECTS as readonly unknown[]).includes(e)))) {
    problems.push(`${path}.effects: each must be one of ${EFFECTS.join(", ")}`);
  }
  if (raw.tools !== undefined && (!Array.isArray(raw.effects) || raw.effects.length === 0))
    problems.push(`${path}.effects: required when the plugin has native tools`);
  if (raw.approval !== undefined) {
    if (!isJsonObject(raw.approval) || !Object.values(raw.approval).every((v) => v === "auto" || v === "ask" || v === "never")) {
      problems.push(`${path}.approval: must map tool names to auto, ask or never`);
    }
  }
  if (raw.defaultEnabled !== undefined && typeof raw.defaultEnabled !== "boolean") problems.push(`${path}.defaultEnabled: must be true or false`);
  if (raw.onboardingSkill !== undefined && typeof raw.onboardingSkill !== "string") problems.push(`${path}.onboardingSkill: must be a skill name`);
  return raw as unknown as OgbExtension;
}
