import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import type { PluginLogger } from "@standin/contracts";
import { getJson, openSession } from "./cdp.ts";

/** The cookie fields that are copied between browsers (what DevTools' Storage.getCookies returns and setCookies takes). */
export interface Cookie {
  name: string;
  value: string;
  domain: string;
  path: string;
  /** Seconds since the epoch; -1 or absent for a session cookie. */
  expires?: number;
  httpOnly?: boolean;
  secure?: boolean;
  sameSite?: string;
}

/** One running browser as the sync sees it. */
export interface CookieBrowser {
  readonly id: string;
  read(): Promise<Cookie[]>;
  write(set: readonly Cookie[], remove: readonly Cookie[]): Promise<void>;
}

const keyOf = (c: Cookie) => `${c.name}\u0000${c.domain}\u0000${c.path}`;
const printOf = (c: Cookie) => JSON.stringify([c.value, c.expires ?? -1, c.httpOnly ?? false, c.secure ?? false, c.sameSite ?? ""]);
const clean = (c: Cookie): Cookie => ({
  name: c.name,
  value: c.value,
  domain: c.domain,
  path: c.path,
  ...(typeof c.expires === "number" && c.expires > 0 ? { expires: c.expires } : {}),
  ...(c.httpOnly ? { httpOnly: true } : {}),
  ...(c.secure ? { secure: true } : {}),
  ...(c.sameSite ? { sameSite: c.sameSite } : {}),
});

/**
 * One set of logins for every session of the box (the owner's requirement: the person signs in once). Each workspace keeps
 * its own browser and profile, because one profile cannot be open in two Chromium processes; this class keeps their cookies
 * equal instead. Each round it reads every running browser, takes what one of them changed since the last round into the
 * shared jar (a new login, a refreshed token, a sign-out), and writes the jar back into all of them. A browser seen for the
 * first time takes the jar as it is and adds only cookies the jar does not have, so an old profile cannot undo a newer login.
 * The jar is a file of the daemon, readable by root only; values are never logged. localStorage is not shared.
 */
export class SharedLogins {
  private readonly jar = new Map<string, Cookie>();
  /** Per browser: the fingerprints it held after the last round. */
  private readonly seen = new Map<string, Map<string, string>>();
  private readonly file: string;
  private readonly log: PluginLogger;
  private readonly now: () => number;
  private running: Promise<void> | null = null;

  constructor(file: string, log: PluginLogger, now: () => number = Date.now) {
    this.file = file;
    this.log = log;
    this.now = now;
    try {
      const stored: unknown = JSON.parse(readFileSync(file, "utf8"));
      if (Array.isArray(stored)) for (const c of stored as Cookie[]) if (typeof c?.name === "string") this.jar.set(keyOf(c), clean(c));
    } catch {
      // no jar yet
    }
  }

  /** How many cookies the jar holds (tests and the start-up log). */
  get size(): number {
    return this.jar.size;
  }

  /** One round over the browsers that run now; a round already going is joined, not doubled. Failures are logged, never thrown. */
  sync(browsers: readonly CookieBrowser[]): Promise<void> {
    this.running ??= this.round(browsers).finally(() => {
      this.running = null;
    });
    return this.running;
  }

  private async round(browsers: readonly CookieBrowser[]): Promise<void> {
    for (const id of this.seen.keys()) if (!browsers.some((b) => b.id === id)) this.seen.delete(id); // stopped: first sight again
    const reads: { browser: CookieBrowser; cookies: Map<string, Cookie> }[] = [];
    for (const browser of browsers) {
      try {
        const cookies = new Map((await browser.read()).map((c) => [keyOf(c), clean(c)] as const));
        reads.push({ browser, cookies });
      } catch (error) {
        this.log.warn("could not read a browser's cookies", { workspace: browser.id, error: String(error) });
      }
    }
    let changed = false;
    for (const { browser, cookies } of reads) {
      const before = this.seen.get(browser.id);
      for (const [key, cookie] of cookies) {
        if (before ? before.get(key) !== printOf(cookie) : !this.jar.has(key)) {
          this.jar.set(key, cookie);
          changed = true;
        }
      }
      if (!before) continue;
      for (const [key, print] of before) {
        const held = this.jar.get(key);
        if (!cookies.has(key) && held && printOf(held) === print) {
          this.jar.delete(key); // this browser dropped it (a sign-out) and nobody changed it since
          changed = true;
        }
      }
    }
    const nowSeconds = this.now() / 1000;
    for (const [key, cookie] of this.jar)
      if (cookie.expires !== undefined && cookie.expires < nowSeconds) {
        this.jar.delete(key);
        changed = true;
      }
    if (changed) this.save();
    for (const { browser, cookies } of reads) {
      const set = [...this.jar].filter(([key, c]) => cookies.get(key) === undefined || printOf(cookies.get(key) as Cookie) !== printOf(c)).map(([, c]) => c);
      const remove = [...cookies].filter(([key]) => !this.jar.has(key)).map(([, c]) => c);
      try {
        if (set.length > 0 || remove.length > 0) await browser.write(set, remove);
        this.seen.set(browser.id, new Map([...this.jar].map(([key, c]) => [key, printOf(c)])));
      } catch (error) {
        this.seen.delete(browser.id);
        this.log.warn("could not write a browser's cookies", { workspace: browser.id, error: String(error) });
      }
    }
  }

  private save(): void {
    mkdirSync(dirname(this.file), { recursive: true, mode: 0o700 });
    const temp = `${this.file}.${process.pid}.tmp`;
    writeFileSync(temp, JSON.stringify([...this.jar.values()]), { mode: 0o600 });
    renameSync(temp, this.file);
  }
}

/** The browser of one workspace over DevTools (its browser-level target, which sees every cookie of the profile). */
export function devtoolsCookies(id: string, cdpPort: number): CookieBrowser {
  const session = async () => {
    const version = (await getJson(cdpPort, "/json/version")) as { webSocketDebuggerUrl?: unknown };
    if (typeof version?.webSocketDebuggerUrl !== "string") throw new Error("the browser did not name its DevTools target");
    return openSession(version.webSocketDebuggerUrl);
  };
  return {
    id,
    async read() {
      const s = await session();
      try {
        const answer = (await s.send("Storage.getCookies", {})) as { cookies?: (Cookie & { partitionKey?: unknown })[] };
        return (answer.cookies ?? []).filter((c) => c.partitionKey === undefined);
      } finally {
        s.close();
      }
    },
    async write(set, remove) {
      const s = await session();
      try {
        // A cookie that expired long ago is how DevTools deletes one at the browser level.
        const gone = remove.map((c) => ({ ...clean(c), value: "", expires: 1 }));
        await s.send("Storage.setCookies", { cookies: [...set, ...gone] });
      } finally {
        s.close();
      }
    },
  };
}
