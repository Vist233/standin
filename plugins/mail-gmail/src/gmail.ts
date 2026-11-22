import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { MailReader, MailSender, Provider, Stop } from "@vesper/connectors";
import { OgbError, type PluginContext } from "@vesper/contracts";
import { createImapProvider, type MailStore, type MailTransport } from "./provider.ts";

/** The environment names; the password is a secret the app takes out of the environment at start. */
export const GMAIL_VARIABLES = {
  address: "OGB_GMAIL_ADDRESS",
  appPasswordVariable: "OGB_GMAIL_APP_PASSWORD",
  imap: "OGB_GMAIL_IMAP_HOST",
  smtp: "OGB_GMAIL_SMTP_HOST",
} as const;

export interface Servers {
  imap: { host: string; port: number };
  smtp: { host: string; port: number };
  /** Gmail files sent mail by itself; other servers need a copy appended. */
  appendSent: boolean;
}

/** `host` or `host:port`; Gmail's by default. */
export function serversOf(env: Readonly<Record<string, string | undefined>>): Servers {
  const parse = (value: string | undefined, fallback: string, port: number) => {
    const [host = fallback, given] = (value?.trim() || fallback).split(":");
    return { host, port: given ? Number(given) : port };
  };
  const imap = parse(env[GMAIL_VARIABLES.imap], "imap.gmail.com", 993);
  return { imap, smtp: parse(env[GMAIL_VARIABLES.smtp], "smtp.gmail.com", 465), appendSent: imap.host !== "imap.gmail.com" };
}

export interface GmailOptions {
  env?: Readonly<Record<string, string | undefined>>;
  /** Builds the server connections (default: imapflow and nodemailer, loaded only here). Tests pass memory ones. */
  connect?: (account: { address: string; password: string; servers: Servers }) => Promise<{ store: MailStore; transport: MailTransport }>;
  pollMs?: number;
}

async function realServers(account: { address: string; password: string; servers: Servers }) {
  const { createImapStore, createSmtpTransport } = await import("./imap.ts"); // the libraries are loaded only for a configured account
  return {
    store: createImapStore({ ...account.servers.imap, user: account.address, pass: account.password }),
    transport: createSmtpTransport({ ...account.servers.smtp, user: account.address, pass: account.password }),
  };
}

/**
 * The person's Gmail as one bot's: the bot that the person let claim it (`gmail_connect`, approved by the person). The name of that bot
 * is kept in the plugin's shared directory; the app password stays a secret of the app.
 */
export function createGmail(ctx: PluginContext, options: GmailOptions = {}) {
  const env = options.env ?? process.env;
  const address = env[GMAIL_VARIABLES.address]?.trim();
  mkdirSync(ctx.sharedDataDir, { recursive: true, mode: 0o700 });
  const ownerFile = join(ctx.sharedDataDir, "owner.json");
  const me = ctx.workspace.workspaceId;
  let opened: Promise<Provider> | undefined;

  const owner = (): string | undefined => {
    if (!existsSync(ownerFile)) return undefined;
    try {
      return (JSON.parse(readFileSync(ownerFile, "utf8")) as { workspaceId?: string }).workspaceId;
    } catch {
      return undefined;
    }
  };

  async function openMailbox(): Promise<Provider> {
    if (!address) throw new OgbError("unavailable", `Gmail is not set up on this box (${GMAIL_VARIABLES.address})`);
    opened ??= (async () => {
      const password = await ctx.secrets.resolve(`env:${GMAIL_VARIABLES.appPasswordVariable}`);
      const servers = serversOf(env);
      const { store, transport } = await (options.connect ?? realServers)({ address, password, servers });
      return createImapProvider({ store, transport, address, appendSent: servers.appendSent, ...(options.pollMs ? { pollMs: options.pollMs } : {}) });
    })();
    opened.catch(() => {
      opened = undefined;
    });
    return opened;
  }

  async function open(): Promise<Provider> {
    const holder = owner();
    if (holder === undefined) throw new OgbError("unavailable", "the person's Gmail is not connected to you: call gmail_connect (the person approves it)");
    if (holder !== me) throw new OgbError("denied", "the person's Gmail belongs to another bot; ask the person");
    return openMailbox();
  }
  const reader = async () => (await open()).mail?.reader as MailReader;
  const sender = async () => (await open()).mail?.sender as MailSender;

  const provider: Provider = {
    ...(address ? { address } : {}),
    mail: {
      reader: {
        list: async (query) => (await reader()).list(query),
        read: async (id) => (await reader()).read(id),
        watch(onMail, watchOptions): Stop {
          let stopped = false;
          let inner: Stop | undefined;
          let timer: NodeJS.Timeout | undefined;
          const tryStart = () => {
            if (stopped) return;
            if (owner() !== me) {
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

  /** Claims the account for this bot after checking that the login works. The person approves the call (manifest approval). */
  async function connect(): Promise<string> {
    if (!address)
      return `Gmail is not set up on this box: the owner must set ${GMAIL_VARIABLES.address} and the secret ${GMAIL_VARIABLES.appPasswordVariable} (an app password).`;
    const holder = owner();
    if (holder !== undefined && holder !== me) return "The person's Gmail already belongs to another bot. Only one bot holds it; ask the person.";
    const mailbox = await openMailbox();
    await mailbox.mail?.reader?.list({ limit: 1 }); // the login and the folders work
    if (holder === undefined) writeFileSync(ownerFile, `${JSON.stringify({ workspaceId: me, at: new Date().toISOString() })}\n`, { mode: 0o600 });
    return `Gmail is connected: ${address}.`;
  }

  return { provider, connect };
}
