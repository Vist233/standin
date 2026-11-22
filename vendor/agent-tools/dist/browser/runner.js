// The child process that runs the agent's code against a browser. It reads one JSON request per line on stdin and writes one JSON reply per line on
// stdout; nothing else is written to stdout. It ends when stdin ends (its host is gone).
// It never launches a browser: it attaches to one whose lifetime is its host's, so killing a runner in the middle of the agent's code loses nothing
// but the runner's own variables.
//   BROWSER_USE_CDP       the DevTools address of the browser (http://127.0.0.1:<port> or ws://...), required
//   BROWSER_USE_SHOTS     where screenshots are written (default <cwd>/.browser-use/shots)
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { chromium } from "playwright-core";
const MAX_VALUE = 12_000;
const MAX_LOG_LINES = 200;
const MAX_LOG_CHARS = 20_000;
const MAX_SNAPSHOT = 15_000;
const shots = process.env.BROWSER_USE_SHOTS || join(process.cwd(), ".browser-use", "shots");
let browser;
let shotCount = 0;
/** What the agent's code sees as names. Assigning to one of them (`page = await context.newPage()`) keeps the new value for later calls. */
const scope = {
    browser: undefined,
    context: undefined,
    page: undefined,
    /** A place to keep values across calls; a plain assignment to a new name (`rows = [...]`) is kept too. */
    state: {},
};
async function connect() {
    if (browser?.isConnected())
        return;
    const cdp = process.env.BROWSER_USE_CDP;
    if (!cdp)
        throw new Error("BROWSER_USE_CDP is not set: the runner attaches to a browser and never starts one");
    browser = await chromium.connectOverCDP(cdp);
    const context = browser.contexts()[0] ?? (await browser.newContext());
    scope.browser = browser;
    scope.context = context;
    scope.page = await context.newPage(); // a tab of this session's own: another agent's tab is never moved
}
/** The page the code acts on: the agent's `page` if it is still open, else its context's last page, else a new one. */
async function currentPage() {
    const page = scope.page;
    if (page && !page.isClosed())
        return page;
    const context = scope.context;
    const next = context.pages().at(-1) ?? (await context.newPage());
    scope.page = next;
    return next;
}
const cdpSessions = new WeakMap();
function helpers(images) {
    return {
        /** The accessibility tree of the page (or of a locator) as YAML text: roles and names to build locators from. */
        async snapshot(target) {
            const where = target ?? (await currentPage());
            const text = "ariaSnapshot" in where ? await where.ariaSnapshot() : await where.locator("body").ariaSnapshot();
            return text.length > MAX_SNAPSHOT ? `${text.slice(0, MAX_SNAPSHOT)}\n… [${text.length - MAX_SNAPSHOT} more characters: snapshot a smaller part, e.g. snapshot(page.locator('main'))]` : text;
        },
        /** Takes a picture of the page (or of a locator); the picture is shown to you with the reply. Returns its path. */
        async screenshot(target, options = {}) {
            mkdirSync(shots, { recursive: true });
            const path = join(shots, `shot-${process.pid}-${Date.now()}-${++shotCount}.png`);
            const where = target ?? (await currentPage());
            await where.screenshot({ path, ...("goto" in where ? { fullPage: options.fullPage === true } : {}) });
            images.push(path);
            return path;
        },
        /** Sends a raw DevTools command for the page. */
        async cdp(method, params = {}, target) {
            const page = target ?? (await currentPage());
            let session = cdpSessions.get(page);
            if (!session) {
                session = await page.context().newCDPSession(page);
                cdpSessions.set(page, session);
            }
            return session.send(method, params);
        },
        sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    };
}
function capturingConsole(logs) {
    let chars = 0;
    const write = (...parts) => {
        if (logs.length >= MAX_LOG_LINES || chars >= MAX_LOG_CHARS) {
            if (logs.at(-1) !== "… [more output cut]")
                logs.push("… [more output cut]");
            return;
        }
        const line = parts.map((part) => (typeof part === "string" ? part : safeJson(part))).join(" ");
        chars += line.length;
        logs.push(line);
    };
    return { log: write, info: write, warn: write, error: write, debug: write, table: write, dir: write };
}
function safeJson(value) {
    try {
        return JSON.stringify(value) ?? String(value);
    }
    catch {
        return String(value);
    }
}
const AsyncFunction = Object.getPrototypeOf(async () => { }).constructor;
async function run(request) {
    const logs = [];
    const images = [];
    const reply = { id: request.id, ok: true, logs, images };
    try {
        await connect();
        await currentPage();
        // A function made by the Function constructor is in sloppy mode, so `with` works: names resolve to the scope first, and an assignment to one of
        // them changes the scope, which outlives the call.
        const body = new AsyncFunction("__scope", "__helpers", `with (__helpers) { with (__scope) {\n${request.code}\n} }`);
        const value = await body(scope, { ...helpers(images), console: capturingConsole(logs) });
        if (value !== undefined) {
            const text = typeof value === "string" ? value : safeJson(value);
            reply.value = text.length > MAX_VALUE ? `${text.slice(0, MAX_VALUE)}… [${text.length - MAX_VALUE} more characters: return less]` : text;
        }
    }
    catch (error) {
        reply.ok = false;
        reply.error = describe(error);
    }
    const where = await whereLine();
    if (where)
        reply.where = where;
    return reply;
}
function describe(error) {
    if (!(error instanceof Error))
        return String(error);
    const where = error.stack?.split("\n").find((line) => line.includes("<anonymous>") || line.includes("eval at"));
    const message = error.message.split("\n").slice(0, 12).join("\n"); // Playwright's call logs are long; the first lines say what failed
    return where ? `${error.name}: ${message}\n${where.trim()}` : `${error.name}: ${message}`;
}
/** Where the agent is: its tab's url and title and how many tabs are open. */
async function whereLine() {
    try {
        const page = scope.page;
        if (!page || page.isClosed())
            return undefined;
        const title = await Promise.race([page.title(), new Promise((resolve) => setTimeout(() => resolve(""), 1000))]);
        return `tab: ${page.url()} | ${title || "(no title)"} | ${scope.context.pages().length} tab(s) open`;
    }
    catch {
        return undefined;
    }
}
const lines = createInterface({ input: process.stdin });
let chain = Promise.resolve();
lines.on("line", (line) => {
    chain = chain.then(async () => {
        let request;
        try {
            request = JSON.parse(line);
        }
        catch {
            return;
        }
        process.stdout.write(`${JSON.stringify(await run(request))}\n`);
    });
});
lines.on("close", () => {
    // The browser is not ours: close only this session's own tab and let go.
    void chain.finally(async () => {
        const page = scope.page;
        await page?.close().catch(() => undefined);
        process.exit(0);
    });
});
