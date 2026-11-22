// The shared core of the browser and computer tools: a tool whose only input is code, run by a child process ("runner") that keeps its names
// between calls. A runner reads one JSON request per line ({id, code}) and writes one reply per line ({id, ok, value, logs, images, error, where}).
import { spawn as spawnProcess } from "node:child_process";
import { createInterface } from "node:readline";
const localSpawn = (program, args, env) => spawnProcess(program, args, { env, stdio: ["pipe", "pipe", "pipe"] });
/**
 * Each agent (told apart by its conversation log, which a sub-agent has of its own) gets its own runner, started on first use and kept. A call that
 * runs too long or is cancelled cannot be stopped inside the runner, so the runner is killed and the next call starts a fresh one; the reply says so.
 */
export function createCodeTool(options) {
    const sessions = new Map();
    const defaultSeconds = options.timeoutSeconds ?? 60;
    const maxSeconds = options.maxTimeoutSeconds ?? 300;
    let turn = Promise.resolve();
    return {
        name: options.name,
        description: options.description,
        parameters: {
            type: "object",
            properties: {
                code: { type: "string", description: `${options.language} to run; its value is returned` },
                timeoutSeconds: { type: "integer", minimum: 1, maximum: maxSeconds, description: `How long the code may run (default ${defaultSeconds})` },
            },
            required: ["code"],
        },
        effect: options.effect,
        replay: "never",
        executionMode: "serial",
        async execute(args, context) {
            const input = (typeof args === "object" && args !== null ? args : {});
            if (typeof input.code !== "string" || input.code.trim() === "")
                return text(`'code' is required: ${options.language} to run.`, true);
            const seconds = typeof input.timeoutSeconds === "number" && input.timeoutSeconds > 0 ? Math.min(input.timeoutSeconds, maxSeconds) : defaultSeconds;
            const key = context.log;
            let mine = sessions.get(key);
            if (!mine)
                sessions.set(key, (mine = session(options)));
            const run = () => mine.run(input.code, seconds * 1000, context.signal);
            if (!options.oneAtATime)
                return render(await run(), options.survives);
            const result = turn.then(run);
            turn = result.catch(() => undefined);
            return render(await result, options.survives);
        },
        async close() {
            const all = [...sessions.values()];
            sessions.clear();
            await Promise.all(all.map((one) => one.close()));
            await options.onClose?.();
        },
    };
}
/** One agent's runner: one call at a time; killed on timeout, cancel or crash, and started again by the next call. */
function session(options) {
    const spawn = options.spawn ?? localSpawn;
    let child;
    let nextId = 1;
    let queue = Promise.resolve();
    const waiting = new Map();
    const onExit = new WeakMap(); // only the call waiting on that child hears of its end
    let stderrTail = "";
    function start(env) {
        const started = spawn(options.runner.program, options.runner.args, env);
        stderrTail = "";
        started.stderr?.on("data", (chunk) => {
            stderrTail = (stderrTail + chunk.toString()).slice(-2000);
        });
        if (started.stdout)
            createInterface({ input: started.stdout }).on("line", (line) => {
                try {
                    const reply = JSON.parse(line);
                    waiting.get(reply.id)?.(reply);
                }
                catch {
                    // not a reply: a library that printed to stdout
                }
            });
        started.once("exit", (code) => {
            if (child === started)
                child = undefined;
            onExit.get(started)?.(code);
        });
        return started;
    }
    async function runOne(code, timeoutMs, signal) {
        if (signal.aborted)
            return failed(0, "cancelled before it started");
        try {
            child ??= start(await options.env());
        }
        catch (error) {
            return failed(0, error instanceof Error ? error.message : String(error));
        }
        const id = nextId++;
        const current = child;
        return new Promise((resolve) => {
            const finish = (reply) => {
                clearTimeout(timer);
                signal.removeEventListener("abort", onAbort);
                waiting.delete(id);
                onExit.delete(current);
                resolve(reply);
            };
            const restart = (why) => {
                if (child === current)
                    child = undefined;
                current.kill("SIGKILL");
                finish({ ...failed(id, why), restarted: true });
            };
            const timer = setTimeout(() => restart(`the code ran longer than ${Math.round(timeoutMs / 1000)} s and was stopped`), timeoutMs);
            const onAbort = () => restart("the call was cancelled and the code was stopped");
            signal.addEventListener("abort", onAbort, { once: true });
            onExit.set(current, (code) => finish({ ...failed(id, `the runner ended (exit ${code})${stderrTail ? `: ${stderrTail.trim().split("\n").slice(-5).join("\n")}` : ""}`), restarted: true }));
            waiting.set(id, finish);
            current.stdin?.write(`${JSON.stringify({ id, code })}\n`);
        });
    }
    return {
        run(code, timeoutMs, signal) {
            const result = queue.then(() => runOne(code, timeoutMs, signal));
            queue = result.catch(() => undefined);
            return result;
        },
        /** Ends the runner by closing its input (it cleans up after itself), and kills it after 5 s. */
        async close() {
            const current = child;
            if (!current)
                return;
            child = undefined;
            await new Promise((resolve) => {
                const timer = setTimeout(() => {
                    current.kill("SIGKILL");
                    resolve();
                }, 5000);
                current.once("exit", () => {
                    clearTimeout(timer);
                    resolve();
                });
                current.stdin?.end();
            });
        },
    };
}
/** What the model reads: where it is, what was printed, the value or the error, what a restart lost, then the pictures. */
export function render(reply, survives) {
    const parts = [];
    if (reply.where)
        parts.push(`[${reply.where}]`);
    if (reply.logs.length > 0)
        parts.push(`printed:\n${reply.logs.join("\n")}`);
    parts.push(reply.ok ? (reply.value === undefined ? "(no value)" : `value:\n${reply.value}`) : `error: ${reply.error ?? "unknown"}`);
    if (reply.restarted)
        parts.push(`The session was restarted: your names are gone. ${survives} Look before doing anything again: the stopped code may have done part of its work.`);
    return {
        content: [{ type: "text", text: parts.join("\n\n") }, ...reply.images.map((path) => ({ type: "image", mediaType: "image/png", ref: path }))],
        ...(reply.ok ? {} : { isError: true }),
    };
}
function failed(id, error) {
    return { id, ok: false, logs: [], images: [], error };
}
function text(value, isError = false) {
    return { content: [{ type: "text", text: value }], ...(isError ? { isError } : {}) };
}
