import { createConnectorTools } from "@standin/connectors";
import type { PluginContext } from "@standin/contracts";
import type { Tool } from "sakura-agent";
import { gmailFor } from "./shared.ts";

export async function createTools(ctx: PluginContext): Promise<Tool[]> {
  const gmail = gmailFor(ctx);
  return [
    {
      name: "gmail_connect",
      description: "Connects the person's Gmail to you (the person approves). Only one bot can hold it; afterwards gmail_list, gmail_read and gmail_send work.",
      parameters: { type: "object", properties: {} },
      effect: "network",
      async execute() {
        try {
          return { content: [{ type: "text", text: await gmail.connect() }] };
        } catch (error) {
          return { content: [{ type: "text", text: `Could not connect Gmail: ${(error as Error).message}` }], isError: true };
        }
      },
    },
    ...createConnectorTools(gmail.provider, { mailName: "gmail" }),
  ];
}
