import { fileURLToPath } from "node:url";
import { createCodeTool } from "../core/code-tool.js";
import { launchChrome } from "./chrome.js";
export { findChrome, launchChrome } from "./chrome.js";
export const BROWSER_DESCRIPTION = `Runs JavaScript (Playwright) in your browser session. The code is the body of an async function: use await, and return the value you want to see. The session stays between calls: \`page\` (your tab), \`context\`, \`browser\`, \`state\` (an object for your values) and any name you assign without let/const are still there next time.

Work in code, not one step per call: one call can fill a whole form, loop over many rows, wait for a condition, and read back what it changed. Return only what you need.

Ways to find and act on things, best first:
1. Playwright locators: page.getByRole('button', { name: 'Save' }).click(), page.getByLabel('Email').fill('a@b.c'), page.getByText('Next'), page.locator('css'); read with innerText(), allInnerTexts(), page.evaluate(() => ...).
2. snapshot() or snapshot(locator): the accessibility tree as text, to see what is there.
3. screenshot() or screenshot(locator): the picture is shown to you; page.mouse.click(x, y) where there are no elements (canvases).
4. cdp(method, params): a raw DevTools command.
Also sleep(ms); console.log output is returned; page = await context.newPage() makes a new tab yours.

Logins, passwords, codes and CAPTCHAs belong to the person: stop and ask them. Every reply starts with your tab's url and title.`;
const RUNNER = fileURLToPath(new URL(import.meta.url.endsWith(".ts") ? "./runner.ts" : "./runner.js", import.meta.url));
/** The `browser` tool: Playwright code against one browser; each agent has its own tab and names. */
export function createBrowserTool(options = {}) {
    let launched;
    return createCodeTool({
        name: "browser",
        description: BROWSER_DESCRIPTION,
        language: "JavaScript",
        effect: "network",
        runner: options.runner ?? { program: process.execPath, args: [RUNNER] },
        spawn: options.spawn,
        timeoutSeconds: options.timeoutSeconds,
        maxTimeoutSeconds: options.maxTimeoutSeconds,
        survives: "The browser and its tabs are still there (context.pages() lists them).",
        async env() {
            let cdpUrl = options.cdpUrl;
            if (!cdpUrl) {
                launched ??= launchChrome(options.chrome).catch((error) => {
                    launched = undefined; // the next call tries again
                    throw error;
                });
                cdpUrl = (await launched).cdpUrl;
            }
            return { PATH: process.env.PATH ?? "", BROWSER_USE_CDP: cdpUrl, ...(options.shots ? { BROWSER_USE_SHOTS: options.shots } : {}) };
        },
        async onClose() {
            const chrome = launched;
            launched = undefined;
            await (await chrome?.catch(() => undefined))?.close();
        },
    });
}
