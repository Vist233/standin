import { resolveSession } from "@standin/profiles";
import { sampleProfileConfig } from "@standin/profiles/testing";
import type { AgentsMdInput } from "../render.ts";

/** A complete input for a sample profile, for tests of anything that writes or reads the file. */
export function sampleAgentsMdInput(profile: "general" | "minimal" = "general"): AgentsMdInput {
  return {
    profile: resolveSession(sampleProfileConfig(), { profile }),
    sessionName: "Quarterly taxes",
    baseTools: ["read", "write", "edit", "bash", "tool_search", "tool_call"],
    workspace: { filesDir: "/workspaces/ws-1/files", hasDisplay: true, hasBrowser: true },
  };
}
