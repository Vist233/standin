import { OgbError } from "@vesper/contracts";
import type { MailMessage, MailQuery, MailSummary, Provider, Stop } from "../types.ts";

/**
 * Outlook and Microsoft 365 mail through Microsoft Graph (`/me/...`), with a signed-in person's token. Ids are immutable ones
 * (`Prefer: IdType="ImmutableId"`), so a draft keeps its id once sent and a message keeps it when moved.
 */
export interface GraphAccount {
  /** A valid access token (the token keeper refreshes it). */
  accessToken: () => Promise<string>;
  fetch?: typeof fetch | undefined;
  /** Default `https://graph.microsoft.com/v1.0`. Tests pass a stand-in. */
  baseUrl?: string | undefined;
  /** How often `watch` looks for new mail (default 30000 ms). */
  pollMs?: number | undefined;
}

const FOLDERS = { inbox: "inbox", sent: "sentitems" } as const;
const FIELDS = "id,subject,from,toRecipients,ccRecipients,receivedDateTime,sentDateTime,isRead,parentFolderId";
const PAGE = 100;
const PAGES = 3;

interface GraphMessage {
  id: string;
  subject?: string;
  from?: { emailAddress?: { name?: string; address?: string } };
  toRecipients?: { emailAddress?: { address?: string } }[];
  ccRecipients?: { emailAddress?: { address?: string } }[];
  receivedDateTime?: string;
  sentDateTime?: string;
  isRead?: boolean;
  parentFolderId?: string;
  body?: { contentType?: string; content?: string };
}

const addressOf = (who: GraphMessage["from"]) => {
  const { name, address } = who?.emailAddress ?? {};
  return name && address && name !== address ? `${name} <${address}>` : (address ?? "");
};
const listOf = (list: GraphMessage["toRecipients"]) => (list ?? []).map((r) => r.emailAddress?.address ?? "").filter(Boolean);

function matches(mail: MailSummary, query: MailQuery): boolean {
  if (query.from !== undefined && !mail.from.toLowerCase().includes(query.from.toLowerCase())) return false;
  if (query.unreadOnly && !mail.unread) return false;
  return true;
}

