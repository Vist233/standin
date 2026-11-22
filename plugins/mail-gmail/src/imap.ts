import { type FetchMessageObject, ImapFlow } from "imapflow";
import { simpleParser } from "mailparser";
import nodemailer from "nodemailer";
import type { Envelope, MailStore, MailTransport } from "./provider.ts";

export interface ServerAccount {
  host: string;
  port: number;
  user: string;
  /** An app password (Gmail: made under the Google account's security page, needs 2-step verification). */
  pass: string;
}

type Address = { name?: string | undefined; address?: string | undefined };
const one = (a: Address | undefined) => (a?.name && a.address ? `${a.name} <${a.address}>` : (a?.address ?? ""));
const many = (list: Address[] | undefined) => (list ?? []).map((a) => a.address ?? "").filter(Boolean);

/** IMAP through imapflow: one connection, opened on first use and again after it drops; every call holds the folder's lock. */
export function createImapStore(account: ServerAccount): MailStore {
  let client: ImapFlow | undefined;
  let connecting: Promise<ImapFlow> | undefined;

  async function connection(): Promise<ImapFlow> {
    if (client?.usable) return client;
    connecting ??= (async () => {
      const made = new ImapFlow({ host: account.host, port: account.port, secure: true, auth: { user: account.user, pass: account.pass }, logger: false });
      made.on("error", () => undefined); // a dropped connection is reopened at the next call
      await made.connect();
      client = made;
      return made;
    })().finally(() => {
      connecting = undefined;
    });
    return connecting;
  }

  async function inFolder<T>(path: string, work: (c: ImapFlow) => Promise<T>): Promise<T> {
    const c = await connection();
    const lock = await c.getMailboxLock(path);
    try {
      return await work(c);
    } finally {
      lock.release();
    }
  }

  const envelopeOf = (m: FetchMessageObject): Envelope => ({
    uid: m.uid,
    from: one(m.envelope?.from?.[0]),
    to: many(m.envelope?.to),
    cc: many(m.envelope?.cc),
    subject: m.envelope?.subject ?? "",
    date: m.internalDate ? new Date(m.internalDate).getTime() : 0,
    seen: m.flags?.has("\\Seen") ?? false,
  });
  const QUERY = { uid: true, envelope: true, flags: true, internalDate: true } as const;

  return {
    async folders() {
      const c = await connection();
      const list = await c.list();
      const sent = list.find((f) => f.specialUse === "\\Sent")?.path ?? "Sent";
      return { inbox: "INBOX", sent };
    },
    newest: (path, count) =>
      inFolder(path, async (c) => {
        const total = typeof c.mailbox === "object" && c.mailbox ? c.mailbox.exists : 0;
        if (total === 0) return [];
        const from = Math.max(1, total - count + 1);
        const rows = await c.fetchAll(`${from}:*`, QUERY);
        return rows.map(envelopeOf).sort((a, b) => b.uid - a.uid);
      }),
    search: (path, query) =>
      inFolder(path, async (c) => {
        const found = await c.search(
          { ...(query.text ? { text: query.text } : {}), ...(query.from ? { from: query.from } : {}), ...(query.unseen ? { seen: false } : {}) },
          { uid: true },
        );
        return Array.isArray(found) ? found : [];
      }),
    envelopes: (path, uids) =>
      uids.length === 0 ? Promise.resolve([]) : inFolder(path, async (c) => (await c.fetchAll(uids.join(","), QUERY, { uid: true })).map(envelopeOf)),
    body: (path, uid) =>
      inFolder(path, async (c) => {
        const message = await c.fetchOne(String(uid), { ...QUERY, source: true }, { uid: true });
        if (!message || !message.source) return undefined;
        const parsed = await simpleParser(message.source);
        const text = parsed.text ?? (typeof parsed.html === "string" ? parsed.html.replace(/<[^>]+>/g, "") : "");
        return { envelope: envelopeOf(message), text };
      }),
    markSeen: (path, uid) =>
      inFolder(path, async (c) => {
        await c.messageFlagsAdd(String(uid), ["\\Seen"], { uid: true });
      }),
    async append(path, raw) {
      const c = await connection();
      await c.append(path, raw, ["\\Seen"]);
    },
    async close() {
      await client?.logout().catch(() => undefined);
      client = undefined;
    },
  };
}

/** SMTP through nodemailer over TLS; the message is built first, so the same bytes can be kept as the sent copy. */
export function createSmtpTransport(account: ServerAccount): MailTransport {
  const smtp = nodemailer.createTransport({
    host: account.host,
    port: account.port,
    secure: account.port === 465,
    auth: { user: account.user, pass: account.pass },
  });
  const builder = nodemailer.createTransport({ streamTransport: true, buffer: true, newline: "unix" });
  return {
    async send(message) {
      const mail = { from: message.from, to: message.to, cc: message.cc, subject: message.subject, text: message.text };
      const built = (await builder.sendMail(mail)) as unknown as { message: Buffer };
      await smtp.sendMail({ envelope: { from: message.from, to: [...message.to, ...message.cc] }, raw: built.message });
      return { raw: built.message };
    },
  };
}
