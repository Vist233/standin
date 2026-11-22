import { OgbError } from "@standin/contracts";
import { getJson, openSession } from "./cdp.ts";

const MAX_PER_WINDOW = 5;
const WINDOW_MS = 1000;

interface PageTarget {
  readonly id: string;
  readonly url: string;
  readonly webSocketDebuggerUrl: string;
}

/**
 * Puts text into the focused editable element of a workspace's browser page through the Chrome DevTools Protocol
 * (`Input.insertText`). The keyboard path of the live view carries ASCII only; this carries any Unicode. It reaches
 * the page, not the browser's own chrome (address bar). The text is a secret (a password, a one-time code): it is
 * sent to the browser and nowhere else, never logged, never in an error message.
 */
export class TextInserter {
  private readonly cdpPort: number;
  private readonly now: () => number;
  private recent: number[] = [];

  constructor(cdpPort: number, now: () => number = Date.now) {
    this.cdpPort = cdpPort;
    this.now = now;
  }

  /** Returns how many characters were inserted. */
  async insert(text: string): Promise<number> {
    this.admit();
    const pages = await this.pages();
    if (pages.length === 0) throw new OgbError("unavailable", "the workspace's browser has no page to type into");
    const target = await this.focused(pages);
    const session = await openSession(target.webSocketDebuggerUrl);
    try {
      await session.send("Input.insertText", { text });
    } finally {
      session.close();
    }
    return [...text].length;
  }

  /** At most `MAX_PER_WINDOW` insertions per second: a runaway caller cannot flood the page. */
  private admit(): void {
    const now = this.now();
    this.recent = this.recent.filter((at) => now - at < WINDOW_MS);
    if (this.recent.length >= MAX_PER_WINDOW) throw new OgbError("unavailable", "too many text insertions; wait a moment");
    this.recent.push(now);
  }

  private async pages(): Promise<PageTarget[]> {
    const body = await getJson(this.cdpPort, "/json/list");
    if (!Array.isArray(body)) throw new OgbError("unavailable", "the browser's target list is not readable");
    return body.filter(
      (t): t is PageTarget =>
        typeof t === "object" && t !== null && t.type === "page" && typeof t.webSocketDebuggerUrl === "string" && typeof t.id === "string",
    );
  }

  /** The page that has focus, or the last page (the newest tab) when none says it has. */
  private async focused(pages: PageTarget[]): Promise<PageTarget> {
    for (const page of pages) {
      try {
        const session = await openSession(page.webSocketDebuggerUrl);
        try {
          const answer = (await session.send("Runtime.evaluate", { expression: "document.hasFocus()", returnByValue: true })) as {
            result?: { value?: unknown };
          };
          if (answer.result?.value === true) return page;
        } finally {
          session.close();
        }
      } catch {
        // a page that cannot be asked is not the focused one
      }
    }
    return pages[pages.length - 1] as PageTarget;
  }
}
