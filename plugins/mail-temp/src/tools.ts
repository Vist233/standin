import { createConnectorTools } from "@vesper/connectors";
import type { PluginContext } from "@vesper/contracts";
import type { Tool } from "sakura-agent";
import { providerFor } from "./provider.ts";

export async function createTools(ctx: PluginContext): Promise<Tool[]> {
  return createConnectorTools(await providerFor(ctx));
}
