import { OgbError } from "@standin/contracts";
import { isSecretReference } from "@standin/secrets";

const COMPAT_PRESETS = ["deepseek", "moonshot", "openai"] as const;
export type CompatPresetName = (typeof COMPAT_PRESETS)[number];

export interface ModelEntry {
  baseUrl: string;
  model: string;
  contextWindow: number;
  /** A secret reference such as `env:DEEPSEEK_API_KEY`. A literal key is refused. */
  apiKey: string;
  compat?: CompatPresetName | Record<string, unknown>;
  /** Values that are secret references are resolved at use; the headers that carry credentials must be references. */
  headers?: Record<string, string>;
  idleTimeoutMs?: number;
  headerTimeoutMs?: number;
  /** Whether the model can read images; false makes the client leave image parts out. Merged over `compat`. */
  images?: boolean;
  /** Most tokens the model may write in one reply; passed to the agent (the client does not carry it). */
  maxTokens?: number;
}

export interface ModelConfig {
  default: string;
  models: Record<string, ModelEntry>;
}

const NAME = /^[a-z0-9][a-z0-9._-]*$/;
const CREDENTIAL_HEADERS = new Set(["authorization", "x-api-key", "api-key", "proxy-authorization"]);
const ENTRY_KEYS = new Set(["baseUrl", "model", "contextWindow", "apiKey", "compat", "headers", "idleTimeoutMs", "headerTimeoutMs", "images", "maxTokens"]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Checks the whole file and reports every problem at once, by path. Messages never contain a value from the file:
 * the most likely mistake is a key pasted where a reference belongs, and that key must not end up in a log.
 */
export function parseModelConfig(input: unknown): ModelConfig {
  const problems: string[] = [];
  if (!isRecord(input)) throw new OgbError("invalid_input", "model config: the file must hold a JSON object");
  for (const key of Object.keys(input)) {
    if (key !== "models" && key !== "default") problems.push(`${key}: unknown key`);
  }
  const models: Record<string, ModelEntry> = {};
  if (!isRecord(input.models) || Object.keys(input.models).length === 0) {
    problems.push("models: must be an object with at least one model");
  } else {
    for (const [name, raw] of Object.entries(input.models)) {
      if (!NAME.test(name)) problems.push(`models.${name}: names are lower-case letters, digits, '.', '_' and '-'`);
      const entry = checkEntry(`models.${name}`, raw, problems);
      if (entry) models[name] = entry;
    }
  }
  const names = Object.keys(models);
  let defaultName = names[0] ?? "";
  if (input.default !== undefined) {
    if (typeof input.default !== "string" || !(input.default in models)) problems.push("default: must name one of the models");
    else defaultName = input.default;
  }
  if (problems.length > 0) throw new OgbError("invalid_input", `model config is invalid:\n- ${problems.join("\n- ")}`);
  return { default: defaultName, models };
}

function checkEntry(path: string, raw: unknown, problems: string[]): ModelEntry | undefined {
  if (!isRecord(raw)) {
    problems.push(`${path}: must be an object`);
    return undefined;
  }
  const before = problems.length;
  for (const key of Object.keys(raw)) if (!ENTRY_KEYS.has(key)) problems.push(`${path}.${key}: unknown key`);
  if (typeof raw.baseUrl !== "string" || !isHttpUrl(raw.baseUrl)) problems.push(`${path}.baseUrl: must be an http(s) URL`);
  else if (raw.baseUrl.endsWith("/chat/completions")) problems.push(`${path}.baseUrl: give the base URL without /chat/completions`);
  if (typeof raw.model !== "string" || raw.model === "") problems.push(`${path}.model: must be a model id`);
  if (!Number.isInteger(raw.contextWindow) || (raw.contextWindow as number) < 1) problems.push(`${path}.contextWindow: must be a positive integer`);
  if (typeof raw.apiKey !== "string" || !isSecretReference(raw.apiKey)) {
    problems.push(`${path}.apiKey: must be a secret reference such as env:NAME, not the key itself`);
  }
  if (raw.compat !== undefined && !(typeof raw.compat === "string" ? (COMPAT_PRESETS as readonly string[]).includes(raw.compat) : isRecord(raw.compat))) {
    problems.push(`${path}.compat: must be one of ${COMPAT_PRESETS.join(", ")} or an object of overrides`);
  }
  if (raw.headers !== undefined) checkHeaders(`${path}.headers`, raw.headers, problems);
  for (const key of ["idleTimeoutMs", "headerTimeoutMs"] as const) {
    if (raw[key] !== undefined && (!Number.isInteger(raw[key]) || (raw[key] as number) < 1)) problems.push(`${path}.${key}: must be a positive integer`);
  }
  if (raw.images !== undefined && typeof raw.images !== "boolean") problems.push(`${path}.images: must be true or false`);
  if (raw.maxTokens !== undefined && (!Number.isInteger(raw.maxTokens) || (raw.maxTokens as number) < 1))
    problems.push(`${path}.maxTokens: must be a positive integer`);
  return problems.length === before ? (raw as unknown as ModelEntry) : undefined;
}

function checkHeaders(path: string, headers: unknown, problems: string[]): void {
  if (!isRecord(headers)) {
    problems.push(`${path}: must be an object of strings`);
    return;
  }
  for (const [name, value] of Object.entries(headers)) {
    if (typeof value !== "string") problems.push(`${path}.${name}: must be a string`);
    else if (CREDENTIAL_HEADERS.has(name.toLowerCase()) && !isSecretReference(value))
      problems.push(`${path}.${name}: a credential header must be a secret reference`);
  }
}

function isHttpUrl(text: string): boolean {
  try {
    const url = new URL(text);
    return url.protocol === "https:" || url.protocol === "http:";
  } catch {
    return false;
  }
}
