import { OgbError } from "@standin/contracts";
import type { SecretProvider } from "./provider.ts";

const REFERENCE = /^([a-z][a-z0-9-]*):(.+)$/;

export function isSecretReference(text: string): boolean {
  return REFERENCE.test(text);
}

/**
 * Routes `scheme:name` to the provider registered for the scheme (`env:OPENAI_KEY` -> the env-file provider with
 * `OPENAI_KEY`; `op:vault/item/field` -> 1Password later). A caller never learns which provider answered.
 */
export function createSecretRegistry(providers: Record<string, SecretProvider>): SecretProvider {
  return {
    async resolve(reference) {
      const match = REFERENCE.exec(reference);
      if (!match) throw new OgbError("invalid_input", `'${reference}' is not a secret reference (expected scheme:name, for example env:API_KEY)`);
      const [, scheme, name] = match as unknown as [string, string, string];
      const provider = providers[scheme];
      if (!provider) throw new OgbError("not_found", `no secret provider for scheme '${scheme}'`);
      // `op://vault/item/field` is 1Password's own spelling; the provider gets `vault/item/field` either way.
      return provider.resolve(name.replace(/^\/\//, ""));
    },
  };
}
