import { isOgbError } from "@standin/contracts";
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { parseProfileConfig, parseSessionRequest, resolveSession, SAFETY_FLOOR } from "../src/index.ts";
import { sampleProfileConfig } from "../src/testing/index.ts";

const kind = (k: string) => (e: unknown) => isOgbError(e, k as never);

describe("parseProfileConfig", () => {
  it("defaults the safety floor to on and the default profile to the first", () => {
    const config = parseProfileConfig({ profiles: { a: { plugins: [] }, b: { plugins: ["x"] } } });
    expect(config).toMatchObject({ default: "a", safetyFloor: { review: true, redaction: true } });
  });

  it("lets the file switch a safety plugin off, and says so in the warnings of every session", () => {
    const config = parseProfileConfig({ safetyFloor: { review: false }, profiles: { a: { plugins: [] } } });
    const resolved = resolveSession(config, {});
    expect(resolved.floor).toEqual(["redaction"]);
    expect(resolved.warnings).toEqual(["the config file has switched off the review plugin"]);
  });

  it("reports all problems by path", () => {
    try {
      parseProfileConfig({
        x: 1,
        default: "nope",
        safetyFloor: { review: "no", other: true },
        profiles: { Bad: { plugins: "x", model: 3, extra: 1 }, ok: { plugins: ["A b"] } },
      });
      expect.unreachable();
    } catch (error) {
      const message = (error as Error).message;
      for (const part of [
        "x: unknown key",
        "safetyFloor.review: must be true or false",
        "safetyFloor.other: unknown safety plugin",
        "profiles.Bad: profile names",
        "profiles.Bad.plugins",
        "profiles.Bad.model",
        "profiles.Bad.extra: unknown key",
        "profiles.ok.plugins",
        "default: must name",
      ]) {
        expect(message).toContain(part);
      }
    }
  });

  it.each([
    ["not an object", 1],
    ["no profiles", { profiles: {} }],
    ["safetyFloor not an object", { safetyFloor: 1, profiles: { a: { plugins: [] } } }],
    ["profile not an object", { profiles: { a: 1 } }],
    ["settings not an object", { profiles: { a: { plugins: [], settings: 1 } } }],
    ["description not text", { profiles: { a: { plugins: [], description: 1 } } }],
    ["optionalPlugins bad", { profiles: { a: { plugins: [], optionalPlugins: [1] } } }],
  ])("rejects %s", (_name, input) => {
    expect(() => parseProfileConfig(input)).toThrow();
  });
});

describe("resolveSession", () => {
  const config = sampleProfileConfig();

  it("builds the default profile with the floor first and everything frozen", () => {
    const resolved = resolveSession(config, undefined);
    expect(resolved).toMatchObject({
      profile: "general",
      title: "general",
      model: "main",
      floor: ["review", "redaction"],
      plugins: ["handoff", "browser"],
      warnings: [],
    });
    expect(Object.isFrozen(resolved)).toBe(true);
    expect(Object.isFrozen(resolved.plugins)).toBe(true);
    expect(() => (resolved.plugins as string[]).push("x")).toThrow();
    expect(() => (resolved.floor as string[]).pop()).toThrow();
  });

  it("takes a title, a model and extra plugins from the offered list, without repeats", () => {
    const resolved = resolveSession(config, { title: "Taxes", model: "cheap", extraPlugins: ["computer", "mail-sim", "computer"] });
    expect(resolved).toMatchObject({ title: "Taxes", model: "cheap" });
    expect(resolved.plugins).toEqual(["handoff", "browser", "computer", "mail-sim"]);
  });

  it("refuses an extra plugin the profile does not offer, and an unknown profile", () => {
    expect(() => resolveSession(config, { extraPlugins: ["mail-gmail-readonly"] })).toThrow();
    expect(() => resolveSession(config, { extraPlugins: ["mail-gmail-readonly"] })).toThrowError(/not offered/);
    expect(() => resolveSession(config, { profile: "zzz" })).toThrow(/general, minimal/);
    expect(() => resolveSession(config, { profile: "minimal", extraPlugins: ["computer"] })).toThrow(/not offered/);
  });

  it("never lets a settings object from the config be changed through the result", () => {
    const resolved = resolveSession(config, {});
    expect(() => {
      (resolved.settings as Record<string, unknown>).quietByDefault = false;
    }).toThrow();
    expect(resolveSession(config, {}).settings).toEqual({ quietByDefault: true });
  });
});

