import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { OgbError } from "@standin/contracts";
import { type ModelConfig, parseModelConfig } from "@standin/model-registry";
import { type ProfileConfig, parseProfileConfig } from "@standin/profiles";
import type { SessionRuntimeDeps } from "@standin/session-runtime";
import { type AppEnvironment, MODEL_KEY_VARIABLE } from "./environment.ts";

/** The name the default model has in the registry and in the default profiles. */
export const DEFAULT_MODEL_NAME = "main";
/** Most tokens the default model may write in one reply. One constant, to be settled by the lead's check of the real model (D8). */
export const DEFAULT_MAX_TOKENS = 8192;
/** Declared to the model in every session of the built-in profiles: it must be able to ask, to speak and to use the browser without searching first (D5). */
export const ALWAYS_DECLARED_TOOLS = ["ask_human", "send_to_user", "browser", "computer", "schedule", "remember_person"] as const;
/** First-party plugins, in the order the profiles list them. Installed from `<appRoot>/plugins/<name>`. */
export const FIRST_PARTY_PLUGINS = ["handoff", "browser", "computer", "mail-sim", "mail-temp", "mail-outlook", "mail-gmail"] as const;

function readJson(path: string): unknown | undefined {
  if (!existsSync(path)) return undefined;
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch (cause) {
    throw new OgbError("invalid_input", `${path} is not valid JSON`, { cause });
  }
}

/**
 * `<dataDir>/config/models.json` if it exists, otherwise one model from the environment: the Command Code provider, key by
 * reference (`env:COMMANDCODE_API_KEY`), never the key itself.
 */
export function loadModelConfig(env: AppEnvironment): ModelConfig {
  const file = join(env.dataDir, "config", "models.json");
  const given = readJson(file);
  return parseModelConfig(
    given ?? {
      default: DEFAULT_MODEL_NAME,
      models: {
        [DEFAULT_MODEL_NAME]: {
          baseUrl: env.model.baseUrl,
          model: env.model.name,
          contextWindow: env.model.contextWindow,
          apiKey: `env:${MODEL_KEY_VARIABLE}`,
          // The default model is DeepSeek behind Command Code: its wire format. It reads images (checked 2026-11-15; the
          // earlier empty reply was a reply budget spent on reasoning), so desktop and browser screenshots reach it.
          compat: "deepseek",
          images: true,
          maxTokens: DEFAULT_MAX_TOKENS,
        },
      },
    },
  );
}

/**
 * `<dataDir>/config/profiles.json` if it exists, otherwise two profiles. The safety floor (review and redaction) is on in
 * both, and only this file can ever lower it: nothing the page sends is read for it (the profiles module).
 */
export function loadProfileConfig(env: AppEnvironment): ProfileConfig {
  const file = join(env.dataDir, "config", "profiles.json");
  return parseProfileConfig(
    readJson(file) ?? {
      default: "general",
      safetyFloor: { review: true, redaction: true },
      profiles: {
        general: {
          description: "Everyday work: files, the browser, the desktop, sharing results with other agents; its own mail address when a deployment is set.",
          // A bot's own address only when a mail deployment is configured: without it the plugin is not there at all (docs/25).
          plugins: [
            "handoff",
            "browser",
            "computer",
            ...(env.mail.tempMail ? ["mail-temp"] : []),
            ...(env.mail.outlook ? ["mail-outlook"] : []),
            ...(env.mail.gmail ? ["mail-gmail"] : []),
          ],
          model: DEFAULT_MODEL_NAME,
          alwaysDeclaredTools: [...ALWAYS_DECLARED_TOOLS],
        },
        "general-mail": {
          description: "The same, with the simulated mailbox and calendar (mail arrives as files; see plugins/mail-sim).",
          plugins: ["handoff", "browser", "computer", "mail-sim"],
          model: DEFAULT_MODEL_NAME,
          alwaysDeclaredTools: [...ALWAYS_DECLARED_TOOLS],
        },
      },
    },
  );
}

