import { isOgbError } from "@vesper/contracts";
import { describe, expect, it } from "vitest";
import { hasModelKey, MODEL_KEY_VARIABLE, parseEnvironment, secretValues, takeSecrets } from "../src/environment.ts";

describe("parseEnvironment", () => {
  it("has safe defaults: loopback, no open listen, the Command Code model by name", () => {
    const env = parseEnvironment({}, "/opt/ogb/packages/app/src");
    expect(env).toMatchObject({
      host: "127.0.0.1",
      port: 8787,
      openListen: false,
      token: undefined,
      dataDir: "/data",
      deskSocket: "/run/ogb/desk-daemon.sock",
      appRoot: "/opt/ogb",
      webDir: "/opt/ogb/packages/web/src",
      model: { baseUrl: "https://api.commandcode.ai/provider/v1", name: "deepseek/deepseek-v4.1-flash", contextWindow: 1_000_000 },
      extraSecretVariables: [],
    });
  });

  it("reads the container's settings", () => {
    const env = parseEnvironment({
      OGB_HOST: "0.0.0.0",
      OGB_PORT: "9000",
      OGB_LISTEN_OPEN: "1",
      OGB_API_TOKEN: "t",
      OGB_DATA_DIR: "/x",
      OGB_MODEL: "m",
      OGB_MODEL_CONTEXT_WINDOW: "64000",
      OGB_SECRET_ENV: "A_KEY, B_KEY",
    });
    expect(env).toMatchObject({
      host: "0.0.0.0",
      port: 9000,
      openListen: true,
      token: "t",
      dataDir: "/x",
      model: { name: "m", contextWindow: 64000 },
      extraSecretVariables: ["A_KEY", "B_KEY"],
    });
  });

  it("keeps the hook relay's address, so the puller starts and hooks get the public address (testers' B-10)", () => {
    expect(parseEnvironment({ OGB_HOOK_RELAY_URL: "https://relay.example.workers.dev" }).hookRelayUrl).toBe("https://relay.example.workers.dev");
    expect(parseEnvironment({})).not.toHaveProperty("hookRelayUrl");
  });

  it("reports every problem at once by variable name, never by value", () => {
    try {
      parseEnvironment({ OGB_PORT: "http", OGB_LISTEN_OPEN: "maybe", OGB_MODEL_BASE_URL: "ftp://x", OGB_MODEL_CONTEXT_WINDOW: "5", OGB_SECRET_ENV: "lower" });
      expect.unreachable();
    } catch (error) {
      expect(isOgbError(error, "invalid_input")).toBe(true);
      const message = (error as Error).message;
      for (const part of ["OGB_PORT", "OGB_LISTEN_OPEN", "OGB_MODEL_BASE_URL", "OGB_MODEL_CONTEXT_WINDOW", "OGB_SECRET_ENV"]) expect(message).toContain(part);
      expect(message).not.toContain("maybe");
    }
    expect(() => parseEnvironment({ OGB_MODEL_BASE_URL: "not a url" })).toThrow(/OGB_MODEL_BASE_URL must be a URL/);
  });

  it("knows whether the key is present and lists the values a log must never hold", () => {
    expect(hasModelKey({})).toBe(false);
    expect(hasModelKey({ [MODEL_KEY_VARIABLE]: "" })).toBe(false);
    expect(hasModelKey({ [MODEL_KEY_VARIABLE]: "abc" })).toBe(true);
    const config = parseEnvironment({ OGB_SECRET_ENV: "OTHER_KEY" });
    expect(secretValues({ [MODEL_KEY_VARIABLE]: "model-key-12345", OTHER_KEY: "other-key-67890", UNRELATED: "unrelated-value" }, config)).toEqual([
      "model-key-12345",
      "other-key-67890",
    ]);
    expect(secretValues({ [MODEL_KEY_VARIABLE]: "short" }, config)).toEqual([]);
  });
});

describe("the optional waiting limits", () => {
  it("are unset by default (wait for ever), and read as whole minutes", () => {
    expect(parseEnvironment({}).waits).toEqual({});
    expect(parseEnvironment({ OGB_HUMAN_WAIT_MINUTES: "30", OGB_TAKEOVER_MAX_MINUTES: "120" }).waits).toEqual({
      humanWaitMinutes: 30,
      takeoverMaxMinutes: 120,
    });
    expect(parseEnvironment({ OGB_HUMAN_WAIT_MINUTES: "" }).waits).toEqual({});
  });

  it("fail the start with the variable's name when the value is not a number of minutes", () => {
    for (const bad of ["0", "-5", "1.5", "soon", "999999999"])
      expect(() => parseEnvironment({ OGB_HUMAN_WAIT_MINUTES: bad })).toThrow(/OGB_HUMAN_WAIT_MINUTES must be a whole number of minutes/);
    expect(() => parseEnvironment({ OGB_TAKEOVER_MAX_MINUTES: "x" })).toThrow(/OGB_TAKEOVER_MAX_MINUTES/);
  });
});

describe("run budgets", () => {
  it("reads the trial budget independently of the model context window", () => {
    const env = parseEnvironment({ OGB_RUN_TURNS: "1000", OGB_RUN_TOKENS: "10000000", OGB_RUN_SECONDS: "10800" });
    expect(env.limits).toEqual({ turnsPerRun: 1000, tokensPerRun: 10_000_000, runSeconds: 10_800 });
  });
});

describe("takeSecrets", () => {
  it("returns the listed variables and removes exactly those from the object, so a child process cannot inherit them", () => {
    const env: Record<string, string | undefined> = { A: "1", B: "2", C: "3" };
    expect(takeSecrets(env, ["A", "C", "MISSING"])).toEqual({ A: "1", C: "3", MISSING: undefined });
    expect(env).toEqual({ B: "2" });
    expect(Object.keys(env)).not.toContain("A");
  });
});