/** Opens the signed-in person's mailbox: asks Graph who they are (the address) once. */
export async function openGraphMailbox(account: GraphAccount): Promise<Provider> {
  const doFetch = account.fetch ?? fetch;
  const base = (account.baseUrl ?? "https://graph.microsoft.com/v1.0").replace(/\/+$/, "");
  const pollMs = account.pollMs ?? 30_000;

  async function call<T>(method: string, path: string, body?: unknown, extra: Record<string, string> = {}): Promise<T> {
    const response = await doFetch(`${base}${path}`, {
      method,
      headers: {
        authorization: `Bearer ${await account.accessToken()}`,
        prefer: 'IdType="ImmutableId"',
        ...extra,
        ...(body === undefined ? {} : { "content-type": "application/json" }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const raw = await response.text();
    let parsed: unknown;
    try {
      parsed = raw === "" ? null : JSON.parse(raw);
    } catch {
      parsed = raw;
    }
    if (response.ok) return parsed as T;
    const code = String((parsed as { error?: { code?: string } } | null)?.error?.code ?? response.status);
    if (response.status === 404 || code === "ErrorItemNotFound" || code === "ErrorInvalidIdMalformed")
      throw new OgbError("not_found", `no such mail (${code})`);
    if (response.status === 401 || response.status === 403) throw new OgbError("denied", `Outlook refused ${method} (${code}); sign in again if this persists`);
    throw new OgbError("unavailable", `Outlook answered ${response.status} (${code}) to ${method}`);
  }

  const me = await call<{ mail?: string; userPrincipalName?: string }>("GET", "/me?$select=mail,userPrincipalName");
  const address = me?.mail || me?.userPrincipalName || "";
  const folderIds = new Map<string, "inbox" | "sent">();
  for (const [name, wellKnown] of Object.entries(FOLDERS) as ["inbox" | "sent", string][]) {
    const folder = await call<{ id?: string }>("GET", `/me/mailFolders/${wellKnown}?$select=id`);
    if (folder?.id) folderIds.set(folder.id, name);
  }

  const toMessage = (m: GraphMessage, folder?: string): MailMessage => {
    const where = folder ?? folderIds.get(m.parentFolderId ?? "") ?? "other";
    return {
      id: m.id,
      folder: where,
      from: addressOf(m.from),
      to: listOf(m.toRecipients),
      cc: listOf(m.ccRecipients),
      subject: m.subject ?? "",
      body: m.body?.content ?? "",
      date: Date.parse((where === "sent" ? m.sentDateTime : m.receivedDateTime) ?? m.receivedDateTime ?? "") || 0,
      unread: where === "sent" ? false : m.isRead === false,
    };
  };
  const summary = ({ id, folder, from, subject, date, unread }: MailMessage): MailSummary => ({ id, folder, from, subject, date, unread });

  async function newest(folder: "inbox" | "sent", text: string | undefined): Promise<MailMessage[]> {
    const path = `/me/mailFolders/${FOLDERS[folder]}/messages`;
    if (text?.trim()) {
      // Graph's search covers subject, sender and body; it cannot be ordered, so it is ordered here.
      const found = await call<{ value?: GraphMessage[] }>(
        "GET",
        `${path}?$search=${encodeURIComponent(`"${text.replace(/"/g, "")}"`)}&$top=250&$select=${FIELDS}`,
      );
      return (found?.value ?? []).map((m) => toMessage(m, folder));
    }
    const order = folder === "sent" ? "sentDateTime" : "receivedDateTime";
    const all: MailMessage[] = [];
    let next: string | undefined = `${path}?$top=${PAGE}&$orderby=${order}%20desc&$select=${FIELDS}`;
    for (let page = 0; page < PAGES && next; page += 1) {
      const answer: { value?: GraphMessage[]; "@odata.nextLink"?: string } = await call("GET", next);
      all.push(...(answer?.value ?? []).map((m) => toMessage(m, folder)));
      const link = answer?.["@odata.nextLink"];
      next = link ? link.replace(base, "") : undefined;
    }
    return all;
  }

  return {
    address,
    mail: {
      reader: {
        async list(query) {
          const folder = query.folder ?? "inbox";
          if (folder !== "inbox" && folder !== "sent") return [];
          const found = (await newest(folder, query.text)).filter((m) => matches(m, query));
          found.sort((a, b) => b.date - a.date);
          return found.slice(0, query.limit ?? 20).map(summary);
        },
        async read(id) {
          if (!/^[A-Za-z0-9_=+/-]{1,400}$/.test(id)) throw new OgbError("not_found", `no mail '${id}'`);
          const path = `/me/messages/${encodeURIComponent(id)}`;
          const message = await call<GraphMessage>("GET", `${path}?$select=${FIELDS},body`, undefined, {
            prefer: 'IdType="ImmutableId", outlook.body-content-type="text"',
          });
          const mail = toMessage(message);
          if (mail.unread) await call("PATCH", path, { isRead: true });
          return { ...mail, unread: false };
        },
        watch(onMail, options): Stop {
          let stopped = false;
          let seen: Set<string> | undefined;
          let timer: NodeJS.Timeout | undefined;
          // Decided by arrival time, not by the first answer: the first look runs after a token refresh, and mail that arrives in
          // between came after the watch began. With a cursor (the arrival time of the last mail reported) it starts from there.
          const after = options?.after !== undefined && /^\d+$/.test(options.after) ? Number(options.after) : undefined;
          const began = Date.now();
          let newest = after ?? began;
          const look = async () => {
            const answer = await call<{ value?: GraphMessage[] }>(
              "GET",
              `/me/mailFolders/inbox/messages?$top=50&$orderby=receivedDateTime%20desc&$select=${FIELDS}`,
            );
            const rows = (answer?.value ?? []).map((m) => toMessage(m, "inbox"));
            if (!seen) {
              seen = new Set(rows.filter((m) => (after !== undefined ? m.date <= after : m.date < began)).map((m) => m.id)); // what was there is never reported
              options?.onCursor?.(String(newest));
            }
            const fresh = rows.filter((m) => !seen?.has(m.id)).sort((a, b) => a.date - b.date);
            for (const mail of fresh) {
              seen.add(mail.id);
              if (stopped) return;
              onMail(summary(mail));
              newest = Math.max(newest, mail.date);
              options?.onCursor?.(String(newest));
            }
            if (seen.size > 5000) seen = new Set([...seen].slice(-2000));
          };
          const loop = () => {
            if (stopped) return;
            look()
              .catch(() => undefined) // tried again at the next tick
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
          const recipients = (list: string[] = []) => list.map((address) => ({ emailAddress: { address } }));
          const made = await call<{ id?: string }>("POST", "/me/messages", {
            subject: draft.subject,
            body: { contentType: "Text", content: draft.body },
            toRecipients: recipients(draft.to),
            ccRecipients: recipients(draft.cc),
          });
          if (!made?.id) throw new OgbError("unavailable", "Outlook made no draft");
          await call("POST", `/me/messages/${encodeURIComponent(made.id)}/send`);
          return { id: made.id }; // immutable: the sent copy has the draft's id
        },
      },
    },
  };
}
