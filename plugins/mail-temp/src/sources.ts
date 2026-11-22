import { join } from "node:path";
import { createWatchSources, type EventSource } from "@vesper/connectors";
import type { PluginContext } from "@vesper/contracts";
import { providerFor } from "./provider.ts";

export async function createSources(ctx: PluginContext): Promise<EventSource[]> {
  return createWatchSources({
    provider: await providerFor(ctx),
    plugin: "mail-temp",
    sink: ctx.signals,
    cursorFile: join(ctx.dataDir, "cursor.json"),
    onError: (error) => ctx.log.error("could not deliver a mail signal", { error: String(error) }),
  });
}
