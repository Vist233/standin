import { OgbError } from "@vesper/contracts";
import type { MailMessage, MailQuery, MailSummary, Provider, Provisioner, Stop } from "../types.ts";

/**
 * A deployment of cloudflare_temp_email (Cloudflare Email Routing into a Worker and D1): addresses on a domain the owner holds, each
 * reached with its own token (a JWT the deployment signs). This file speaks its HTTP API and nothing else.
 *
 * API used (worker/src of the deployment): `POST /admin/new_address` (header `x-admin-auth`), `GET /api/parsed_mails`,
 * `GET /api/parsed_mail/:id`, `POST /api/send_mail`, `GET /api/sendbox` (header `Authorization: Bearer <address JWT>`); a site
 * password, when the deployment has one, goes in `x-custom-auth` on every request.
 */
export interface TempMailSite {
  /** The Worker's API address, for example `https://mail-api.example.com`. */
  baseUrl: string;
  /** The deployment's site password (`PASSWORDS`), when it has one. */
  sitePassword?: string | undefined;
  /** Default: the global `fetch`. Tests pass a fake deployment. */
  fetch?: typeof fetch | undefined;
}

/** Which inbox mail this account has read: the deployment keeps no read state, so the caller keeps it (a file, for a plugin). */
export interface ReadState {
  has(id: string): boolean;
  add(id: string): void;
}

export interface TempMailAccount extends TempMailSite {
  address: string;
  /** The address's JWT: the credential of this one address. */
  token: string;
  readState?: ReadState | undefined;
  /** How often `watch` asks for new mail (default 15000 ms). */
  pollMs?: number | undefined;
}

/** The newest pages read for `list` (100 mails each): older mail is not searched. */
const PAGES = 3;
const PAGE = 100;

interface ParsedRow {
  id: number;
  sender?: string;
  subject?: string;
  text?: string;
  html?: string;
  created_at?: string;
}

interface SentRow {
  id: number;
  raw?: string;
  created_at?: string;
}

/** The deployment writes SQLite's `YYYY-MM-DD HH:MM:SS` in UTC. */
function dateOf(created: string | undefined): number {
  if (!created) return 0;
  const time = Date.parse(/[zZ]|[+-]\d\d:?\d\d$/.test(created) ? created : `${created.replace(" ", "T")}Z`);
  return Number.isNaN(time) ? 0 : time;
}

function textOf(row: { text?: string; html?: string }): string {
  if (row.text?.trim()) return row.text;
  return (row.html ?? "")
    .replace(/<(script|style)[\s\S]*?<\/\1>/gi, "")
    .replace(/<br\s*\/?>|<\/p>/gi, "\n")
    .replace(/<[^>]+>/g, "")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .trim();
}

function matches(mail: MailMessage, query: MailQuery): boolean {
  if (query.from !== undefined && !mail.from.toLowerCase().includes(query.from.toLowerCase())) return false;
  if (query.unreadOnly && !mail.unread) return false;
  if (query.text !== undefined) {
    const hay = `${mail.subject} ${mail.from} ${mail.body}`.toLowerCase();
    if (
      !query.text
        .toLowerCase()
        .split(/\s+/)
        .filter(Boolean)
        .every((word) => hay.includes(word))
    )
      return false;
  }
  return true;
}

