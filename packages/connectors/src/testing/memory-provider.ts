import { OgbError } from "@vesper/contracts";
import type { CalendarEvent, MailMessage, MailQuery, Provider, Stop } from "../types.ts";

export interface MemoryProvider extends Provider {
  /** Makes a mail arrive in the inbox (watchers are told). */
  deliver(mail: { from: string; subject: string; body: string; to?: string[]; date?: number }): MailMessage;
  /** Makes an event appear in the calendar from outside (watchers are told). */
  addExternalEvent(event: Omit<CalendarEvent, "id">): CalendarEvent;
  readonly sent: MailMessage[];
}

/** The reference provider: everything in memory. The tools' tests use it, and it must pass the contract suite like any provider. */
export function createMemoryProvider(options: { address?: string; now?: () => number; mail?: boolean; calendar?: boolean } = {}): MemoryProvider {
  const address = options.address ?? "bot@example.test";
  let clock = 1_000_000;
  const now = options.now ?? (() => (clock += 1000));
  const messages: MailMessage[] = [];
  const events = new Map<string, CalendarEvent>();
  const mailWatchers = new Set<(m: MailMessage) => void>();
  const eventWatchers = new Set<(e: CalendarEvent) => void>();
  let counter = 0;

  const matches = (m: MailMessage, q: MailQuery): boolean => {
    if (q.folder !== undefined && m.folder !== q.folder) return false;
    if (q.from !== undefined && !m.from.toLowerCase().includes(q.from.toLowerCase())) return false;
    if (q.unreadOnly && !m.unread) return false;
    if (q.text !== undefined) {
      const hay = `${m.subject} ${m.from} ${m.body}`.toLowerCase();
      if (
        !q.text
          .toLowerCase()
          .split(/\s+/)
          .filter(Boolean)
          .every((w) => hay.includes(w))
      )
        return false;
    }
    return true;
  };
  const summary = ({ id, folder, from, subject, date, unread }: MailMessage) => ({ id, folder, from, subject, date, unread });
  const withMail = options.mail !== false;
  const withCalendar = options.calendar !== false;

  const provider: MemoryProvider = {
    address,
    sent: [],
    deliver(mail) {
      const message: MailMessage = {
        id: `m${++counter}`,
        folder: "inbox",
        from: mail.from,
        to: mail.to ?? [address],
        cc: [],
        subject: mail.subject,
        body: mail.body,
        date: mail.date ?? now(),
        unread: true,
      };
      messages.push(message);
      for (const watcher of mailWatchers) watcher(message);
      return message;
    },
    addExternalEvent(event) {
      const created: CalendarEvent = { id: `e${++counter}`, ...event };
      events.set(created.id, created);
      for (const watcher of eventWatchers) watcher(created);
      return created;
    },
  };
  if (withMail) {
    provider.mail = {
      reader: {
        async list(query) {
          return messages
            .filter((m) => matches(m, query))
            .sort((a, b) => b.date - a.date)
            .slice(0, query.limit ?? 20)
            .map(summary);
        },
        async read(id) {
          const found = messages.find((m) => m.id === id);
          if (!found) throw new OgbError("not_found", `no message '${id}'`);
          found.unread = false;
          return { ...found };
        },
        watch(onMail, watchOptions): Stop {
          // The cursor is the arrival number of the newest inbox message reported (ids are m<number>).
          const number = (m: MailMessage) => Number(m.id.slice(1));
          const inbox = () => messages.filter((m) => m.folder === "inbox");
          let position = watchOptions?.after !== undefined ? Number(watchOptions.after) : Math.max(0, ...inbox().map(number));
          const report = (m: MailMessage) => {
            if (m.folder !== "inbox" || number(m) <= position) return;
            position = number(m);
            onMail(summary(m));
            watchOptions?.onCursor?.(String(position));
          };
          for (const m of inbox().sort((a, b) => number(a) - number(b))) report(m);
          watchOptions?.onCursor?.(String(position));
          mailWatchers.add(report);
          return () => void mailWatchers.delete(report);
        },
      },
      sender: {
        async send(draft) {
          const copy: MailMessage = {
            id: `m${++counter}`,
            folder: "sent",
            from: address,
            to: draft.to,
            cc: draft.cc ?? [],
            subject: draft.subject,
            body: draft.body,
            date: now(),
            unread: false,
          };
          messages.push(copy);
          provider.sent.push(copy);
          return { id: copy.id };
        },
      },
    };
  }
  if (withCalendar) {
    provider.calendar = {
      async list(range) {
        return [...events.values()].filter((e) => e.start < range.to && e.end > range.from).sort((a, b) => a.start - b.start);
      },
      async read(id) {
        const found = events.get(id);
        if (!found) throw new OgbError("not_found", `no event '${id}'`);
        return { ...found };
      },
      async create(event) {
        const created: CalendarEvent = { id: `e${++counter}`, ...event };
        events.set(created.id, created);
        return created;
      },
      async update(id, patch) {
        const found = events.get(id);
        if (!found) throw new OgbError("not_found", `no event '${id}'`);
        const next = { ...found, ...patch, id };
        events.set(id, next);
        return next;
      },
      watch(onEvent): Stop {
        eventWatchers.add(onEvent);
        return () => void eventWatchers.delete(onEvent);
      },
    };
  }
  return provider;
}
