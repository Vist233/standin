import { describe, expect, it } from "vitest";
import type { ChatSource } from "../chat/types.ts";
import type { SatoriSocket } from "../chat/satori.ts";

/** What the shared chat-source contract needs of a stand-in server. */
export interface ChatHarness {
  source: ChatSource;
  /** Someone writes in a room (on the bridge's side). */
  say(room: string, sender: string, text: string, replyTo?: string): void;
  /** What the source wrote, in order. */
  sent(): { room: string; text: string; id: string }[];
  /** A new source on the same server (a restart of Vesper). */
  reopen(): Promise<ChatSource>;
  self: string;
}

/**
 * What every chat source must do: no history at the first call; each message once, with room, sender and text; never its own; after a
 * restart from the cursor, what was said meanwhile; sending reaches the room.
 */
export function chatSourceContract(name: string, create: () => Promise<ChatHarness>): void {
  describe(`chat source contract: ${name}`, () => {
    it("no history at the first call; then each message once; never its own", async () => {
      const h = await create();
      h.say("!room", "@ann:x", "said before Vesper looked");
      const first = await h.source.next(undefined);
      expect(first.events).toEqual([]);
      h.say("!room", "@ann:x", "hello");
      h.say("!room", h.self, "my own echo");
      let batch = await h.source.next(first.cursor);
      let events = batch.events;
      while (events.length === 0) {
        batch = await h.source.next(batch.cursor);
        events = batch.events;
      }
      expect(events.map(({ room, sender, text }) => ({ room, sender, text }))).toEqual([{ room: "!room", sender: "@ann:x", text: "hello" }]);
      expect((await h.source.next(batch.cursor)).events).toEqual([]);
    });

    it("a source opened again from the cursor gets what was said while it was away; sending reaches the room", async () => {
      const h = await create();
      const first = await h.source.next(undefined);
      h.say("!room", "@ann:x", "one");
      let batch = await h.source.next(first.cursor);
      while (batch.events.length === 0) batch = await h.source.next(batch.cursor);
      h.say("!room", "@bob:x", "said while Vesper was down");
      const again = await h.reopen();
      let later = await again.next(batch.cursor);
      while (later.events.length === 0) later = await again.next(later.cursor);
      expect(later.events.map((e) => e.text)).toEqual(["said while Vesper was down"]);
      const made = await again.send("!dm", "a reply");
      expect(h.sent()).toEqual([{ room: "!dm", text: "a reply", id: made.id }]);
    });
  });
}

/** A homeserver stand-in as a `fetch`: whoami, sync with `since` (long poll shortened), send. */
export function createFakeMatrix(options: { self?: string; token?: string } = {}) {
  const self = options.self ?? "@vesper:x";
  const token = options.token ?? "mx-token";
  const timeline: { room: string; event: Record<string, unknown> }[] = [];
  const sent: { room: string; text: string; id: string }[] = [];
  let counter = 0;
  const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status });
  const answer = (since: number) => {
    const join: Record<string, { timeline: { events: unknown[] } }> = {};
    for (const [index, item] of timeline.entries()) {
      if (index < since) continue;
      join[item.room] ??= { timeline: { events: [] } };
      join[item.room]?.timeline.events.push(item.event);
    }
    return { next_batch: `s${timeline.length}`, rooms: { join } };
  };
  const fake = {
    self,
    token,
    sent,
    say(room: string, sender: string, text: string, replyTo?: string) {
      counter += 1;
      timeline.push({
        room,
        event: {
          event_id: `$e${counter}`,
          type: "m.room.message",
          sender,
          origin_server_ts: Date.now() + counter,
          content: { msgtype: "m.text", body: text, ...(replyTo ? { "m.relates_to": { "m.in_reply_to": { event_id: replyTo } } } : {}) },
        },
      });
    },
    fetch: (async (input: string | URL | Request, init?: RequestInit) => {
      const url = new URL(String(input));
      if (new Headers(init?.headers).get("authorization") !== `Bearer ${token}`) return json({ errcode: "M_UNKNOWN_TOKEN" }, 401);
      if (url.pathname === "/_matrix/client/v3/account/whoami") return json({ user_id: self });
      if (url.pathname === "/_matrix/client/v3/sync") {
        const since = url.searchParams.get("since");
        if (!since) return json(answer(timeline.length)); // history is not what this test is about: the position is
        const from = Number(since.slice(1));
        const wait = Math.min(Number(url.searchParams.get("timeout") ?? 0), 60);
        for (let waited = 0; timeline.length <= from && waited < wait; waited += 5) await new Promise((r) => setTimeout(r, 5));
        return json(answer(from));
      }
      const send = /^\/_matrix\/client\/v3\/rooms\/([^/]+)\/send\/m\.room\.message\/([^/]+)$/.exec(url.pathname);
      if (send && init?.method === "PUT") {
        const room = decodeURIComponent(send[1] as string);
        const body = JSON.parse(String(init.body)) as { body: string };
        counter += 1;
        const id = `$e${counter}`;
        sent.push({ room, text: body.body, id });
        timeline.push({
          room,
          event: { event_id: id, type: "m.room.message", sender: self, origin_server_ts: Date.now(), content: { msgtype: "m.text", body: body.body } },
        });
        return json({ event_id: id });
      }
      return json({ errcode: "M_NOT_FOUND" }, 404);
    }) as typeof fetch,
  };
  return fake;
}

