import { randomBytes } from "node:crypto";
import { OgbError } from "@vesper/contracts";
import type { ChatEvent, ChatSource } from "./types.ts";

/**
 * A Matrix account as a chat source: the client-server API (`/sync` long polling with `since`, `PUT .../send`). Whatever networks the
 * homeserver's bridges reach (WhatsApp, Signal, Telegram, Slack, Discord through mautrix) arrive as Matrix rooms and users.
 */
export interface MatrixOptions {
  /** The homeserver, for example `https://matrix.example.org`. */
  homeserver: string;
  /** The access token of Vesper's Matrix account. */
  token: string;
  fetch?: typeof fetch | undefined;
  /** How long one sync waits for news (default 25000 ms). */
  pollMs?: number;
}

interface SyncAnswer {
  next_batch?: string;
  rooms?: {
    join?: Record<
      string,
      {
        timeline?: {
          events?: {
            event_id?: string;
            type?: string;
            sender?: string;
            origin_server_ts?: number;
            content?: { msgtype?: string; body?: string; "m.relates_to"?: { "m.in_reply_to"?: { event_id?: string } } };
          }[];
        };
      }
    >;
  };
}

const FILTER = JSON.stringify({ room: { timeline: { types: ["m.room.message"], limit: 50 }, state: { lazy_load_members: true } }, presence: { types: [] } });

/** Opens the account (asks who it is, so its own messages are never events). */
export async function openMatrix(options: MatrixOptions): Promise<ChatSource> {
  const doFetch = options.fetch ?? fetch;
  const base = options.homeserver.replace(/\/+$/, "");
  async function call<T>(method: string, path: string, body?: unknown, signal?: AbortSignal): Promise<T> {
    const response = await doFetch(`${base}${path}`, {
      method,
      headers: { authorization: `Bearer ${options.token}`, ...(body === undefined ? {} : { "content-type": "application/json" }) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      ...(signal ? { signal } : {}),
    });
    const text = await response.text();
    if (response.status === 401 || response.status === 403)
      throw new OgbError("denied", `the homeserver refused ${method} (${response.status}): check the access token`);
    if (!response.ok) throw new OgbError("unavailable", `the homeserver answered ${response.status} to ${method} ${path.split("?")[0]}`);
    return (text ? JSON.parse(text) : {}) as T;
  }

  const self = (await call<{ user_id?: string }>("GET", "/_matrix/client/v3/account/whoami")).user_id;
  const sync = (since: string | undefined, timeout: number, signal?: AbortSignal) =>
    call<SyncAnswer>(
      "GET",
      `/_matrix/client/v3/sync?filter=${encodeURIComponent(FILTER)}&timeout=${timeout}${since ? `&since=${encodeURIComponent(since)}` : ""}`,
      undefined,
      signal,
    );

  return {
    self,
    async next(cursor, signal) {
      if (cursor === undefined) {
        // The first sync returns recent history: take its position only, so nothing that was already there wakes a bot.
        const first = await sync(undefined, 0, signal);
        return { events: [], cursor: first.next_batch ?? "" };
      }
      const answer = await sync(cursor, options.pollMs ?? 25_000, signal);
      const events: ChatEvent[] = [];
      for (const [room, joined] of Object.entries(answer.rooms?.join ?? {})) {
        for (const e of joined.timeline?.events ?? []) {
          if (e.type !== "m.room.message" || !e.event_id || !e.sender || e.sender === self || typeof e.content?.body !== "string") continue;
          if (e.content.msgtype !== "m.text" && e.content.msgtype !== "m.notice") continue;
          events.push({
            id: e.event_id,
            room,
            sender: e.sender,
            text: e.content.body,
            at: e.origin_server_ts ?? Date.now(),
            replyTo: e.content["m.relates_to"]?.["m.in_reply_to"]?.event_id,
          });
        }
      }
      events.sort((a, b) => a.at - b.at);
      return { events, cursor: answer.next_batch ?? cursor };
    },
    async send(room, text) {
      const txn = `vesper-${Date.now()}-${randomBytes(4).toString("hex")}`;
      const answer = await call<{ event_id?: string }>("PUT", `/_matrix/client/v3/rooms/${encodeURIComponent(room)}/send/m.room.message/${txn}`, {
        msgtype: "m.text",
        body: text,
      });
      return { id: answer.event_id ?? txn };
    },
  };
}
