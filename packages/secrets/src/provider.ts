import type { SecretResolver } from "@standin/contracts";

/** A source of secret values. What a reference looks like is the provider's business. */
export interface SecretProvider extends SecretResolver {}