/** A Satori server stand-in: the event socket (IDENTIFY with resume by `sn`, READY, EVENT) and `message.create` over `fetch`. */
export function createFakeSatori(options: { self?: string; platform?: string; token?: string } = {}) {
  const self = options.self ?? "bot-1";
  const platform = options.platform ?? "feishu";
  const token = options.token ?? "satori-token";
  const events: Record<string, unknown>[] = [];
  const sockets: { socket: SatoriSocket; after: number | undefined }[] = [];
  const sent: { room: string; text: string; id: string }[] = [];
  let sn = 0;
  const frame = (op: number, body?: unknown) => JSON.stringify({ op, ...(body ? { body } : {}) });
  const fake = {
    self,
    platform,
    token,
    sent,
    say(room: string, sender: string, text: string, replyTo?: string) {
      sn += 1;
      const event = {
        sn,
        type: "message-created",
        platform,
        self_id: self,
        timestamp: Date.now(),
        channel: { id: room },
        user: { id: sender, name: sender },
        message: { id: `m${sn}`, content: text.replace(/&/g, "&amp;").replace(/</g, "&lt;"), ...(replyTo ? { quote: { id: replyTo } } : {}) },
      };
      events.push(event);
      for (const { socket } of sockets) socket.onmessage?.({ data: frame(0, event) });
    },
    connect(_url: string): SatoriSocket {
      const socket: SatoriSocket = {
        onopen: null,
        onmessage: null,
        onclose: null,
        send(text: string) {
          const message = JSON.parse(text) as { op: number; body?: { token?: string; sn?: number } };
          if (message.op !== 3) return;
          if (message.body?.token !== token) return socket.close();
          sockets.push({ socket, after: message.body?.sn });
          socket.onmessage?.({ data: frame(4, { logins: [{ platform, user: { id: self } }] }) });
          if (message.body?.sn !== undefined)
            for (const e of events) if ((e.sn as number) > (message.body.sn as number)) socket.onmessage?.({ data: frame(0, e) });
        },
        close() {
          const at = sockets.findIndex((s) => s.socket === socket);
          if (at >= 0) sockets.splice(at, 1);
          socket.onclose?.();
        },
      };
      queueMicrotask(() => socket.onopen?.());
      return socket;
    },
    fetch: (async (input: string | URL | Request, init?: RequestInit) => {
      const headers = new Headers(init?.headers);
      if (!String(input).endsWith("/v1/message.create") || headers.get("authorization") !== `Bearer ${token}`) return new Response("no", { status: 401 });
      if (headers.get("satori-platform") !== platform || headers.get("satori-user-id") !== self) return new Response("which account?", { status: 400 });
      const body = JSON.parse(String(init?.body)) as { channel_id: string; content: string };
      sn += 1;
      const id = `m${sn}`;
      sent.push({ room: body.channel_id, text: body.content.replace(/&lt;/g, "<").replace(/&amp;/g, "&"), id });
      return new Response(JSON.stringify([{ id, content: body.content }]));
    }) as typeof fetch,
  };
  return fake;
}
