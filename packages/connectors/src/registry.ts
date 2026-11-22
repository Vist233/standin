import { OgbError } from "@standin/contracts";
import type { Account, Provider } from "./types.ts";

export type ProviderFactory<Context = unknown> = (account: Account, context: Context) => Provider | Promise<Provider>;

/**
 * Maps a provider kind (`imap-smtp`, `sim`, later `microsoft-graph`) to the function that builds it from an accounts-file
 * entry. The tools never name a provider, so a new kind is a new plugin that registers itself and nothing else changes.
 */
export class ProviderRegistry<Context = unknown> {
  private readonly factories = new Map<string, ProviderFactory<Context>>();

  register(kind: string, factory: ProviderFactory<Context>): void {
    if (this.factories.has(kind)) throw new OgbError("conflict", `a provider of kind '${kind}' is already registered`);
    this.factories.set(kind, factory);
  }

  kinds(): string[] {
    return [...this.factories.keys()];
  }

  async create(account: Account, context: Context): Promise<Provider> {
    const factory = this.factories.get(account.kind);
    if (!factory) throw new OgbError("not_found", `no provider of kind '${account.kind}' (known: ${this.kinds().join(", ") || "none"})`);
    return factory(account, context);
  }
}
