import { createConnectorTools } from "@standin/connectors";
import type { PluginContext } from "@standin/contracts";
import type { Tool } from "sakura-agent";
import { outlookFor } from "./shared.ts";

export async function createTools(ctx: PluginContext): Promise<Tool[]> {
  const outlook = outlookFor(ctx);
  return [
    {
      name: "outlook_connect",
      description:
        "Connects the person's Outlook mailbox to you: returns a page and a code to give the person, who signs in with their Microsoft account. You are told when it is done. Only one bot can hold it.",
      parameters: { type: "object", properties: {} },
      effect: "network",
      async execute() {
        try {
          return { content: [{ type: "text", text: await outlook.connect() }] };
        } catch (error) {
          return { content: [{ type: "text", text: `Could not start the sign-in: ${(error as Error).message}` }], isError: true };
        }
      },
    },
    ...createConnectorTools(outlook.provider, { mailName: "outlook" }),
  ];
}
