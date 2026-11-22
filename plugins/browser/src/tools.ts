import type { PluginContext } from "@standin/contracts";
import type { Tool } from "sakura-agent";
import { createBrowserTool } from "sakura-agent-tools/browser";

/** agent-tools lives at <app root>/vendor/agent-tools (scripts/sync-agent-tools.sh); the image's app root is /opt/ogb. */
const TOOLS = `${process.env.OGB_APP_ROOT || "/opt/ogb"}/vendor/agent-tools`;

/**
 * Entry of the plugin (bundled to dist/tools.js). The `browser` tool of agent-tools on the workspace's own browser: the agent writes Playwright code,
 * its runner runs as a program of the workspace (its environment, no keys) and attaches to the browser over DevTools.
 */
export function createTools(ctx: PluginContext): Tool[] {
  const cdpUrl = ctx.workspace.cdpUrl;
  if (cdpUrl === undefined) return [];
  return [
    createBrowserTool({
      cdpUrl,
      shots: `${ctx.workspace.filesDir}/.screens`,
      runner: { program: process.execPath, args: [`${TOOLS}/dist/browser/runner.js`] },
      // the workspace gives the environment; the tool adds only its own names
      spawn: (program, args, env) => ctx.workspace.spawn([program, ...args], { env: only(env, "BROWSER_USE_") }),
    }),
  ];
}

function only(env: Record<string, string>, prefix: string): Record<string, string> {
  return Object.fromEntries(Object.entries(env).filter(([name]) => name.startsWith(prefix)));
}
