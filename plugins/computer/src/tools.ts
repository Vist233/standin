import type { PluginContext } from "@vesper/contracts";
import type { Tool } from "sakura-agent";
import { createComputerTool } from "sakura-agent-tools/computer";

/** agent-tools lives at <app root>/vendor/agent-tools (scripts/sync-agent-tools.sh); the image's app root is /opt/ogb. */
const TOOLS = `${process.env.OGB_APP_ROOT || "/opt/ogb"}/vendor/agent-tools`;

/**
 * Entry of the plugin (bundled to dist/tools.js). The `computer` tool of agent-tools on the workspace's desktop: the agent writes Python against the
 * accessibility tree, the picture and the input; the runner runs as a program of the workspace, whose environment already names the display and its
 * accessibility bus.
 */
export function createTools(ctx: PluginContext): Tool[] {
  if (ctx.workspace.display === undefined) return [];
  return [
    createComputerTool({
      env: () => ({ COMPUTER_USE_SHOTS: `${ctx.workspace.filesDir}/.screens` }),
      runner: { program: "python3", args: ["-u", `${TOOLS}/dist/computer/runner/runner.py`] },
      spawn: (program, args, env) => ctx.workspace.spawn([program, ...args], { env }),
    }),
  ];
}
