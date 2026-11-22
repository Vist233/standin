import type { PluginContext } from "@vesper/contracts";
import type { Tool } from "sakura-agent";
import { createHandoffTool } from "sakura-agent-tools/handoff";

/**
 * Entry of the plugin (bundled to dist/tools.js). The `handoff` tool of agent-tools: one store for every session of the box (the plugin's shared
 * directory); each agent publishes from and pulls into its own files directory. Packages with secrets or personal paths are refused.
 */
export function createTools(ctx: PluginContext): Tool[] {
  return [createHandoffTool({ storeRoot: ctx.sharedDataDir, workDir: ctx.workspace.filesDir, agentId: ctx.workspace.workspaceId })];
}