/** Every model a profile names must exist, and every plugin must be installable: a mistake is found at start, not when a session is created. */
export function checkReferences(models: ModelConfig, profiles: ProfileConfig, installed: readonly string[]): string[] {
  const problems: string[] = [];
  for (const [name, profile] of Object.entries(profiles.profiles)) {
    if (profile.model !== undefined && !(profile.model in models.models))
      problems.push(`profile '${name}' names the model '${profile.model}', which is not in the model config`);
    for (const plugin of [...profile.plugins, ...(profile.optionalPlugins ?? [])]) {
      if (!installed.includes(plugin)) problems.push(`profile '${name}' needs the plugin '${plugin}', which is not installed`);
    }
  }
  return problems;
}

/** Drops the profiles that need a plugin which is not installed; the default moves to the first profile left (or none). */
export function withoutUnusableProfiles(profiles: ProfileConfig, installed: readonly string[]): ProfileConfig {
  const usable = Object.fromEntries(Object.entries(profiles.profiles).filter(([, profile]) => profile.plugins.every((p) => installed.includes(p))));
  return { ...profiles, profiles: usable, default: usable[profiles.default] ? profiles.default : (Object.keys(usable)[0] ?? "") };
}

/**
 * `<dataDir>/config/mcp.json`: MCP servers every bot gets, `{ "servers": { "<name>": { "command": "...", "args": [...], "env": {...} } },
 * "expose": "direct" | "codemode" }`. No file, no servers. A server's tools are reviewed like every other tool.
 */
export function loadMcpConfig(env: AppEnvironment): SessionRuntimeDeps["mcp"] | undefined {
  const file = join(env.dataDir, "config", "mcp.json");
  const raw = readJson(file) as { servers?: unknown; expose?: unknown } | undefined;
  if (raw === undefined) return undefined;
  const servers: Record<string, { command: string; args?: string[]; env?: Record<string, string> }> = {};
  if (raw.servers === null || typeof raw.servers !== "object" || Array.isArray(raw.servers))
    throw new OgbError("invalid_input", `${file}: 'servers' must be an object`);
  for (const [name, value] of Object.entries(raw.servers as Record<string, unknown>)) {
    const server = value as { command?: unknown; args?: unknown; env?: unknown };
    if (!/^[a-z][a-z0-9_-]{0,31}$/.test(name))
      throw new OgbError("invalid_input", `${file}: server name '${name}' must be short lower-case letters, digits, - or _`);
    if (typeof server?.command !== "string" || server.command === "") throw new OgbError("invalid_input", `${file}: server '${name}' needs a 'command'`);
    if (server.args !== undefined && !(Array.isArray(server.args) && server.args.every((arg) => typeof arg === "string")))
      throw new OgbError("invalid_input", `${file}: server '${name}': 'args' must be a list of strings`);
    if (server.env !== undefined && (server.env === null || typeof server.env !== "object" || Object.values(server.env).some((v) => typeof v !== "string")))
      throw new OgbError("invalid_input", `${file}: server '${name}': 'env' must map names to strings`);
    servers[name] = {
      command: server.command,
      ...(server.args ? { args: server.args as string[] } : {}),
      ...(server.env ? { env: server.env as Record<string, string> } : {}),
    };
  }
  if (raw.expose !== undefined && raw.expose !== "direct" && raw.expose !== "codemode")
    throw new OgbError("invalid_input", `${file}: 'expose' must be "direct" or "codemode" ("search" would clash with the box's own tool search)`);
  return { servers, ...(raw.expose ? { expose: raw.expose as "direct" | "codemode" } : {}) };
}

/** One chat bridge of `<dataDir>/config/chat.json` (docs/26 4.3). The bridge server runs apart; this only says how to reach it. */
export interface ChatBridgeConfig {
  name: string;
  kind: "matrix" | "satori";
  url: string;
  /** A secret reference (`env:NAME`, the name listed in OGB_SECRET_ENV), never the token itself. */
  token?: string;
  /** The person's own ids on the bridge. */
  person: string[];
  /** The room where bots write to the person. */
  personRoom: string;
  /** Rooms whose other people a bot watches: room → bot id. */
  watch?: Record<string, string>;
  /** Satori only: the account to act as, when the server has several. */
  platform?: string;
  selfId?: string;
}

