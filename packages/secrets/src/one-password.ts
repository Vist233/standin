import { OgbError } from "@standin/contracts";
import type { SecretProvider } from "./provider.ts";

/**
 * RESERVED SLOT (kept on purpose, the owner asked for it: docs/06). The place where the 1Password provider will go (references `op://vault/item/field`, the `op` CLI with a service
 * account). It exists now so configuration can already name the scheme and fail with a clear message.
 */
export function createOnePasswordSlot(): SecretProvider {
  return {
    async resolve() {
      throw new OgbError("unavailable", "the 1Password provider is not installed yet");
    },
  };
}
