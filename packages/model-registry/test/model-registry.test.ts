import { isOgbError } from "@standin/contracts";
import { createFakeSecrets } from "@standin/secrets/testing";
import { describe, expect, it } from "vitest";
import { createModelRegistry, parseModelConfig } from "../src/index.ts";
import { createFakeClientFactory } from "../src/testing/index.ts";

const entry = { baseUrl: "https://api.example.com/v1", model: "m-1", contextWindow: 128000, apiKey: "env:MAIN_KEY" };
const config = () =>
  parseModelConfig({ default: "main", models: { main: entry, cheap: { ...entry, model: "m-2", apiKey: "env:CHEAP_KEY", compat: "deepseek" } } });
const kind = (k: string) => (e: unknown) => isOgbError(e, k as never);

describe("parseModelConfig", () => {
  it("accepts a valid file and picks the first model as default when none is named", () => {
    const parsed = parseModelConfig({ models: { a: entry, b: entry } });
    expect(parsed.default).toBe("a");
    expect(Object.keys(parsed.models)).toEqual(["a", "b"]);
  });

  it("reports every problem at once, by path", () => {
    try {
      parseModelConfig({
        models: { Bad_Name: { ...entry, contextWindow: 0 }, ok: { ...entry, baseUrl: "ftp://x", extra: 1, compat: "nope" } },
        default: "zzz",
        stray: 1,
      });
      expect.unreachable();
    } catch (error) {
      expect(isOgbError(error, "invalid_input")).toBe(true);
      const text = (error as Error).message;
      for (const part of [
        "stray: unknown key",
        "models.Bad_Name: names are",
        "models.Bad_Name.contextWindow",
        "models.ok.baseUrl",
        "models.ok.extra: unknown key",
        "models.ok.compat",
        "default: must name",
      ]) {
        expect(text).toContain(part);
      }
    }
  });

  it("refuses a literal key and never repeats it in the message", () => {
    const literal = `sk-${"q".repeat(32)}`;
    try {
      parseModelConfig({ models: { a: { ...entry, apiKey: literal, headers: { Authorization: `Bearer ${literal}`, "X-Title": "ogb" } } } });
      expect.unreachable();
    } catch (error) {
      const text = (error as Error).message;
      expect(text).toContain("models.a.apiKey: must be a secret reference");
      expect(text).toContain("models.a.headers.Authorization: a credential header must be a secret reference");
      expect(text).not.toContain(literal);
    }
  });

  it.each([
    ["not an object", 5],
    ["array", []],
    ["no models", { models: {} }],
    ["models not an object", { models: 3 }],
    ["entry not an object", { models: { a: 1 } }],
    ["base url with path suffix", { models: { a: { ...entry, baseUrl: "https://x.example/v1/chat/completions" } } }],
    ["bad url", { models: { a: { ...entry, baseUrl: "not a url" } } }],
    ["headers not an object", { models: { a: { ...entry, headers: [] } } }],
    ["header value not a string", { models: { a: { ...entry, headers: { "X-A": 1 } } } }],
    ["negative timeout", { models: { a: { ...entry, idleTimeoutMs: -1 } } }],
    ["bad model id", { models: { a: { ...entry, model: "" } } }],
  ])("rejects %s", (_name, input) => {
    expect(() => parseModelConfig(input)).toThrow();
  });

  it("accepts credential headers that are references, plain headers and overrides", () => {
    const parsed = parseModelConfig({
      models: { a: { ...entry, compat: { images: true }, headers: { Authorization: "env:H", "X-Title": "ogb" }, idleTimeoutMs: 1000, headerTimeoutMs: 2000 } },
    });
    expect(parsed.models.a?.headers).toEqual({ Authorization: "env:H", "X-Title": "ogb" });
  });
});

