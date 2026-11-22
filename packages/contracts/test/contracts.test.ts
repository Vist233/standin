import { describe, expect, it } from "vitest";
import { CORE_EVENT_TYPES, ERROR_KINDS, EVENT_SCHEMA_VERSION, isJsonObject, isOgbError, isSessionEvent, OgbError } from "../src/index.ts";
import { signalDraft } from "../src/testing/index.ts";

describe("OgbError", () => {
  it("carries its kind and cause and is recognised by kind", () => {
    const cause = new Error("disk");
    const error = new OgbError("unavailable", "cannot write", { cause });
    expect(error.kind).toBe("unavailable");
    expect(error.cause).toBe(cause);
    expect(error.name).toBe("OgbError");
    expect(isOgbError(error)).toBe(true);
    expect(isOgbError(error, "unavailable")).toBe(true);
    expect(isOgbError(error, "corrupt")).toBe(false);
    expect(isOgbError(new Error("x"))).toBe(false);
  });

  it("is recognised when it comes from a bundled plugin's own copy of the class (testers' B-8)", () => {
    class OgbError extends Error {
      readonly kind = "not_found";
      override name = "OgbError";
    }
    expect(isOgbError(new OgbError("no such secret"), "not_found")).toBe(true);
    expect(isOgbError(new OgbError("no such secret"), "denied")).toBe(false);
    expect(isOgbError({ name: "Error", kind: "not_found" }, "not_found")).toBe(false);
  });

  it("lists every kind once", () => {
    expect(new Set(ERROR_KINDS).size).toBe(ERROR_KINDS.length);
  });
});

describe("isSessionEvent", () => {
  const good = { v: EVENT_SCHEMA_VERSION, seq: 1, at: 1000, sessionId: "s1", type: "run.started", payload: null };

  it("accepts a well-formed event", () => {
    expect(isSessionEvent(good)).toBe(true);
  });

  it.each([
    ["seq 0", { ...good, seq: 0 }],
    ["fractional seq", { ...good, seq: 1.5 }],
    ["string at", { ...good, at: "now" }],
    ["empty type", { ...good, type: "" }],
    ["array", []],
    ["null", null],
    ["number", 3],
  ])("rejects %s", (_name, value) => {
    expect(isSessionEvent(value)).toBe(false);
  });

  it("rejects an event without a payload", () => {
    const { payload: _payload, ...withoutPayload } = good;
    expect(isSessionEvent(withoutPayload)).toBe(false);
  });
});

describe("misc", () => {
  it("knows json objects", () => {
    expect(isJsonObject({})).toBe(true);
    expect(isJsonObject([])).toBe(false);
    expect(isJsonObject(null)).toBe(false);
  });

  it("has unique core event types and a test builder", () => {
    expect(new Set(CORE_EVENT_TYPES).size).toBe(CORE_EVENT_TYPES.length);
    expect(signalDraft("a")).toEqual({ id: "a", source: "external:test", text: "text of a" });
    expect(signalDraft("a", { source: "user", text: "hi" })).toEqual({ id: "a", source: "user", text: "hi" });
  });
});
