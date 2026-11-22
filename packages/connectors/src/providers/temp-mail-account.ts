import { randomBytes } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { OgbError } from "@standin/contracts";
import type { Provider } from "../types.ts";
import { createTempMailAddresses, createTempMailProvider, type ReadState, type TempMailSite } from "./temp-mail.ts";

export interface TempMailAccountOptions {
  /** A private directory of the owner of the address (a plugin's data directory): `account.json` (mode 600) and `read.json` live in it. */
  directory: string;
  /** The mailbox name wanted when the address is first made (`<name>@<domain>`). */
  name: string;
  site: TempMailSite;
  domain: string;
  /** Needed only the first time, to make the address. */
  adminPassword: () => Promise<string>;
  pollMs?: number | undefined;
}

interface Stored {
  address: string;
  token: string;
}

function writePrivate(path: string, value: unknown): void {
  const temporary = `${path}.tmp`;
  writeFileSync(temporary, `${JSON.stringify(value)}\n`, { mode: 0o600 });
  chmodSync(temporary, 0o600);
  renameSync(temporary, path);
}

function fileReadState(path: string): ReadState {
  let ids: Set<string> | undefined;
  const load = () => {
    if (ids) return ids;
    try {
      ids = new Set(JSON.parse(readFileSync(path, "utf8")) as string[]);
    } catch {
      ids = new Set();
    }
    return ids;
  };
  return {
    has: (id) => load().has(id),
    add(id) {
      const set = load();
      if (set.has(id)) return;
      set.add(id);
      writePrivate(path, [...set].slice(-5000));
    },
  };
}

/**
 * The address that belongs to one owner (a bot, the mail channel): made once on the deployment, then kept in the owner's private
 * directory and reused after every restart. The token never leaves that file and this process.
 */
export async function openTempMailAccount(options: TempMailAccountOptions): Promise<Provider> {
  mkdirSync(options.directory, { recursive: true, mode: 0o700 });
  const file = join(options.directory, "account.json");
  let stored: Stored | undefined;
  if (existsSync(file)) {
    try {
      stored = JSON.parse(readFileSync(file, "utf8")) as Stored;
    } catch (cause) {
      throw new OgbError("invalid_input", `${file} is not readable account data; remove it to make a new address`, { cause });
    }
  } else {
    const addresses = createTempMailAddresses({ ...options.site, adminPassword: await options.adminPassword(), domain: options.domain });
    let made: { address: string; credential: string };
    try {
      made = await addresses.create(options.name);
    } catch (error) {
      // The name may be taken (another box, an older install): one more try with a short random suffix.
      made = await addresses.create(`${options.name}-${randomBytes(2).toString("hex")}`).catch(() => Promise.reject(error));
    }
    stored = { address: made.address, token: made.credential };
    writePrivate(file, stored);
  }
  if (typeof stored?.address !== "string" || typeof stored.token !== "string") throw new OgbError("invalid_input", `${file} has no address or token`);
  return createTempMailProvider({
    ...options.site,
    address: stored.address,
    token: stored.token,
    readState: fileReadState(join(options.directory, "read.json")),
    pollMs: options.pollMs,
  });
}

/** The environment names of a temp-mail deployment; the two secrets are taken out of the environment by the app and resolved by reference. */
export const TEMP_MAIL_VARIABLES = {
  url: "OGB_TEMP_MAIL_URL",
  domain: "OGB_TEMP_MAIL_DOMAIN",
  admin: "OGB_TEMP_MAIL_ADMIN",
  sitePassword: "OGB_TEMP_MAIL_SITE_PASSWORD",
} as const;

/** The deployment named by the environment, or undefined when none is set (then the plugin and the mail channel are off). */
export function tempMailSettings(env: Readonly<Record<string, string | undefined>>): { baseUrl: string; domain: string } | undefined {
  const baseUrl = env[TEMP_MAIL_VARIABLES.url]?.trim();
  const domain = env[TEMP_MAIL_VARIABLES.domain]?.trim();
  if (!baseUrl || !domain) return undefined;
  if (!/^https?:\/\/[^\s/]+/.test(baseUrl)) throw new OgbError("invalid_input", `${TEMP_MAIL_VARIABLES.url} must be an http(s) address`);
  return { baseUrl, domain };
}
