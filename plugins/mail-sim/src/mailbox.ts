import { mkdirSync, readdirSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { CalendarEvent, MailMessage, MailQuery, MailSummary, Provider, Stop } from "@vesper/connectors";
import { OgbError } from "@vesper/contracts";

export interface MailboxOptions {
  /** The mailbox directory: `inbox/`, `sent/`, `calendar/` and `read.json` live in it. */
  directory: string;
  address: string;
  now?: () => number;
  /** How often watchers look at the folders (default 1000 ms). */
  pollMs?: number;
}

interface StoredMail {
  from: string;
  to?: string[];
  cc?: string[];
  subject: string;
  body: string;
  date?: number;
}

const ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,80}$/;
const FOLDERS = ["inbox", "sent"] as const;

function readJson<T>(path: string): T | undefined {
  try {
    return JSON.parse(readFileSync(path, "utf8")) as T;
  } catch {
    return undefined; // missing, or half written by someone dropping a file: ignored this time
  }
}

/** Writes through a temporary file and a rename, so a watcher never sees half a file. */
function writeJson(path: string, value: unknown): void {
  const temporary = `${path}.tmp`;
  writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`);
  renameSync(temporary, path);
}

/**
 * A mailbox and a calendar in plain files, so a test or a person can make mail arrive by dropping a JSON file into `inbox/`
 * (`{ "from": "...", "subject": "...", "body": "..." }`; the id is the file name). It implements the provider interfaces and
 * passes the same contract suite as a real provider.
 */
export function createFileMailbox(options: MailboxOptions): Provider {
  const now = options.now ?? Date.now;
  const poll = options.pollMs ?? 1000;
  const dir = options.directory;
  for (const sub of [...FOLDERS, "calendar"]) mkdirSync(join(dir, sub), { recursive: true });
  let counter = 0;
  const readIds = (): Set<string> => new Set(readJson<string[]>(join(dir, "read.json")) ?? []);

  function load(folder: string, file: string): MailMessage | undefined {
    const path = join(dir, folder, file);
    const stored = readJson<StoredMail>(path);
    if (!stored || typeof stored.from !== "string" || typeof stored.subject !== "string" || typeof stored.body !== "string") return undefined;
    const id = file.replace(/\.json$/, "");
    return {
      id,
      folder,
      from: stored.from,
      to: stored.to ?? [options.address],
      cc: stored.cc ?? [],
      subject: stored.subject,
      body: stored.body,
      date: typeof stored.date === "number" ? stored.date : statSync(path).mtimeMs,
      unread: folder === "inbox" && !readIds().has(id),
    };
  }

  function all(folder: string): MailMessage[] {
    const found: MailMessage[] = [];
    for (const file of readdirSync(join(dir, folder))) {
      if (!file.endsWith(".json")) continue;
      const mail = load(folder, file);
      if (mail) found.push(mail);
    }
    return found;
  }

  const summary = ({ id, folder, from, subject, date, unread }: MailMessage): MailSummary => ({ id, folder, from, subject, date, unread });
  const matches = (m: MailMessage, q: MailQuery): boolean => {
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

  /**
   * Calls `onNew` for items that appear after the watch started, in the order they were dated. With `after` (a cursor: the date and id
   * of the last item reported) it first reports what came after that point.
   */
  function watchFolder<T extends { id: string; date: number }>(
    list: () => T[],
    onNew: (item: T) => void,
    options: { after?: string | undefined; onCursor?: ((cursor: string) => void) | undefined } = {},
  ): Stop {
    const keyOf = (item: T) => `${String(Math.round(item.date)).padStart(16, "0")}|${item.id}`;
    const items = list();
    // Taken now, not at the first poll: nothing between is lost.
    const known = new Set(items.filter((item) => options.after === undefined || keyOf(item) <= (options.after as string)).map((item) => item.id));
    let cursor = options.after ?? items.map(keyOf).sort().at(-1) ?? "";
    const look = () => {
      const fresh = list()
        .filter((item) => !known.has(item.id))
        .sort((a, b) => a.date - b.date || a.id.localeCompare(b.id));
      for (const item of fresh) {
        known.add(item.id);
        onNew(item);
        if (keyOf(item) > cursor) cursor = keyOf(item);
        options.onCursor?.(cursor);
      }
    };
    options.onCursor?.(cursor);
    if (options.after !== undefined) look();
    const timer = setInterval(look, poll);
    timer.unref();
    return () => clearInterval(timer);
  }

  const events = (): CalendarEvent[] => {
    const found: CalendarEvent[] = [];
    for (const file of readdirSync(join(dir, "calendar"))) {
      if (!file.endsWith(".json")) continue;
      const stored = readJson<Omit<CalendarEvent, "id">>(join(dir, "calendar", file));
      if (stored && typeof stored.title === "string" && typeof stored.start === "number" && typeof stored.end === "number") {
        found.push({ ...stored, attendees: stored.attendees ?? [], id: file.replace(/\.json$/, "") });
      }
    }
    return found;
  };
  const eventFile = (id: string) => {
    if (!ID.test(id)) throw new OgbError("invalid_input", "invalid event id");
    return join(dir, "calendar", `${id}.json`);
  };
  const readEvent = (id: string): CalendarEvent => {
    const stored = readJson<Omit<CalendarEvent, "id">>(eventFile(id));
    if (!stored) throw new OgbError("not_found", `no event '${id}'`);
    return { ...stored, attendees: stored.attendees ?? [], id };
  };

  return {
    address: options.address,
    mail: {
      reader: {
        async list(query) {
          const folders = query.folder === undefined ? ["inbox", "sent"] : (FOLDERS as readonly string[]).includes(query.folder) ? [query.folder] : [];
          return folders
            .flatMap((folder) => all(folder))
            .filter((m) => matches(m, query))
            .sort((a, b) => b.date - a.date || b.id.localeCompare(a.id))
            .slice(0, query.limit ?? 20)
            .map(summary);
        },
        async read(id) {
          if (!ID.test(id)) throw new OgbError("not_found", `no message '${id}'`);
          for (const folder of FOLDERS) {
            const mail = load(folder, `${id}.json`);
            if (!mail) continue;
            if (mail.unread) writeJson(join(dir, "read.json"), [...readIds(), id]);
            return mail;
          }
          throw new OgbError("not_found", `no message '${id}'`);
        },
        watch: (onMail, watchOptions) =>
          watchFolder(
            () => all("inbox"),
            (mail) => onMail(summary(mail)),
            watchOptions,
          ),
      },
      sender: {
        async send(draft) {
          const id = `s${now()}-${++counter}`;
          const stored: StoredMail = { from: options.address, to: draft.to, cc: draft.cc ?? [], subject: draft.subject, body: draft.body, date: now() };
          writeJson(join(dir, "sent", `${id}.json`), stored);
          return { id };
        },
      },
    },
    calendar: {
      async list(range) {
        return events()
          .filter((e) => e.start < range.to && e.end > range.from)
          .sort((a, b) => a.start - b.start);
      },
      async read(id) {
        return readEvent(id);
      },
      async create(event) {
        // The `self-` prefix marks events the agent made, so its own events do not come back as "new event" signals.
        const id = `self-${now()}-${++counter}`;
        writeJson(eventFile(id), event);
        return { ...event, id };
      },
      async update(id, patch) {
        const next = { ...readEvent(id), ...patch, id };
        const { id: _id, ...stored } = next;
        writeJson(eventFile(id), stored);
        return next;
      },
      watch: (onEvent) =>
        watchFolder(
          () =>
            events()
              .filter((e) => !e.id.startsWith("self-"))
              .map((e) => ({ ...e, date: e.start })),
          (event) => onEvent(event),
        ),
    },
  };
}
