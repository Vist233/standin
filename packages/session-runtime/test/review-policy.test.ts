// Vesper's review policy (owner, 2026-11-17): only big, hard-to-undo things are stopped; what the person approves anyway is not judged
// again. The policy reaches the reviewer's own prompt.
import { createFauxClient } from "sakura-agent/testing";
import { describe, expect, it } from "vitest";
import { VESPER_REVIEW_POLICY } from "../src/review-policy.ts";
import { defaultSafetyPlugins } from "../src/safety.ts";

describe("review policy", () => {
  it("lets ordinary work and approved sending through, and keeps the big things: rm -rf, git history, secrets", () => {
    const text = JSON.stringify(VESPER_REVIEW_POLICY);
    expect(VESPER_REVIEW_POLICY.environment.join(" ")).toMatch(/approved by the person/);
    expect(VESPER_REVIEW_POLICY.allow.join(" ")).toMatch(/Sending mail/);
    expect(VESPER_REVIEW_POLICY.soft_deny.join(" ")).toMatch(/rm -rf/);
    expect(VESPER_REVIEW_POLICY.soft_deny.join(" ")).toMatch(/push --force/);
    expect(VESPER_REVIEW_POLICY.hard_deny.join(" ")).toMatch(/secrets/);
    expect(text).not.toMatch(/Sending project data to a host the user did not name/); // the framework's default that denied the person's mail
  });

  it("is wired into the safety floor: review and redaction, redaction first", () => {
    const llm = createFauxClient([{ text: "{}" }]);
    expect(defaultSafetyPlugins(["review", "redaction"], llm).map((p) => p.name)).toEqual(["redaction", "review"]);
    expect(defaultSafetyPlugins(["redaction"], llm, { allow: ["$defaults"] }).map((p) => p.name)).toEqual(["redaction"]);
  });
});
