import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { TEMP_MAIL_VARIABLES, tempMailSettings } from "@standin/connectors";
import { OgbError } from "@standin/contracts";

/** The name of the variable that carries the model key. The key is read from the environment only and never written anywhere. */
export const MODEL_KEY_VARIABLE = "COMMANDCODE_API_KEY";

export interface AppEnvironment {
  /** Address the page and API listen on. The safe default is loopback; the image sets 0.0.0.0 and `OGB_LISTEN_OPEN`. */
  host: string;
  port: number;
  /** The container's published port is bound to the host's loopback by compose, so no login is asked for (owner decision 11). */
  openListen: boolean;
  /** When set, every API call needs this bearer token. */
  token: string | undefined;
  dataDir: string;
  deskSocket: string;
  /** The repository (or image) root: first-party plugins are installed from `<appRoot>/plugins/*`, the page is `<appRoot>/packages/web/src`. */
  appRoot: string;
  webDir: string;
  model: { baseUrl: string; name: string; contextWindow: number };
  /** Names of environment variables that may be used as secrets besides the model key (a comma list in `OGB_SECRET_ENV`). */
  extraSecretVariables: string[];
  /** Optional waiting limits in minutes. Unset (the default) means wait for ever. */
  waits: { humanWaitMinutes?: number; takeoverMaxMinutes?: number };
  limits: { turnsPerRun: number; tokensPerRun?: number; runSeconds: number };
  /**
   * Real mail (docs/25). `tempMail`: the owner's cloudflare_temp_email deployment (`OGB_TEMP_MAIL_URL`, `OGB_TEMP_MAIL_DOMAIN`): every bot
   * gets its own address. `to`: the person's own address (`OGB_MAIL_TO`): the mail channel writes there from `channelName`@domain.
   */
  mail: { tempMail?: { baseUrl: string; domain: string }; to?: string; channelName: string; outlook: boolean; gmail: boolean };
  /** The hook relay (docs/26 3.4, `OGB_HOOK_RELAY_URL`; its key `OGB_HOOK_RELAY_KEY` is a secret): outside services' webhooks are pulled from it. */
  hookRelayUrl?: string;
}

/** Command Code and the DeepSeek flash models take 1,000,000 tokens (the owner's decision, 2026-11-13). `OGB_MODEL_CONTEXT_WINDOW` or a models.json changes it. */
const DEFAULT_CONTEXT_WINDOW = 1_000_000;

const DEFAULTS = {
  host: "127.0.0.1",
  port: 8787,
  dataDir: "/data",
  deskSocket: "/run/ogb/desk-daemon.sock",
  modelBaseUrl: "https://api.commandcode.ai/provider/v1",
  modelName: "deepseek/deepseek-v4.1-flash",
  contextWindow: DEFAULT_CONTEXT_WINDOW,
};

type Env = Readonly<Record<string, string | undefined>>;

function whole(env: Env, name: string, fallback: number, min: number, max: number, problems: string[]): number {
  const raw = env[name];
  if (raw === undefined || raw === "") return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < min || value > max) {
    problems.push(`${name} must be a whole number from ${min} to ${max}`);
    return fallback;
  }
  return value;
}

const MAX_WAIT_MINUTES = 525_600; // a year

/** Unset or empty: no limit. Otherwise a whole number of minutes, 1 to a year; anything else fails the start with the variable's name. */
function optionalMinutes(env: Env, name: string, problems: string[]): number | undefined {
  const raw = env[name];
  if (raw === undefined || raw === "") return undefined;
  const value = Number(raw);
  if (!/^\d+$/.test(raw.trim()) || value < 1 || value > MAX_WAIT_MINUTES) {
    problems.push(`${name} must be a whole number of minutes from 1 to ${MAX_WAIT_MINUTES}, or left unset to wait for ever`);
    return undefined;
  }
  return value;
}