function client(site: TempMailSite, headers: Record<string, string>) {
  const doFetch = site.fetch ?? fetch;
  const base = site.baseUrl.replace(/\/+$/, "");
  return async function call<T>(method: string, path: string, body?: unknown): Promise<T> {
    const response = await doFetch(`${base}${path}`, {
      method,
      headers: {
        ...headers,
        ...(site.sitePassword ? { "x-custom-auth": site.sitePassword } : {}),
        ...(body === undefined ? {} : { "content-type": "application/json" }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const raw = await response.text();
    if (response.status === 401 || response.status === 403)
      throw new OgbError("denied", `the mail service refused ${method} ${path} (${response.status}): check the token or password`);
    if (!response.ok) throw new OgbError("unavailable", `the mail service answered ${response.status} to ${method} ${path}: ${raw.slice(0, 200)}`);
    try {
      return (raw === "" ? null : JSON.parse(raw)) as T;
    } catch {
      return raw as T;
    }
  };
}

/** Makes addresses on the deployment's domain (the admin password is needed). */
export function createTempMailAddresses(site: TempMailSite & { adminPassword: string; domain: string }): Provisioner {
  const call = client(site, { "x-admin-auth": site.adminPassword });
  return {
    async create(name) {
      if (!/^[a-z0-9][a-z0-9._-]{0,63}$/.test(name))
        throw new OgbError("invalid_input", `'${name}' is not a usable mailbox name (lower-case letters, digits, . _ -)`);
      const made = await call<{ address?: string; jwt?: string }>("POST", "/admin/new_address", { name, domain: site.domain, enablePrefix: false });
      if (!made?.address || !made.jwt) throw new OgbError("unavailable", "the mail service made no address (no address or token in its answer)");
      return { address: made.address, credential: made.jwt };
    },
  };
}

/** One address of the deployment as a mail provider: its inbox, its sent mail, sending from it. */
export function createTempMailProvider(account: TempMailAccount): Provider {
  const call = client(account, { authorization: `Bearer ${account.token}` });
  const memory = new Set<string>();
  const readState: ReadState = account.readState ?? { has: (id) => memory.has(id), add: (id) => void memory.add(id) };
  const pollMs = account.pollMs ?? 15_000;

  const inboxMail = (row: ParsedRow): MailMessage => ({
    id: `i${row.id}`,
    folder: "inbox",
    from: row.sender ?? "",
    to: [account.address],
    cc: [],
    subject: row.subject ?? "",
    body: textOf(row),
    date: dateOf(row.created_at),
    unread: !readState.has(`i${row.id}`),
  });

  const sentMail = (row: SentRow): MailMessage => {
    let sent: { to_mail?: string; subject?: string; content?: string; is_html?: boolean } = {};
    try {
      sent = JSON.parse(row.raw ?? "{}");
    } catch {}
    const content = sent.content ?? "";
    return {
      id: `s${row.id}`,
      folder: "sent",
      from: account.address,
      to: sent.to_mail ? [sent.to_mail] : [],
      cc: [],
      subject: sent.subject ?? "",
      body: sent.is_html ? textOf({ html: content }) : content,
      date: dateOf(row.created_at),
      unread: false,
    };
  };

  async function page<T>(path: string, offset: number, limit = PAGE): Promise<T[]> {
    const answer = await call<{ results?: T[] }>("GET", `${path}?limit=${limit}&offset=${offset}`);
    return answer?.results ?? [];
  }

  async function newest(folder: "inbox" | "sent"): Promise<MailMessage[]> {
    const found: MailMessage[] = [];
    for (let index = 0; index < PAGES; index += 1) {
      const rows =
        folder === "inbox"
          ? (await page<ParsedRow>("/api/parsed_mails", index * PAGE)).map(inboxMail)
          : (await page<SentRow>("/api/sendbox", index * PAGE)).map(sentMail);
      found.push(...rows);
      if (rows.length < PAGE) break;
    }
    return found;
  }

  const summary = ({ id, folder, from, subject, date, unread }: MailMessage): MailSummary => ({ id, folder, from, subject, date, unread });

  return {
    address: account.address,
    mail: {
      reader: {
        async list(query) {
          const folder = query.folder ?? "inbox";
          if (folder !== "inbox" && folder !== "sent") return [];
          const mails = (await newest(folder)).filter((mail) => matches(mail, query));
          // Newest first; the service's ids grow with arrival, so they break ties of the same second.
          mails.sort((a, b) => b.date - a.date || Number(b.id.slice(1)) - Number(a.id.slice(1)));
          return mails.slice(0, query.limit ?? 20).map(summary);
        },
        async read(id) {
          const number = /^[is](\d{1,15})$/.exec(id);
          if (!number) throw new OgbError("not_found", `no mail '${id}'`);
          if (id.startsWith("s")) {
            const sent = (await newest("sent")).find((mail) => mail.id === id);
            if (!sent) throw new OgbError("not_found", `no mail '${id}'`);
            return sent;
          }
          const row = await call<ParsedRow | null>("GET", `/api/parsed_mail/${number[1]}`);
          if (!row || typeof row !== "object" || row.id === undefined) throw new OgbError("not_found", `no mail '${id}'`);
          readState.add(id);
          return { ...inboxMail(row), unread: false };
        },
        watch(onMail, options): Stop {
          let stopped = false;
          // The cursor is the highest mail id seen: the deployment's ids grow with arrival.
          let highest: number | undefined = options?.after !== undefined && /^\d+$/.test(options.after) ? Number(options.after) : undefined;
          let timer: NodeJS.Timeout | undefined;
          const look = async () => {
            const rows = await page<ParsedRow>("/api/parsed_mails", 0, 50);
            const top = Math.max(0, ...rows.map((row) => row.id));
            if (highest === undefined) {
              highest = top; // what was there when the watch began is never reported
              options?.onCursor?.(String(highest));
              return;
            }
            const fresh = rows.filter((row) => row.id > (highest as number)).sort((a, b) => a.id - b.id);
            for (const row of fresh) {
              if (stopped) return;
              onMail(summary(inboxMail(row)));
              highest = Math.max(highest, row.id);
              options?.onCursor?.(String(highest));
            }
          };
          const loop = () => {
            if (stopped) return;
            look()
              .catch(() => undefined) // a failed look is tried again at the next tick
              .finally(() => {
                if (!stopped) timer = setTimeout(loop, pollMs);
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
          for (const to of [...draft.to, ...(draft.cc ?? [])]) {
            await call("POST", "/api/send_mail", { from_name: "", to_mail: to, to_name: "", subject: draft.subject, content: draft.body, is_html: false });
          }
          const [latest] = await page<SentRow>("/api/sendbox", 0, 1);
          if (!latest) throw new OgbError("unavailable", "the mail was accepted but no sent copy was found");
          return { id: `s${latest.id}` };
        },
      },
    },
  };
}
