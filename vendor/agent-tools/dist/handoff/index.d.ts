export { createHandoffPort } from "./adapter.ts";
export type { HandoffPort, SearchHit } from "./port.ts";
export { scanDirectory, secretReview } from "./secret-scan.ts";
export { createHandoffToolOver } from "./tool.ts";
export interface HandoffToolOptions {
    /** The store every agent that should share reads and writes (one per machine, or per group of agents). */
    storeRoot: string;
    /** This agent's own directory: a directory it publishes must be inside it; what it pulls lands in `<workDir>/.exchange/`. */
    workDir: string;
    /** Recorded as the author of what this agent publishes. */
    agentId: string;
}
/**
 * The `handoff` tool: agents hand each other checked work packages through one store (the step-by-step-handoff-mcp library), instead of
 * sharing context. Every package is reviewed for secrets and personal paths before it is published.
 */
export declare function createHandoffTool(options: HandoffToolOptions): import("sakura-agent").Tool;
