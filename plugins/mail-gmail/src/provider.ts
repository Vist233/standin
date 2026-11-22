import type { MailMessage, MailQuery, MailSummary, Provider, Stop } from "@vesper/connectors";
import { OgbError } from "@vesper/contracts";

/** One message's header data, as an IMAP server gives it. */
export interface Envelope {
  uid: number;
  from: string;
  to: string[];
  cc: string[];
  subject: string;
  /** Milliseconds since the epoch (the server's arrival time). */
  date: number;
  seen: boolean;
}

/**
 * What the provider needs of an IMAP account (imap.ts implements it with imapflow; the tests with memory). Folders are paths on the
 * server; uids are the server's.
 */
export interface MailStore {
  folders(): Promise<{ inbox: string; sent: string }>;
  /** Newest first, at most `count`. */
  newest(folder: string, count: number): Promise<Envelope[]>;
  /** The server's search; `text` is one word (the provider asks once per word). */
  search(folder: string, query: { text?: string; from?: string; unseen?: boolean }): Promise<number[]>;
  envelopes(folder: string, uids: number[]): Promise<Envelope[]>;
  /** The plain text of a message, or undefined when there is no such uid. */
  body(folder: string, uid: number): Promise<{ envelope: Envelope; text: string } | undefined>;
  markSeen(folder: string, uid: number): Promise<void>;
  append(folder: string, raw: Buffer): Promise<void>;
  close(): Promise<void>;
}

/** Sends through SMTP; returns the message as sent, to keep a copy. */
export interface MailTransport {
  send(message: { from: string; to: string[]; cc: string[]; subject: string; text: string }): Promise<{ raw: Buffer }>;
}

export interface ImapProviderOptions {
  store: MailStore;
  transport: MailTransport;
  address: string;
  /** Put a copy of sent mail in the sent folder. Gmail does it by itself (false); most servers do not (true). */
  appendSent: boolean;
  pollMs?: number;
  /** For tests: how long to wait between looks for the sent copy. */
  retryMs?: number;
}

const KEYS = ["inbox", "sent"] as const;
type Key = (typeof KEYS)[number];
const SEARCHED = 200;

/** A mailbox over IMAP and SMTP: Gmail with an app password, or any standard server. */
export function createImapProvider(options: ImapProviderOptions): Provider {
  const { store } = options;
  let paths: Promise<{ inbox: string; sent: string }> | undefined;
  const pathOf = async (key: Key) => {
    paths ??= store.folders();
    paths.catch(() => {
      paths = undefined;
    });
    return (await paths)[key];
  };

  const toMail = (key: Key, e: Envelope, body = ""): MailMessage => ({
    id: `${key}-${e.uid}`,
    folder: key,
    from: key === "sent" ? options.address : e.from,
    to: e.to,
    cc: e.cc,
    subject: e.subject,
    body,
    date: e.date,
    unread: key === "inbox" && !e.seen,
  });
  const summary = ({ id, folder, from, subject, date, unread }: MailMessage): MailSummary => ({ id, folder, from, subject, date, unread });

  async function find(key: Key, query: MailQuery): Promise<Envelope[]> {
    const path = await pathOf(key);
    const words = (query.text ?? "").split(/\s+/).filter(Boolean);
    if (words.length === 0 && query.from === undefined && !query.unreadOnly) return store.newest(path, query.limit ?? 20);
    // Every condition is one server search; a message must be in all of them (the words are AND, as in the other providers).
    const searches: Promise<number[]>[] = words.map((text) => store.search(path, { text }));
    if (query.from !== undefined) searches.push(store.search(path, { from: query.from }));
    if (query.unreadOnly) searches.push(store.search(path, { unseen: true }));
    const [first = [], ...rest] = await Promise.all(searches);
    const uids = first.filter((uid) => rest.every((list) => list.includes(uid)));
    return store.envelopes(path, uids.sort((a, b) => b - a).slice(0, SEARCHED));
  }

  const parse = (id: string): { key: Key; uid: number } => {
    const match = /^(inbox|sent)-(\d{1,12})$/.exec(id);
    if (!match) throw new OgbError("not_found", `no mail '${id}'`);
    return { key: match[1] as Key, uid: Number(match[2]) };
  };

  return {
    address: options.address,
    mail: {
      reader: {
        async list(query) {
          const key = (query.folder ?? "inbox") as Key;
          if (!KEYS.includes(key)) return [];
          const found = (await find(key, query)).map((e) => toMail(key, e));
          found.sort((a, b) => b.date - a.date);
          return found.slice(0, query.limit ?? 20).map(summary);
        },
        async read(id) {
          const { key, uid } = parse(id);
          const path = await pathOf(key);
          const message = await store.body(path, uid);
          if (!message) throw new OgbError("not_found", `no mail '${id}'`);
          if (key === "inbox" && !message.envelope.seen) await store.markSeen(path, uid);
          return { ...toMail(key, message.envelope, message.text), unread: false };
        },
        watch(onMail, watchOptions): Stop {
          let stopped = false;
          let seen: Set<number> | undefined;
          let timer: NodeJS.Timeout | undefined;
          // The cursor is the highest uid reported. Without one, decided by arrival time: the first look may come after the mail.
          const after = watchOptions?.after !== undefined && /^\d+$/.test(watchOptions.after) ? Number(watchOptions.after) : undefined;
          const began = Date.now();
          let highest = after ?? 0;
          const look = async () => {
            const rows = await store.newest(await pathOf("inbox"), 50);
            if (!seen) {
              seen = new Set(rows.filter((e) => (after !== undefined ? e.uid <= after : e.date < began)).map((e) => e.uid));
              highest = Math.max(highest, ...[...seen]);
              watchOptions?.onCursor?.(String(highest));
            }
            for (const e of rows.filter((row) => !seen?.has(row.uid)).sort((a, b) => a.uid - b.uid)) {
              seen.add(e.uid);
              if (stopped) return;
              onMail(summary(toMail("inbox", e)));
              highest = Math.max(highest, e.uid);
              watchOptions?.onCursor?.(String(highest));
            }
          };
          const loop = () => {
            if (stopped) return;
            look()
              .catch(() => undefined) // tried again at the next tick
              .finally(() => {
                if (!stopped) timer = setTimeout(loop, options.pollMs ?? 30_000);
              });
          };
          loop();
          return () => {
            stopped = true;
            if (timer) clearTimeout(timer);
          };
        },
      },
      sender: {
        async send(draft) {
          const sentPath = await pathOf("sent");
          const before = new Set((await store.newest(sentPath, 10)).map((e) => e.uid));
          const { raw } = await options.transport.send({ from: options.address, to: draft.to, cc: draft.cc ?? [], subject: draft.subject, text: draft.body });
          if (options.appendSent) await store.append(sentPath, raw);
          // The sent copy's id: the newest new message in the sent folder with this subject (Gmail files it a moment later).
          for (let attempt = 0; attempt < 20; attempt += 1) {
            const copy = (await store.newest(sentPath, 10)).find((e) => !before.has(e.uid) && e.subject === draft.subject);
            if (copy) return { id: `sent-${copy.uid}` };
            await new Promise((resolve) => setTimeout(resolve, options.retryMs ?? 500));
          }
          throw new OgbError("unavailable", "the mail was sent, but its copy did not appear in the sent folder");
        },
      },
    },
  };
}
