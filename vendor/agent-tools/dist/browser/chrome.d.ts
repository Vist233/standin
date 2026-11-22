export interface ChromeOptions {
    /** The Chrome or Chromium program. Default: BROWSER_USE_CHROME, else the usual places on macOS and Linux. */
    program?: string | undefined;
    headless?: boolean | undefined;
}
export interface LaunchedChrome {
    /** The DevTools address the runners attach to. */
    cdpUrl: string;
    close(): Promise<void>;
}
export declare function findChrome(): string | undefined;
/**
 * Starts a Chrome of our own with a fresh profile and DevTools on a free loopback port. It belongs to whoever called this (the tool), not to a runner:
 * a runner that is killed in the middle of the agent's code leaves the browser and its tabs as they were.
 */
export declare function launchChrome(options?: ChromeOptions): Promise<LaunchedChrome>;
