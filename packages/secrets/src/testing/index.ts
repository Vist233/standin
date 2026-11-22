import { OgbError } from "@standin/contracts";
import type { SecretProvider } from "../provider.ts";

export interface FakeSecrets extends SecretProvider {
  /** References that were asked for, in order (never values). */
  readonly requested: string[];
}

/** An in-memory provider with fixed values; unknown references are `not_found`. */
export function createFakeSecrets(values: Record<string, string>): FakeSecrets {
  const requested: string[] = [];
  return {
    requested,
    async resolve(reference) {
      requested.push(reference);
      const value = values[reference];
      if (value === undefined) throw new OgbError("not_found", `no secret '${reference}' (fake)`);
      return value;
    },
  };
}
