import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
const PLACES = [
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    "/Applications/Chromium.app/Contents/MacOS/Chromium",
    "/usr/bin/chromium",
    "/usr/bin/chromium-browser",
    "/usr/bin/google-chrome",
    "/usr/local/bin/ogb-chromium",
];
export function findChrome() {
    return [process.env.BROWSER_USE_CHROME, ...PLACES].find((path) => Boolean(path && existsSync(path)));
}
/**
 * Starts a Chrome of our own with a fresh profile and DevTools on a free loopback port. It belongs to whoever called this (the tool), not to a runner:
 * a runner that is killed in the middle of the agent's code leaves the browser and its tabs as they were.
 */
export async function launchChrome(options = {}) {
    const program = options.program ?? findChrome();
    if (!program)
        throw new Error("No Chrome or Chromium found: set BROWSER_USE_CHROME to its program, or give a DevTools address (BROWSER_USE_CDP).");
    const profile = mkdtempSync(join(tmpdir(), "browser-use-profile-"));
    const child = spawn(program, [
        "--remote-debugging-port=0",
        "--remote-debugging-address=127.0.0.1",
        `--user-data-dir=${profile}`,
        "--no-first-run",
        "--no-default-browser-check",
        "--disable-background-networking",
        "--disable-component-update",
        "--password-store=basic",
        "--use-mock-keychain",
        ...(options.headless === false ? [] : ["--headless=new"]),
        "about:blank",
    ], { stdio: ["ignore", "ignore", "pipe"] });
    const cdpUrl = await new Promise((resolve, reject) => {
        let seen = "";
        const timer = setTimeout(() => reject(new Error(`Chrome did not open DevTools within 20 s: ${seen.slice(-500)}`)), 20_000);
        child.stderr.on("data", (chunk) => {
            seen += chunk.toString();
            const match = /DevTools listening on (ws:\/\/\S+)/.exec(seen);
            if (match?.[1]) {
                clearTimeout(timer);
                resolve(match[1]);
            }
        });
        child.once("exit", (code) => {
            clearTimeout(timer);
            reject(new Error(`Chrome ended before it was ready (exit ${code}): ${seen.slice(-500)}`));
        });
    }).catch((error) => {
        child.kill("SIGKILL");
        rmSync(profile, { recursive: true, force: true });
        throw error;
    });
    child.stderr.resume();
    return {
        cdpUrl,
        async close() {
            if (child.exitCode === null) {
                const ended = new Promise((resolve) => child.once("exit", resolve));
                child.kill("SIGTERM");
                await Promise.race([ended, new Promise((resolve) => setTimeout(resolve, 5000))]);
                if (child.exitCode === null)
                    child.kill("SIGKILL");
            }
            rmSync(profile, { recursive: true, force: true });
        },
    };
}
