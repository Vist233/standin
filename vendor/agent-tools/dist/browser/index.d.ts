import { type CodeToolOptions } from "../core/code-tool.ts";
import { type ChromeOptions } from "./chrome.ts";
export { findChrome, launchChrome, type ChromeOptions, type LaunchedChrome } from "./chrome.ts";
export declare const BROWSER_DESCRIPTION = "Runs JavaScript (Playwright) in your browser session. The code is the body of an async function: use await, and return the value you want to see. The session stays between calls: `page` (your tab), `context`, `browser`, `state` (an object for your values) and any name you assign without let/const are still there next time.\n\nWork in code, not one step per call: one call can fill a whole form, loop over many rows, wait for a condition, and read back what it changed. Return only what you need.\n\nWays to find and act on things, best first:\n1. Playwright locators: page.getByRole('button', { name: 'Save' }).click(), page.getByLabel('Email').fill('a@b.c'), page.getByText('Next'), page.locator('css'); read with innerText(), allInnerTexts(), page.evaluate(() => ...).\n2. snapshot() or snapshot(locator): the accessibility tree as text, to see what is there.\n3. screenshot() or screenshot(locator): the picture is shown to you; page.mouse.click(x, y) where there are no elements (canvases).\n4. cdp(method, params): a raw DevTools command.\nAlso sleep(ms); console.log output is returned; page = await context.newPage() makes a new tab yours.\n\nLogins, passwords, codes and CAPTCHAs belong to the person: stop and ask them. Every reply starts with your tab's url and title.";
export interface BrowserToolOptions extends Pick<CodeToolOptions, "spawn" | "timeoutSeconds" | "maxTimeoutSeconds"> {
    /** Attach to this browser (a DevTools address); it stays the caller's. Without it the tool starts its own Chrome at first use and closes it in close(). */
    cdpUrl?: string | undefined;
    chrome?: ChromeOptions | undefined;
    /** Where pictures are written (default <cwd>/.browser-use/shots). */
    shots?: string | undefined;
    /** How to start the runner (default: this Node with runner.ts); a host that runs it elsewhere gives its own. */
    runner?: {
        program: string;
        args: string[];
    } | undefined;
}
/** The `browser` tool: Playwright code against one browser; each agent has its own tab and names. */
export declare function createBrowserTool(options?: BrowserToolOptions): import("sakura-agent").Tool & {
    close(): Promise<void>;
};
