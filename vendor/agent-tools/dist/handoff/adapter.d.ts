import { type Hooks } from "step-by-step-handoff-mcp/core";
import type { HandoffPort } from "./port.ts";
export interface AdapterOptions {
    /** The store all sessions of the box share. */
    storeRoot: string;
    /** This agent's files directory; pulls land in `<workDir>/.exchange/`. */
    workDir: string;
    /** Recorded as the author of what this agent publishes. */
    agentId: string;
    hooks?: Partial<Hooks>;
}
/** The one place that imports `step-by-step-handoff-mcp/core`. */
export declare function createHandoffPort(options: AdapterOptions): HandoffPort;
