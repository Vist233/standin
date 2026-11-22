import { realpath } from "node:fs/promises";
import { isAbsolute, join, relative, sep } from "node:path";
const text = (value, isError = false) => ({ content: [{ type: "text", text: value }], ...(isError ? { isError } : {}) });
const DESCRIPTION = "Share checked work with the other agents (of every run on this machine), and reuse theirs: a skill, a lemma, a dataset, a patch, a finding, as a package with a description and, when it can have one, a check (a command that proves it works). action 'search' (query, with filters such as type:skill or tag:x) before you start something others may have done; 'peek' (id, path: '.' or a file); 'pull' (id, verify: true to re-run its check before you rely on it); 'publish' (source: a directory in your files, or an object of file names to contents) when you have something checked that others could use. A package has a handoff.json: {\"id\": \"type/name\", \"version\": \"1.0.0\", \"description\": \"what it is and when to use it\", \"tags\": [...], \"verify\": {\"cmd\": [\"program\", \"arg\"], \"cwd\": \".\"}}; versions cannot change. Packages with secrets or personal paths are refused.";
/**
 * One tool, four actions. Its effect is `exec` because `pull` with `verify` and `publish` run the package's own check
 * (a shell command from another agent, with this process's rights); the review sees the action and its arguments.
 */
export function createHandoffToolOver(options) {
    return {
        name: "handoff",
        description: DESCRIPTION,
        parameters: {
            type: "object",
            properties: {
                action: { type: "string", enum: ["search", "peek", "pull", "publish"] },
                query: { type: "string", description: "search: words and filters" },
                limit: { type: "integer", description: "search: at most this many results" },
                id: { type: "string", description: "peek, pull: 'type/name' or 'type/name@1.2.0'" },
                path: { type: "string", description: "peek: '.' for the package, or a file name" },
                verify: { type: "boolean", description: "pull: re-run the package's check here" },
                source: { description: "publish: a directory path inside your files, or { fileName: content }" },
            },
            required: ["action"],
        },
        effect: "exec",
        replay: "never",
        async execute(args) {
            const input = (typeof args === "object" && args !== null ? args : {});
            try {
                switch (input.action) {
                    case "search":
                        return text(JSON.stringify(await options.port.search(typeof input.query === "string" ? input.query : "", typeof input.limit === "number" ? input.limit : undefined)));
                    case "peek":
                        if (typeof input.id !== "string")
                            return text("'id' is required for peek.", true);
                        return text(JSON.stringify(await options.port.peek(input.id, typeof input.path === "string" ? input.path : ".")));
                    case "pull":
                        if (typeof input.id !== "string")
                            return text("'id' is required for pull.", true);
                        return text(JSON.stringify(await options.port.pull(input.id, input.verify === true)));
                    case "publish":
                        return await publish(options, input.source);
                    default:
                        return text("'action' must be one of search, peek, pull, publish.", true);
                }
            }
            catch (error) {
                return text(error instanceof Error ? error.message : String(error), true);
            }
        },
    };
}
async function publish(options, source) {
    let target;
    if (typeof source === "string") {
        const inside = await insideWorkDir(options.workDir, source);
        if (!inside)
            return text("A directory to publish must be inside your files directory.", true);
        target = inside;
    }
    else if (typeof source === "object" && source !== null && !Array.isArray(source)) {
        target = source;
    }
    else {
        return text("'source' must be a directory path inside your files, or an object of file names to contents.", true);
    }
    const result = await options.port.publish(target);
    return text(JSON.stringify(result), result.status === "rejected");
}
/** The real path of `candidate` (relative paths are taken from the files directory) if it is inside the files directory, otherwise undefined. */
async function insideWorkDir(workDir, candidate) {
    try {
        const root = await realpath(workDir);
        const real = await realpath(isAbsolute(candidate) ? candidate : join(root, candidate));
        const rel = relative(root, real);
        return rel === "" || (!rel.startsWith("..") && !rel.startsWith(sep) && !isAbsolute(rel)) ? real : undefined;
    }
    catch {
        return undefined;
    }
}
