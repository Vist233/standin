import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  createTokenKeeper,
  type MailReader,
  type MailSender,
  type MicrosoftApp,
  openGraphMailbox,
  type Provider,
  startDeviceLogin,
  type Stop,
  type TokenKeeper,
} from "@vesper/connectors";
import { OgbError, type PluginContext } from "@vesper/contracts";

export const SCOPES = ["offline_access", "User.Read", "Mail.ReadWrite", "Mail.Send"];

export interface OutlookOptions {
  env?: Readonly<Record<string, string | undefined>>;
  /** For tests: Microsoft's sign-in and Graph stand-ins. */
  fetch?: typeof fetch;
  authority?: string;
  graphUrl?: string;
  pollMs?: number;
  wait?: (ms: number) => Promise<unknown>;
}

/**
 * The person's Outlook as one bot's. The tokens and the name of the bot that owns them live in the plugin's shared directory, so every
 * session sees the same account and only its owner may use it. Until someone signs in, the mail tools say how to connect.
 */
export function createOutlook(ctx: PluginContext, options: OutlookOptions = {}) {
  const env = options.env ?? process.env;
  const clientId = env.OGB_OUTLOOK_CLIENT_ID?.trim();
  const app: MicrosoftApp = {
    clientId: clientId ?? "",
    tenant: env.OGB_OUTLOOK_TENANT?.trim() || "common",
    scopes: SCOPES,
    fetch: options.fetch,
    authority: options.authority,
  };
  mkdirSync(ctx.sharedDataDir, { recursive: true, mode: 0o700 });
  const ownerFile = join(ctx.sharedDataDir, "owner.json");
  const keeper: TokenKeeper = createTokenKeeper(app, join(ctx.sharedDataDir, "tokens.json"));
  const me = ctx.workspace.workspaceId;
  let mailbox: Promise<Provider> | undefined;
  let signingIn: Promise<unknown> | undefined;

  const owner = (): string | undefined => {
    if (!existsSync(ownerFile)) return undefined;
    try {
      return (JSON.parse(readFileSync(ownerFile, "utf8")) as { workspaceId?: string }).workspaceId;
    } catch {
      return undefined;
    }
  };
  const mine = () => keeper.connected() && owner() === me;

  async function open(): Promise<Provider> {
    if (!clientId) throw new OgbError("unavailable", "Outlook is not set up on this box (OGB_OUTLOOK_CLIENT_ID)");
    const holder = owner();
    if (keeper.connected() && holder !== me) throw new OgbError("denied", "the person's Outlook belongs to another bot; ask the person");
    if (!keeper.connected()) throw new OgbError("unavailable", "Outlook is not connected yet: call outlook_connect and give the person the page and code");
    mailbox ??= openGraphMailbox({ accessToken: keeper.accessToken, fetch: options.fetch, baseUrl: options.graphUrl, pollMs: options.pollMs ?? 30_000 });
    mailbox.catch(() => {
      mailbox = undefined;
    });
    return mailbox;
  }
  const reader = async (): Promise<MailReader> => (await open()).mail?.reader as MailReader;
  const sender = async (): Promise<MailSender> => (await open()).mail?.sender as MailSender;

  /** The mail interfaces, usable from the start; each call opens the mailbox or says why it cannot. */
  const provider: Provider = {
    mail: {
      reader: {
        list: async (query) => (await reader()).list(query),
        read: async (id) => (await reader()).read(id),
        watch(onMail, watchOptions): Stop {
          // Waits until this bot holds a signed-in account, then watches it.
          let stopped = false;
          let inner: Stop | undefined;
          let timer: NodeJS.Timeout | undefined;
          const tryStart = () => {
            if (stopped) return;
            if (!mine()) {
              timer = setTimeout(tryStart, options.pollMs ?? 30_000);
              return;
            }
            reader()
              .then((r) => {
                if (!stopped) inner = r.watch(onMail, watchOptions);
              })
              .catch(() => {
                if (!stopped) timer = setTimeout(tryStart, options.pollMs ?? 30_000);
              });
          };
          tryStart();
          return () => {
            stopped = true;
            if (timer) clearTimeout(timer);
            inner?.();
          };
        },
      },
      sender: { send: async (draft) => (await sender()).send(draft) },
    },
  };

  /** Starts the sign-in; the agent passes the page and code to the person. When it is done, the bot is told by a signal. */
  async function connect(): Promise<string> {
    if (!clientId) return "Outlook is not set up on this box: the owner must set OGB_OUTLOOK_CLIENT_ID (an app registration, public client).";
    if (keeper.connected()) {
      if (owner() !== me) return "The person's Outlook already belongs to another bot. Only one bot holds it; ask the person.";
      const opened = await open();
      return `Outlook is connected: ${opened.address}.`;
    }
    if (signingIn) return "A sign-in is already waiting for the person. Ask them to finish it with the page and code given before.";
    const login = await startDeviceLogin(app, options.wait ? { wait: options.wait } : {});
    signingIn = login.done
      .then((tokens) => {
        if (keeper.connected() && owner() !== me) throw new OgbError("conflict", "another bot connected the person's Outlook first");
        writeFileSync(ownerFile, `${JSON.stringify({ workspaceId: me, at: new Date().toISOString() })}\n`, { mode: 0o600 });
        keeper.save(tokens);
        return open();
      })
      .then((opened) =>
        ctx.signals.emit("self", { id: `outlook-connected-${Date.now()}`, source: "plugin:mail-outlook", text: `Outlook connected: ${opened.address}` }),
      )
      .catch((error) => {
        ctx.log.warn("the Outlook sign-in did not finish", { error: String(error) });
        return ctx.signals.emit("self", {
          id: `outlook-failed-${Date.now()}`,
          source: "plugin:mail-outlook",
          text: `Outlook sign-in did not finish: ${(error as Error).message}`,
        });
      })
      .finally(() => {
        signingIn = undefined;
      });
    const minutes = Math.round(login.expiresInSeconds / 60);
    return `Ask the person to open ${login.verificationUri} and enter the code ${login.userCode} within ${minutes} minutes, then sign in with their Microsoft account. You will be told when it is connected.`;
  }

  return { provider, connect, connected: mine, waitForSignIn: () => signingIn };
}
