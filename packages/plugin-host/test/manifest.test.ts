import { isOgbError } from "@standin/contracts";
import { describe, expect, it } from "vitest";
import { parseManifest } from "../src/index.ts";

const base = { name: "my-plugin", version: "1.2.3", description: "does things" };

describe("parseManifest", () => {
  it("accepts a Codex-style plugin with only the portable fields, and ignores fields it does not know", () => {
    const manifest = parseManifest({
      ...base,
      license: "MIT",
      author: { name: "A" },
      homepage: "https://x.example",
      repository: "r",
      keywords: ["a"],
      apps: { x: 1 },
      hooks: "hooks/hooks.json",
    });
    expect(manifest).toMatchObject({ name: "my-plugin", version: "1.2.3", license: "MIT", keywords: ["a"], ogb: {} });
  });

  it("reads our extension block", () => {
    const manifest = parseManifest({
      ...base,
      extensions: {
        "com.openai": { auth: "none" },
        vesper: {
          tools: "tools/index.js",
          sources: "sources/index.js",
          effects: ["read", "network"],
          approval: { send: "ask" },
          requires: ["other"],
          secrets: ["MAIL_PASSWORD"],
          config: { type: "object" },
          defaultEnabled: false,
          onboardingSkill: "setup",
        },
      },
    });
    expect(manifest.ogb).toMatchObject({ tools: "tools/index.js", effects: ["read", "network"], approval: { send: "ask" }, defaultEnabled: false });
  });

  it("reports every problem at once", () => {
    try {
      parseManifest({
        name: "Bad Name",
        version: "1",
        extensions: {
          vesper: {
            tools: "../x.js",
            sources: "/abs.js",
            typo: 1,
            effects: ["fly"],
            approval: { a: "maybe" },
            secrets: [1],
            requires: "x",
            defaultEnabled: "yes",
            config: 3,
            onboardingSkill: 1,
          },
        },
      });
      expect.unreachable();
    } catch (error) {
      expect(isOgbError(error, "invalid_input")).toBe(true);
      const text = (error as Error).message;
      for (const part of [
        "name:",
        "version:",
        "description:",
        "tools: must be a path inside",
        "sources: must be a path inside",
        "typo: unknown key",
        "effects: each must be",
        "approval:",
        "secrets:",
        "requires:",
        "defaultEnabled",
        "config:",
        "onboardingSkill",
      ]) {
        expect(text).toContain(part);
      }
    }
  });

  it("requires declared effects when there are native tools", () => {
    expect(() => parseManifest({ ...base, extensions: { vesper: { tools: "tools/index.js" } } })).toThrow(/effects: required when the plugin has native tools/);
    expect(() => parseManifest({ ...base, extensions: { vesper: { tools: "tools/index.js", effects: [] } } })).toThrow(/effects: required/);
  });

  it.each([
    ["not an object", []],
    ["extensions not an object", { ...base, extensions: 3 }],
    ["vesper not an object", { ...base, extensions: { vesper: 3 } }],
    ["license not text", { ...base, license: 1 }],
    ["keywords not text", { ...base, keywords: [1] }],
  ])("rejects %s", (_name, input) => {
    expect(() => parseManifest(input)).toThrow();
  });
});