describe("the safety floor cannot be switched off from the page", () => {
  const config = sampleProfileConfig();

  it.each([
    [{ review: false }],
    [{ redaction: false }],
    [{ safetyFloor: { review: false, redaction: false } }],
    [{ disablePlugins: ["review"] }],
    [{ disable: ["redaction"] }],
    [{ noReview: true }],
    [{ bypass: true }],
    [{ unsafe: true }],
  ])("refuses %j as denied", (request) => {
    expect(() => resolveSession(config, request)).toThrowError(/safety floor|cannot be set/);
    try {
      resolveSession(config, request);
    } catch (error) {
      expect(kind("denied")(error)).toBe(true);
    }
  });

  it("refuses unknown fields as invalid input and bad types", () => {
    expect(() => parseSessionRequest({ colour: "red" })).toThrow(/unknown field/);
    expect(() => parseSessionRequest({ settings: { review: false } })).toThrow(/unknown field/); // not a field the page has; nothing is read from it
    expect(() => parseSessionRequest("text")).toThrow();
    expect(() => parseSessionRequest({ title: 3 })).toThrow();
    expect(() => parseSessionRequest({ extraPlugins: "a" })).toThrow();
    expect(parseSessionRequest(null)).toEqual({});
  });

  it("naming a safety plugin as an extra is refused, and naming it in the profile does not duplicate or remove it", () => {
    expect(() => resolveSession(config, { extraPlugins: ["review"] })).toThrow(/not offered/);
    const withFloorNames = parseProfileConfig({ profiles: { a: { plugins: ["review", "redaction", "handoff"] } } });
    const resolved = resolveSession(withFloorNames, {});
    expect(resolved.floor).toEqual(["review", "redaction"]);
    expect(resolved.plugins).toEqual(["handoff"]);
  });

  it("property: for any request at all the result has the full floor of the config and no way to lower it", () => {
    const requests = fc.oneof(
      fc.anything(),
      fc.record(
        {
          profile: fc.constantFrom("general", "minimal"),
          title: fc.string(),
          extraPlugins: fc.array(fc.constantFrom("computer", "mail-sim", "review", "redaction", "x")),
        },
        { requiredKeys: [] },
      ),
      fc.dictionary(fc.string(), fc.anything()),
    );
    fc.assert(
      fc.property(requests, (request) => {
        try {
          const resolved = resolveSession(config, request);
          expect(resolved.floor).toEqual([...SAFETY_FLOOR]);
          expect(resolved.plugins.some((p) => (SAFETY_FLOOR as readonly string[]).includes(p))).toBe(false);
          expect(resolved.warnings).toEqual([]);
        } catch (error) {
          expect(isOgbError(error)).toBe(true); // refused cleanly, never a crash
        }
      }),
      { numRuns: 500 },
    );
  });
});

describe("alwaysDeclaredTools", () => {
  it("accepts tool names with an underscore, and still refuses a bad name", () => {
    const base = { plugins: [] };
    expect(parseProfileConfig({ profiles: { p: { ...base, alwaysDeclaredTools: ["ask_human", "browser"] } } }).profiles.p?.alwaysDeclaredTools).toEqual([
      "ask_human",
      "browser",
    ]);
    expect(() => parseProfileConfig({ profiles: { p: { ...base, alwaysDeclaredTools: ["Bad Name"] } } })).toThrow(/alwaysDeclaredTools/);
  });
});
