import type { Tool } from "sakura-agent";
import type { HandoffPort } from "./port.ts";
export interface HandoffToolOptions {
    port: HandoffPort;
    /** The agent's files directory: a directory to publish must be inside it. */
    workDir: string;
}
/**
 * One tool, four actions. Its effect is `exec` because `pull` with `verify` and `publish` run the package's own check
 * (a shell command from another agent, with this process's rights); the review sees the action and its arguments.
 */
export declare function createHandoffToolOver(options: HandoffToolOptions): Tool;