/** `<dataDir>/config/chat.json`: `{ "bridges": [...] }`. No file, no bridges. Every mistake is reported at start, by field. */
export function loadChatConfig(env: AppEnvironment): ChatBridgeConfig[] {
  const file = join(env.dataDir, "config", "chat.json");
  const raw = readJson(file) as { bridges?: unknown } | undefined;
  if (raw === undefined) return [];
  if (!Array.isArray(raw.bridges)) throw new OgbError("invalid_input", `${file}: 'bridges' must be a list`);
  const names = new Set<string>();
  return raw.bridges.map((value, index) => {
    const b = value as Record<string, unknown>;
    const where = `${file}: bridge ${index + 1}`;
    const text = (key: string, required = true) => {
      const v = b[key];
      if (v === undefined && !required) return undefined;
      if (typeof v !== "string" || v.trim() === "") throw new OgbError("invalid_input", `${where}: '${key}' must be text`);
      return v.trim();
    };
    const name = text("name") as string;
    if (!/^[a-z][a-z0-9-]{0,31}$/.test(name) || names.has(name)) throw new OgbError("invalid_input", `${where}: 'name' must be short lower-case and unique`);
    names.add(name);
    const kind = text("kind");
    if (kind !== "matrix" && kind !== "satori") throw new OgbError("invalid_input", `${where}: 'kind' must be matrix or satori`);
    const url = text("url") as string;
    if (!/^https?:\/\/[^\s/]+/.test(url)) throw new OgbError("invalid_input", `${where}: 'url' must be an http(s) address`);
    const token = text("token", false);
    if (token !== undefined && !/^[a-z][a-z0-9-]*:.+$/.test(token))
      throw new OgbError("invalid_input", `${where}: 'token' must be a secret reference such as env:OGB_MATRIX_TOKEN`);
    if (!Array.isArray(b.person) || b.person.length === 0 || !b.person.every((p) => typeof p === "string" && p !== ""))
      throw new OgbError("invalid_input", `${where}: 'person' must list the person's ids`);
    const watch = b.watch;
    if (watch !== undefined && (watch === null || typeof watch !== "object" || !Object.values(watch).every((v) => typeof v === "string")))
      throw new OgbError("invalid_input", `${where}: 'watch' must map rooms to bot ids`);
    const platform = text("platform", false);
    const selfId = text("selfId", false);
    return {
      name,
      kind,
      url,
      ...(token ? { token } : {}),
      person: b.person as string[],
      personRoom: text("personRoom") as string,
      ...(watch ? { watch: watch as Record<string, string> } : {}),
      ...(platform ? { platform } : {}),
      ...(selfId ? { selfId } : {}),
    };
  });
}

/**
 * `<dataDir>/config/review-policy.json`: the review's four lists (environment, allow, soft_deny, hard_deny), replacing Vesper's own
 * (`VESPER_REVIEW_POLICY`); a list with "$defaults" keeps the framework's built-in entries. No file: Vesper's policy.
 */
export function loadReviewPolicy(env: AppEnvironment): Record<string, string[]> | undefined {
  const file = join(env.dataDir, "config", "review-policy.json");
  const raw = readJson(file) as Record<string, unknown> | undefined;
  if (raw === undefined) return undefined;
  const keys = ["environment", "allow", "soft_deny", "hard_deny"];
  for (const [key, value] of Object.entries(raw)) {
    if (!keys.includes(key)) throw new OgbError("invalid_input", `${file}: '${key}' is not one of ${keys.join(", ")}`);
    if (!Array.isArray(value) || !value.every((v) => typeof v === "string" && v.trim() !== ""))
      throw new OgbError("invalid_input", `${file}: '${key}' must be a list of sentences`);
  }
  return raw as Record<string, string[]>;
}