describe("createModelRegistry", () => {
  it("builds a client with the resolved key, the preset and the timeouts, once per model", async () => {
    const factory = createFakeClientFactory();
    const secrets = createFakeSecrets({ "env:MAIN_KEY": "key-main", "env:CHEAP_KEY": "key-cheap", "env:H": "hv" });
    const registry = createModelRegistry({ config: config(), secrets, createClient: factory.create });
    expect(registry.names()).toEqual(["main", "cheap"]);
    expect(registry.defaultName()).toBe("main");
    const [first, again, cheap] = await Promise.all([registry.get(), registry.get("main"), registry.get("cheap")]);
    expect(first).toBe(again);
    expect(cheap.model.id).toBe("m-2");
    expect(factory.built).toHaveLength(2);
    expect(factory.built[0]).toMatchObject({ apiKey: "key-main", baseUrl: entry.baseUrl, contextWindow: 128000 });
    expect(factory.built[1]?.compat).toMatchObject({ vendor: expect.any(String), thinkingFormat: "deepseek" });
  });

  it("resolves header references and passes plain headers and timeouts through", async () => {
    const factory = createFakeClientFactory();
    const cfg = parseModelConfig({
      models: { a: { ...entry, headers: { Authorization: "env:H", "X-Title": "ogb" }, idleTimeoutMs: 1000, headerTimeoutMs: 2000 } },
    });
    const fetchStub = (() => {}) as unknown as typeof fetch;
    const registry = createModelRegistry({
      config: cfg,
      secrets: createFakeSecrets({ "env:MAIN_KEY": "k", "env:H": "Bearer hv" }),
      createClient: factory.create,
      fetch: fetchStub,
    });
    await registry.get("a");
    expect(factory.built[0]).toMatchObject({
      headers: { Authorization: "Bearer hv", "X-Title": "ogb" },
      idleTimeoutMs: 1000,
      headerTimeoutMs: 2000,
      fetch: fetchStub,
    });
  });

  it("says which names exist for an unknown model, and which reference is missing without printing any value", async () => {
    const registry = createModelRegistry({ config: config(), secrets: createFakeSecrets({}), createClient: createFakeClientFactory().create });
    await expect(registry.get("zzz")).rejects.toSatisfy(kind("not_found"));
    await expect(registry.get("zzz")).rejects.toThrow("main, cheap");
    await expect(registry.get("main")).rejects.toThrow("env:MAIN_KEY");
  });

  it("does not remember a failed build: once the secret exists, the same call works", async () => {
    const values: Record<string, string> = {};
    const registry = createModelRegistry({
      config: config(),
      secrets: { resolve: async (r) => values[r] ?? Promise.reject(Object.assign(new Error("missing"), {})) },
      createClient: createFakeClientFactory().create,
    });
    await expect(registry.get("main")).rejects.toThrow();
    values["env:MAIN_KEY"] = "now-present";
    expect((await registry.get("main")).model.id).toBe("m-1");
  });

  it("works with the framework's real client: the request carries the resolved key", async () => {
    const seen: { url: string; auth: string | null }[] = [];
    const fakeFetch = (async (url: string | URL | Request, init?: RequestInit) => {
      seen.push({ url: String(url), auth: new Headers(init?.headers).get("authorization") });
      return new Response("data: [DONE]\n\n", { status: 200, headers: { "content-type": "text/event-stream" } });
    }) as typeof fetch;
    const registry = createModelRegistry({ config: config(), secrets: createFakeSecrets({ "env:MAIN_KEY": "real-path-key" }), fetch: fakeFetch });
    const client = await registry.get("main");
    expect(client.model).toMatchObject({ id: "m-1", contextWindow: 128000 });
    try {
      for await (const _event of client.stream({ system: "s", messages: [], tools: [] }, new AbortController().signal)) {
        // events are not the point here
      }
    } catch {
      // an empty reply may be reported as an error; the request itself is what this test looks at
    }
    expect(seen[0]?.url).toBe("https://api.example.com/v1/chat/completions");
    expect(seen[0]?.auth).toBe("Bearer real-path-key");
  });
});

describe("images and maxTokens", () => {
  it("merges images over the preset, and keeps maxTokens for the agent (the client does not carry it)", async () => {
    const factory = createFakeClientFactory();
    const secrets = createFakeSecrets({ "env:MAIN_KEY": "k" });
    const cfg = parseModelConfig({ models: { a: { ...entry, compat: "deepseek", images: false, maxTokens: 4096 }, b: entry } });
    const registry = createModelRegistry({ config: cfg, secrets, createClient: factory.create });
    await registry.get("a");
    expect(factory.built[0]?.compat).toMatchObject({ thinkingFormat: "deepseek", images: false });
    expect(registry.maxTokens("a")).toBe(4096);
    expect(registry.maxTokens("b")).toBeUndefined();
    expect(registry.maxTokens("nope")).toBeUndefined();
  });

  it("refuses a bad value by path", () => {
    expect(() => parseModelConfig({ models: { a: { ...entry, images: "no", maxTokens: 0 } } })).toThrow(/models\.a\.images[\s\S]*models\.a\.maxTokens/);
  });
});
