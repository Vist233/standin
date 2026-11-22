import { join } from "node:path";
import { type Account, type Provider, ProviderRegistry } from "@standin/connectors";
import type { PluginContext } from "@standin/contracts";
import { createFileMailbox } from "./mailbox.ts";

/** The seam in use: the sim registers itself as the provider kind `sim`; a real provider plugin registers `imap-smtp` the same way. */
export const registry = new ProviderRegistry<PluginContext>();

registry.register(
  "sim",
  (_account: Account, ctx: PluginContext): Provider =>
    createFileMailbox({
      // one mailbox per session: its folders are in the session's own data directory
      directory: join(ctx.dataDir, "mailbox"),
      address: "agent@sim.test",
      pollMs: Number(process.env.OGB_MAIL_SIM_POLL_MS) > 0 ? Number(process.env.OGB_MAIL_SIM_POLL_MS) : 1000,
    }),
);

export function providerFor(ctx: PluginContext): Promise<Provider> {
  return registry.create({ name: "sim", kind: "sim" }, ctx);
}