/** Reads only the variables this application needs (never the whole environment) and reports every problem at once, by name, never by value. */
export function parseEnvironment(env: Env, here = dirname(fileURLToPath(import.meta.url))): AppEnvironment {
  const problems: string[] = [];
  const appRoot = resolve(env.OGB_APP_ROOT || join(here, "..", "..", ".."));
  const baseUrl = env.OGB_MODEL_BASE_URL || DEFAULTS.modelBaseUrl;
  try {
    const url = new URL(baseUrl);
    if (url.protocol !== "https:" && url.protocol !== "http:") problems.push("OGB_MODEL_BASE_URL must be an http(s) URL");
  } catch {
    problems.push("OGB_MODEL_BASE_URL must be a URL");
  }
  const openListen = env.OGB_LISTEN_OPEN === "1" || env.OGB_LISTEN_OPEN === "true";
  if (env.OGB_LISTEN_OPEN !== undefined && !["", "0", "1", "true", "false"].includes(env.OGB_LISTEN_OPEN)) problems.push("OGB_LISTEN_OPEN must be 0 or 1");
  const extra = (env.OGB_SECRET_ENV ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  for (const name of extra)
    if (!/^[A-Z][A-Z0-9_]{0,63}$/.test(name)) problems.push("OGB_SECRET_ENV must be a comma list of variable names (capital letters, digits, '_')");
  const waits: AppEnvironment["waits"] = {};
  const humanWait = optionalMinutes(env, "OGB_HUMAN_WAIT_MINUTES", problems);
  if (humanWait !== undefined) waits.humanWaitMinutes = humanWait;
  const takeoverMax = optionalMinutes(env, "OGB_TAKEOVER_MAX_MINUTES", problems);
  if (takeoverMax !== undefined) waits.takeoverMaxMinutes = takeoverMax;
  const tokensPerRun = whole(env, "OGB_RUN_TOKENS", 0, 1, Number.MAX_SAFE_INTEGER, problems);
  let tempMail: { baseUrl: string; domain: string } | undefined;
  try {
    tempMail = tempMailSettings(env);
  } catch (error) {
    problems.push((error as Error).message);
  }
  // The deployment's passwords are secrets like the model key: taken out of the environment, resolved by reference.
  if (tempMail) for (const name of [TEMP_MAIL_VARIABLES.admin, TEMP_MAIL_VARIABLES.sitePassword]) if (!extra.includes(name)) extra.push(name);
  // The person's Gmail (plugin mail-gmail): its app password is a secret like the others.
  const gmail = Boolean(env.OGB_GMAIL_ADDRESS?.trim());
  if (gmail && !extra.includes("OGB_GMAIL_APP_PASSWORD")) extra.push("OGB_GMAIL_APP_PASSWORD");
  const hookRelayUrl = env.OGB_HOOK_RELAY_URL?.trim() || undefined;
  if (hookRelayUrl !== undefined && !/^https:\/\/[^\s/]+/.test(hookRelayUrl)) problems.push("OGB_HOOK_RELAY_URL must be an https address");
  if (hookRelayUrl && !extra.includes("OGB_HOOK_RELAY_KEY")) extra.push("OGB_HOOK_RELAY_KEY");
  const mailTo = env.OGB_MAIL_TO?.trim() || undefined;
  if (mailTo !== undefined && !/^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$/.test(mailTo)) problems.push("OGB_MAIL_TO must be one e-mail address");
  const channelName = env.OGB_MAIL_CHANNEL_NAME?.trim() || "vesper";
  if (!/^[a-z0-9][a-z0-9._-]{0,63}$/.test(channelName)) problems.push("OGB_MAIL_CHANNEL_NAME must be lower-case letters, digits, . _ -");
  const config: AppEnvironment = {
    host: env.OGB_HOST || DEFAULTS.host,
    port: whole(env, "OGB_PORT", DEFAULTS.port, 0, 65_535, problems),
    openListen,
    token: env.OGB_API_TOKEN || undefined,
    dataDir: resolve(env.OGB_DATA_DIR || DEFAULTS.dataDir),
    deskSocket: env.OGB_DESK_SOCKET || DEFAULTS.deskSocket,
    appRoot,
    webDir: resolve(env.OGB_WEB_DIR || join(appRoot, "packages", "web", "src")),
    model: {
      baseUrl,
      name: env.OGB_MODEL || DEFAULTS.modelName,
      contextWindow: whole(env, "OGB_MODEL_CONTEXT_WINDOW", DEFAULTS.contextWindow, 1_000, 10_000_000, problems),
    },
    extraSecretVariables: extra,
    // The person's Outlook (plugin mail-outlook) is offered when the owner's app registration is named (`OGB_OUTLOOK_CLIENT_ID`).
    mail: { ...(tempMail ? { tempMail } : {}), ...(mailTo ? { to: mailTo } : {}), channelName, outlook: Boolean(env.OGB_OUTLOOK_CLIENT_ID?.trim()), gmail },
    waits,
    limits: {
      turnsPerRun: whole(env, "OGB_RUN_TURNS", 40, 1, Number.MAX_SAFE_INTEGER, problems),
      ...(tokensPerRun === 0 ? {} : { tokensPerRun }),
      runSeconds: whole(env, "OGB_RUN_SECONDS", 900, 1, 86_400, problems),
    },
    ...(hookRelayUrl ? { hookRelayUrl } : {}),
  };
  if (problems.length > 0) throw new OgbError("invalid_input", `the environment is not valid:\n- ${problems.join("\n- ")}`);
  return config;
}

/** Whether the model key is present, without returning it. */
export function hasModelKey(env: Env): boolean {
  return typeof env[MODEL_KEY_VARIABLE] === "string" && env[MODEL_KEY_VARIABLE] !== "";
}

/** The values that must never appear in a log line: the model key and every variable offered as a secret. */
export function secretValues(env: Env, config: AppEnvironment): string[] {
  return [MODEL_KEY_VARIABLE, ...config.extraSecretVariables]
    .map((name) => env[name])
    .filter((value): value is string => typeof value === "string" && value.length >= 8);
}

/**
 * Takes the secret variables out of the environment object once: returns their values and deletes them from `env`
 * (`process.env` in the real process). The agent's `bash` tool starts from the process environment, so a key that is still
 * there is a key the model can print. Everything that needs a secret afterwards gets it from the returned object.
 */
export function takeSecrets(env: Record<string, string | undefined>, names: readonly string[]): Record<string, string | undefined> {
  const held: Record<string, string | undefined> = {};
  for (const name of names) {
    held[name] = env[name];
    delete env[name];
  }
  return held;
}
