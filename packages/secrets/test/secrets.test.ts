import { isOgbError } from "@standin/contracts";
import { describe, expect, it } from "vitest";
import { createEnvironmentProvider, createOnePasswordSlot, createSecretRegistry, isSecretReference } from "../src/index.ts";
import { createFakeSecrets } from "../src/testing/index.ts";

const kindOf = (kind: string) => (error: unknown) => isOgbError(error, kind as never);
const VALUE = "very-secret-value-123";

describe("registry and the 1Password slot", () => {
  it("routes scheme:name to the provider for the scheme", async () => {
    const registry = createSecretRegistry({ env: createFakeSecrets({ KEY: "v" }) });
    expect(await registry.resolve("env:KEY")).toBe("v");
    await expect(registry.resolve("env:NOPE")).rejects.toSatisfy(kindOf("not_found"));
    await expect(registry.resolve("op:vault/item/field")).rejects.toSatisfy(kindOf("not_found"));
    const vault = createSecretRegistry({ op: createFakeSecrets({ "vault/item/field": "from-op" }) });
    expect(await vault.resolve("op://vault/item/field")).toBe("from-op");
    expect(await vault.resolve("op:vault/item/field")).toBe("from-op");
    await expect(registry.resolve("plain-text-key")).rejects.toSatisfy(kindOf("invalid_input"));
  });

  it("does not echo a literal that was pasted where a reference belongs", async () => {
    const registry = createSecretRegistry({});
    const pasted = `sk-${"x".repeat(30)}`;
    await expect(registry.resolve(pasted)).rejects.toSatisfy(kindOf("invalid_input"));
  });

  it("recognises references", () => {
    expect(isSecretReference("env:KEY")).toBe(true);
    expect(isSecretReference("op://vault/item/field")).toBe(true);
    expect(isSecretReference("sk-abc")).toBe(false);
  });

  it("the reserved 1Password slot says it is not installed", async () => {
    await expect(createOnePasswordSlot().resolve("op://v/i/f")).rejects.toSatisfy(kindOf("unavailable"));
  });

  it("the fake records references, not values", async () => {
    const fake = createFakeSecrets({ A: "x" });
    await fake.resolve("A");
    await fake.resolve("B").catch(() => {});
    expect(fake.requested).toEqual(["A", "B"]);
  });
});

describe("environment provider", () => {
  const env = { MODEL_KEY: VALUE, EMPTY: "", OTHER: "other-secret-value" };

  it("hands out only the listed variables, read at the moment of use", async () => {
    const live: Record<string, string | undefined> = { ...env };
    const provider = createEnvironmentProvider({ env: live, allowed: ["MODEL_KEY", "EMPTY", "ABSENT"] });
    expect(await provider.resolve("MODEL_KEY")).toBe(VALUE);
    live.MODEL_KEY = "rotated";
    expect(await provider.resolve("MODEL_KEY")).toBe("rotated");
  });

  it("refuses a name that is not offered without saying whether it exists, and says not_found for unset or empty ones", async () => {
    const provider = createEnvironmentProvider({ env, allowed: ["MODEL_KEY", "EMPTY", "ABSENT"] });
    const refused = provider.resolve("OTHER");
    await expect(refused).rejects.toSatisfy(kindOf("denied"));
    await expect(refused).rejects.not.toThrow("other-secret-value");
    await expect(provider.resolve("PATH")).rejects.toSatisfy(kindOf("denied"));
    await expect(provider.resolve("EMPTY")).rejects.toSatisfy(kindOf("not_found"));
    await expect(provider.resolve("ABSENT")).rejects.toSatisfy(kindOf("not_found"));
  });

  it("works behind the scheme registry as env:NAME and never puts a value into an error", async () => {
    const registry = createSecretRegistry({ env: createEnvironmentProvider({ env, allowed: ["MODEL_KEY"] }) });
    expect(await registry.resolve("env:MODEL_KEY")).toBe(VALUE);
    const failure = await registry.resolve("env:OTHER").catch((e: Error) => e.message);
    expect(String(failure)).not.toContain("other-secret-value");
    expect(String(failure)).not.toContain(VALUE);
  });
});
