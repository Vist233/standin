import type { Envelope, MailStore, MailTransport } from "../src/provider.ts";

/** An IMAP account in memory, with server-side search by one word, sender or unseen: the test double of src/imap.ts. */
export function createMemoryImap(options: { gmail?: boolean } = {}) {
  const folders = new Map<string, (Envelope & { text: string })[]>([
    ["INBOX", []],
    ["[Gmail]/Sent Mail", []],
  ]);
  let uid = 0;
  let clock = Date.now();
  const tick = () => (clock = Math.max(clock + 1, Date.now()));
  const sentPath = "[Gmail]/Sent Mail";
  const store: MailStore = {
    folders: async () => ({ inbox: "INBOX", sent: sentPath }),
    newest: async (path, count) => [...(folders.get(path) ?? [])].sort((a, b) => b.uid - a.uid).slice(0, count),
    search: async (path, query) =>
      (folders.get(path) ?? [])
        .filter((m) => (query.text ? `${m.subject} ${m.from} ${m.text}`.toLowerCase().includes(query.text.toLowerCase()) : true))
        .filter((m) => (query.from ? m.from.toLowerCase().includes(query.from.toLowerCase()) : true))
        .filter((m) => (query.unseen ? !m.seen : true))
        .map((m) => m.uid),
    envelopes: async (path, uids) => (folders.get(path) ?? []).filter((m) => uids.includes(m.uid)),
    body: async (path, id) => {
      const m = (folders.get(path) ?? []).find((x) => x.uid === id);
      return m ? { envelope: m, text: m.text } : undefined;
    },
    markSeen: async (path, id) => {
      const m = (folders.get(path) ?? []).find((x) => x.uid === id);
      if (m) m.seen = true;
    },
    append: async (path, raw) => {
      const text = raw.toString();
      const header = (name: string) => new RegExp(`^${name}: (.*)$`, "m").exec(text)?.[1] ?? "";
      folders.get(path)?.push({
        uid: ++uid,
        from: header("From"),
        to: header("To").split(", ").filter(Boolean),
        cc: [],
        subject: header("Subject"),
        date: tick(),
        seen: true,
        text: text.split("\n\n").slice(1).join("\n\n"),
      });
    },
    close: async () => undefined,
  };
  const transport: MailTransport = {
    async send(message) {
      const raw = Buffer.from(`From: ${message.from}\nTo: ${message.to.join(", ")}\nSubject: ${message.subject}\n\n${message.text}`);
      // Gmail files the sent copy itself; other servers leave it to the client (the provider appends it).
      if (options.gmail)
        folders
          .get(sentPath)
          ?.push({ uid: ++uid, from: message.from, to: message.to, cc: message.cc, subject: message.subject, date: tick(), seen: true, text: message.text });
      return { raw };
    },
  };
  return {
    store,
    transport,
    deliver(mail: { from: string; subject: string; body: string }) {
      folders
        .get("INBOX")
        ?.push({ uid: ++uid, from: mail.from, to: ["me@gmail.test"], cc: [], subject: mail.subject, date: tick(), seen: false, text: mail.body });
    },
  };
}
