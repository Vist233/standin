import { OgbError } from "@vesper/contracts";
import type { ChatEvent, ChatSource } from "./types.ts";

/**
 * A Satori server as a chat source (the protocol of Koishi and onebots, over QQ, Feishu, DingTalk, WeCom, WeChat...). Events come
 * over a WebSocket (`/v1/events`: IDENTIFY with the token and the last sequence number, READY, then EVENT frames; PING every 10 s);
 * messages are sent with `POST /v1/message.create`. The cursor is the last sequence number (`sn`), which a server that keeps events
 * uses to replay what came while Vesper was away.
 */
export interface SatoriOptions {
  /** The server's API base, for example `http://127.0.0.1:5140/satori` (without `/v1`). */
  baseUrl: string;
  token?: string | undefined;
  /** The platform and the bot account to act as (`Satori-Platform`, `Satori-User-ID`); taken from READY when not given. */
  platform?: string | undefined;
  selfId?: string | undefined;
  fetch?: typeof fetch | undefined;
  /** Opens the event socket (default: the global WebSocket). */
  connect?: (url: string) => SatoriSocket;
  /** How long `next` waits for events before it returns none (default 25000 ms). */
  pollMs?: number;
}

/** The part of a WebSocket this adapter uses. */
export interface SatoriSocket {
  send(text: string): void;
  close(): void;
  onopen: (() => void) | null;
  onmessage: ((event: { data: unknown }) => void) | null;
  onclose: (() => void) | null;
}

const OP = { event: 0, ping: 1, pong: 2, identify: 3, ready: 4 } as const;

interface SatoriEvent {
  sn?: number;
  id?: number;
  type?: string;
  platform?: string;
  self_id?: string;
  timestamp?: number;
  channel?: { id?: string };
  user?: { id?: string; name?: string; nick?: string };
  member?: { nick?: string };
  message?: { id?: string; content?: string; quote?: { id?: string } };
}

/** Satori message content is XML-like elements; the text is what is left after the tags, with entities undone. */
export function satoriText(content: string): string {
  return content
    .replace(/<at [^>]*name="([^"]*)"[^>]*\/>/g, "@$1")
    .replace(/<[^>]+>/g, "")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&amp;/g, "&")
    .trim();
}
const escapeContent = (text: string) => text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

export function openSatori(options: SatoriOptions): ChatSource & { close(): void } {
  const base = options.baseUrl.replace(/\/+$/, "");
  const connect = options.connect ?? ((url: string) => new WebSocket(url) as unknown as SatoriSocket);
  let platform = options.platform;
  let selfId = options.selfId;
  let socket: SatoriSocket | undefined;
  let lastSn: number | undefined;
  let ping: NodeJS.Timeout | undefined;
  const buffer: ChatEvent[] = [];
  let wake: (() => void) | undefined;

  function open(after: number | undefined): void {
    const url = `${base.replace(/^http/, "ws")}/v1/events`;
    const made = connect(url);
    socket = made;
    made.onopen = () => {
      made.send(
        JSON.stringify({ op: OP.identify, body: { ...(options.token ? { token: options.token } : {}), ...(after !== undefined ? { sn: after } : {}) } }),
      );
      ping = setInterval(() => made.send(JSON.stringify({ op: OP.ping })), 10_000);
      ping.unref?.();
    };
    made.onmessage = ({ data }) => {
      let frame: { op?: number; body?: Record<string, unknown> };
      try {
        frame = JSON.parse(String(data));
      } catch {
        return;
      }
      if (frame.op === OP.ready) {
        const login = (frame.body?.logins as { platform?: string; user?: { id?: string }; self_id?: string }[] | undefined)?.[0];
        platform ??= login?.platform;
        selfId ??= login?.user?.id ?? login?.self_id;
        return;
      }
      if (frame.op !== OP.event) return;
      const e = frame.body as SatoriEvent;
      const sn = e.sn ?? e.id;
      if (typeof sn === "number") lastSn = Math.max(lastSn ?? 0, sn);
      if (e.type !== "message-created" || !e.message?.content || !e.channel?.id || !e.user?.id) return;
      if (e.user.id === (e.self_id ?? selfId)) return;
      buffer.push({
        id: `${e.platform ?? platform ?? "satori"}:${e.message.id ?? sn}`,
        room: e.channel.id,
        sender: e.user.id,
        senderName: e.member?.nick ?? e.user.nick ?? e.user.name,
        text: satoriText(e.message.content),
        at: e.timestamp ?? Date.now(),
        replyTo: e.message.quote?.id,
      });
      wake?.();
    };
    made.onclose = () => {
      if (ping) clearInterval(ping);
      if (socket === made) socket = undefined; // the next `next` opens a new one, from the last sequence number
      wake?.();
    };
  }

  return {
    get self() {
      return selfId;
    },
    async next(cursor, signal) {
      if (!socket) open(lastSn ?? (cursor !== undefined && /^\d+$/.test(cursor) ? Number(cursor) : undefined));
      if (buffer.length === 0)
        await new Promise<void>((resolve) => {
          const timer = setTimeout(resolve, options.pollMs ?? 25_000);
          wake = () => {
            clearTimeout(timer);
            resolve();
          };
          signal?.addEventListener("abort", () => wake?.(), { once: true });
        });
      wake = undefined;
      const events = buffer.splice(0);
      return { events, cursor: lastSn !== undefined ? String(lastSn) : (cursor ?? "") };
    },
    async send(room, text) {
      if (!platform || !selfId) throw new OgbError("unavailable", "the Satori server has not said which account to act as yet");
      const response = await (options.fetch ?? fetch)(`${base}/v1/message.create`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          ...(options.token ? { authorization: `Bearer ${options.token}` } : {}),
          "satori-platform": platform,
          "satori-user-id": selfId,
          "x-platform": platform, // Satori 1.0 servers
          "x-self-id": selfId,
        },
        body: JSON.stringify({ channel_id: room, content: escapeContent(text) }),
      });
      if (!response.ok) throw new OgbError("unavailable", `the Satori server answered ${response.status} to message.create`);
      const made = (await response.json().catch(() => [])) as { id?: string }[];
      return { id: made[0]?.id ?? `${Date.now()}` };
    },
    close() {
      const current = socket;
      socket = undefined;
      current?.close();
      if (ping) clearInterval(ping);
    },
  };
}
