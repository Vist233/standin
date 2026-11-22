import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { OgbError } from "@vesper/contracts";

/**
 * Signing in to a Microsoft account (Outlook.com, Microsoft 365) as a public client with the device code: no client secret, no redirect
 * address; the person opens a page, types a short code and signs in. Then refresh tokens, which Microsoft replaces on every use, so the
 * newest one is written back each time.
 */
export interface MicrosoftApp {
  /** The application (client) id of the owner's app registration (public client, personal accounts allowed). Not a secret. */
  clientId: string;
  /** `consumers` for Outlook.com, `organizations` or a tenant id for work accounts, `common` for both (default). */
  tenant?: string | undefined;
  scopes: readonly string[];
  fetch?: typeof fetch | undefined;
  /** Default: Microsoft's login address. Tests pass a stand-in. */
  authority?: string | undefined;
}

export interface DeviceLogin {
  /** What to tell the person: the page and the code. */
  verificationUri: string;
  userCode: string;
  expiresInSeconds: number;
  /** Resolves with the tokens once the person signed in; rejects when they declined or the code expired. */
  done: Promise<TokenSet>;
}

export interface TokenSet {
  accessToken: string;
  refreshToken: string;
  /** Milliseconds since the epoch. */
  expiresAt: number;
}

function endpoint(app: MicrosoftApp, path: "devicecode" | "token"): string {
  const authority = (app.authority ?? "https://login.microsoftonline.com").replace(/\/+$/, "");
  return `${authority}/${app.tenant ?? "common"}/oauth2/v2.0/${path}`;
}

async function post(app: MicrosoftApp, path: "devicecode" | "token", form: Record<string, string>): Promise<{ status: number; body: Record<string, unknown> }> {
  const response = await (app.fetch ?? fetch)(endpoint(app, path), {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ client_id: app.clientId, ...form }).toString(),
  });
  let body: Record<string, unknown> = {};
  try {
    body = (await response.json()) as Record<string, unknown>;
  } catch {}
  return { status: response.status, body };
}

function tokens(body: Record<string, unknown>, now: number): TokenSet {
  if (typeof body.access_token !== "string" || typeof body.refresh_token !== "string")
    throw new OgbError("unavailable", "Microsoft gave no access or refresh token (is offline_access among the scopes?)");
  return { accessToken: body.access_token, refreshToken: body.refresh_token, expiresAt: now + Number(body.expires_in ?? 3600) * 1000 };
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** Starts a device-code sign-in. `now` and `wait` are for tests. */
export async function startDeviceLogin(app: MicrosoftApp, clock: { now?: () => number; wait?: (ms: number) => Promise<unknown> } = {}): Promise<DeviceLogin> {
  const now = clock.now ?? Date.now;
  const wait = clock.wait ?? sleep;
  const started = await post(app, "devicecode", { scope: app.scopes.join(" ") });
  const body = started.body;
  if (started.status !== 200 || typeof body.device_code !== "string" || typeof body.user_code !== "string")
    throw new OgbError("unavailable", `Microsoft refused to start a sign-in: ${String(body.error_description ?? body.error ?? started.status).slice(0, 300)}`);
  const deviceCode = body.device_code;
  const expiresIn = Number(body.expires_in ?? 900);
  let interval = Number(body.interval ?? 5) * 1000;
  const deadline = now() + expiresIn * 1000;
  const done = (async () => {
    while (now() < deadline) {
      await wait(interval);
      const answer = await post(app, "token", { grant_type: "urn:ietf:params:oauth:grant-type:device_code", device_code: deviceCode });
      if (answer.status === 200) return tokens(answer.body, now());
      const error = String(answer.body.error ?? "");
      if (error === "authorization_pending") continue;
      if (error === "slow_down") {
        interval += 5000;
        continue;
      }
      if (error === "authorization_declined") throw new OgbError("denied", "the person declined the sign-in");
      if (error === "expired_token") break;
      throw new OgbError("unavailable", `the sign-in failed: ${String(answer.body.error_description ?? error).slice(0, 300)}`);
    }
    throw new OgbError("unavailable", "the sign-in code expired before the person signed in; start a new sign-in");
  })();
  done.catch(() => undefined); // the caller may not wait for it; its failure is read where it is awaited
  return { verificationUri: String(body.verification_uri ?? "https://microsoft.com/devicelogin"), userCode: body.user_code, expiresInSeconds: expiresIn, done };
}

/**
 * Keeps an account's tokens in one private file (mode 600): hands out a valid access token, refreshing a minute before it expires and
 * writing the new refresh token back (Microsoft replaces it on every use).
 */
export function createTokenKeeper(app: MicrosoftApp, file: string, now: () => number = Date.now) {
  let current: TokenSet | undefined;
  let refreshing: Promise<TokenSet> | undefined;
  const save = (set: TokenSet) => {
    mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
    writeFileSync(`${file}.tmp`, `${JSON.stringify(set)}\n`, { mode: 0o600 });
    chmodSync(`${file}.tmp`, 0o600);
    renameSync(`${file}.tmp`, file);
    current = set;
  };
  const load = (): TokenSet | undefined => {
    if (current) return current;
    if (!existsSync(file)) return undefined;
    try {
      current = JSON.parse(readFileSync(file, "utf8")) as TokenSet;
    } catch {
      return undefined;
    }
    return current;
  };
  return {
    /** Whether this file holds a signed-in account. */
    connected: () => load() !== undefined,
    save,
    async accessToken(): Promise<string> {
      const set = load();
      if (!set) throw new OgbError("unavailable", "the account is not signed in yet");
      if (set.expiresAt - 60_000 > now()) return set.accessToken;
      refreshing ??= (async () => {
        const answer = await post(app, "token", { grant_type: "refresh_token", refresh_token: set.refreshToken, scope: app.scopes.join(" ") });
        if (answer.status !== 200)
          throw new OgbError("denied", `the sign-in is no longer valid (${String(answer.body.error ?? answer.status)}); sign in again`);
        const fresh = tokens(answer.body, now());
        save(fresh);
        return fresh;
      })().finally(() => {
        refreshing = undefined;
      });
      return (await refreshing).accessToken;
    },
  };
}

export type TokenKeeper = ReturnType<typeof createTokenKeeper>;
