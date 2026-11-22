import { join } from "node:path";
import { createWatchSources, type EventSource } from "@vesper/connectors";
import type { PluginContext } from "@vesper/contracts";
import { gmailFor } from "./shared.ts";

export async function createSources(ctx: PluginContext): Promise<EventSource[]> {
  return createWatchSources({
    provider: gmailFor(ctx).provider,
    plugin: "mail-gmail",
    sink: ctx.signals,
    cursorFile: join(ctx.dataDir, "cursor.json"),
    onError: (error) => ctx.log.error("could not deliver a mail signal", { error: String(error) }),
  });
}
