import { createConnectorTools } from "@standin/connectors";
import type { PluginContext } from "@standin/contracts";
import type { Tool } from "sakura-agent";
import { providerFor } from "./provider.ts";

export async function createTools(ctx: PluginContext): Promise<Tool[]> {
  return createConnectorTools(await providerFor(ctx));
}
