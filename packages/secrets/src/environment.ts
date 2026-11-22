import { OgbError } from "@standin/contracts";
import type { SecretProvider } from "./provider.ts";

export interface EnvironmentProviderOptions {
  /** The environment to read (pass `process.env`; tests pass an object). */
  env: Readonly<Record<string, string | undefined>>;
  /** The only variable names this provider will hand out. A reference to any other name is refused, so a config file cannot read the whole environment. */
  allowed: readonly string[];
}

/**
 * Secrets that arrive as environment variables of the container (for example the model key from `docker compose`). A
 * reference is the variable name. Only listed names resolve; the value is read at the moment of use and never kept here.
 */
export function createEnvironmentProvider(options: EnvironmentProviderOptions): SecretProvider {
  const allowed = new Set(options.allowed);
  return {
    async resolve(reference) {
      if (!allowed.has(reference)) throw new OgbError("denied", `environment variable '${reference}' is not offered as a secret`);
      const value = options.env[reference];
      if (value === undefined || value === "") throw new OgbError("not_found", `the environment variable ${reference} is not set`);
      return value;
    },
  };
}
