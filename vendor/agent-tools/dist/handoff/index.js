import { createHandoffPort } from "./adapter.js";
import { secretReview } from "./secret-scan.js";
import { createHandoffToolOver } from "./tool.js";
export { createHandoffPort } from "./adapter.js";
export { scanDirectory, secretReview } from "./secret-scan.js";
export { createHandoffToolOver } from "./tool.js";
/**
 * The `handoff` tool: agents hand each other checked work packages through one store (the step-by-step-handoff-mcp library), instead of
 * sharing context. Every package is reviewed for secrets and personal paths before it is published.
 */
export function createHandoffTool(options) {
    const port = createHandoffPort({ ...options, hooks: { review: secretReview } });
    return createHandoffToolOver({ port, workDir: options.workDir });
}
