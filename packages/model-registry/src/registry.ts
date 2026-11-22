import { OgbError, type SecretResolver } from "@standin/contracts";
import { type ChatClientOptions, compatPresets, createChatClient, type LlmClient } from "sakura-agent";
import type { ModelConfig, ModelEntry } from "./config.ts";
import { isSecretReference } from "@standin/secrets";

export interface ModelRegistry {
  names(): string[];
  defaultName(): string;
  /** A ready client. Without a name: the default model. Unknown name: `not_found`. A missing key: `not_found` naming the reference. */
  get(name?: string): Promise<LlmClient>;
  /** The configured most tokens per reply for a model (the agent takes it, not the client); undefined when not set or unknown. */
  maxTokens(name?: string): number | undefined;
}

export interface ModelRegistryOptions {
  config: ModelConfig;
  secrets: SecretResolver;
  /** Builds a client from resolved options. Defaults to the framework's `createChatClient`; tests pass a fake. */
  createClient?: (options: ChatClientOptions) => LlmClient;
  /** Passed to the client so tests can run without a network. */
  fetch?: typeof fetch;
}

/**
 * Keys are looked up when a client is first built, never kept in the config and never put in an error. A client is
 * built once per model and shared; a failed build is not remembered, so fixing the secret and asking again works.
 */
export function createModelRegistry(options: ModelRegistryOptions): ModelRegistry {
  const createClient = options.createClient ?? createChatClient;
  const clients = new Map<string, Promise<LlmClient>>();

  async function build(entry: ModelEntry): Promise<LlmClient> {
    const apiKey = await options.secrets.resolve(entry.apiKey);
    const headers = await resolveHeaders(entry.headers, options.secrets);
    const chat: ChatClientOptions = { baseUrl: entry.baseUrl, apiKey, model: entry.model, contextWindow: entry.contextWindow };
    if (entry.compat !== undefined || entry.images !== undefined) {
      const base = entry.compat === undefined ? {} : typeof entry.compat === "string" ? compatPresets[entry.compat] : entry.compat;
      chat.compat = { ...base, ...(entry.images !== undefined ? { images: entry.images } : {}) };
    }
    if (headers) chat.headers = headers;
    if (entry.idleTimeoutMs !== undefined) chat.idleTimeoutMs = entry.idleTimeoutMs;
    if (entry.headerTimeoutMs !== undefined) chat.headerTimeoutMs = entry.headerTimeoutMs;
    if (options.fetch) chat.fetch = options.fetch;
    return createClient(chat);
  }

  return {
    names: () => Object.keys(options.config.models),
    defaultName: () => options.config.default,
    maxTokens: (name = options.config.default) => options.config.models[name]?.maxTokens,
    get(name = options.config.default) {
      const entry = options.config.models[name];
      if (!entry) return Promise.reject(new OgbError("not_found", `no model named '${name}' (known: ${Object.keys(options.config.models).join(", ")})`));
      let client = clients.get(name);
      if (!client) {
        client = build(entry);
        clients.set(name, client);
        client.catch(() => clients.delete(name));
      }
      return client;
    },
  };
}

async function resolveHeaders(headers: Record<string, string> | undefined, secrets: SecretResolver): Promise<Record<string, string> | undefined> {
  if (!headers) return undefined;
  const resolved: Record<string, string> = {};
  for (const [name, value] of Object.entries(headers)) resolved[name] = isSecretReference(value) ? await secrets.resolve(value) : value;
  return resolved;
}
