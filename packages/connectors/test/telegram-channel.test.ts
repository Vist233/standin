import { createServer, type Server } from "node:http";
import { afterEach, describe, expect, it } from "vitest";
import { createTelegramChannel } from "../src/index.ts";

let server: Server | undefined;
afterEach(() => server?.close());

/** A stand-in for the Telegram bot API: records sendMessage, answers getUpdates from a queue. */
async function fakeTelegram() {
  const sent: Record<string, unknown>[] = [];
  const queue: unknown[] = [];
  const own = createServer(async (request, response) => {
    let body = "";
    for await (const chunk of request) body += chunk;
    const input = JSON.parse(body || "{}") as Record<string, unknown>;
    response.setHeader("content-type", "application/json");
    if (!request.url?.startsWith("/bot")) response.end(JSON.stringify({ ok: false, description: "Not Found" }));
    else if (request.url.endsWith("/sendMessage")) {
      sent.push(input);
      response.end(JSON.stringify({ ok: true, result: { message_id: sent.length } }));
    } else if (request.url.endsWith("/getUpdates")) {
      const offset = Number(input.offset ?? 0);
      const ready = queue.filter((u) => (u as { update_id: number }).update_id >= offset);
      if (ready.length === 0) await new Promise((resolve) => setTimeout(resolve, 30));
      response.end(JSON.stringify({ ok: true, result: ready }));
    } else response.end(JSON.stringify({ ok: false, description: "Not Found" }));
  });
  server = own;
  await new Promise<void>((resolve) => own.listen(0, "127.0.0.1", resolve));
  return { sent, queue, base: `http://127.0.0.1:${(own.address() as { port: number }).port}` };
}

describe("the Telegram channel", () => {
  it("sends every kind to the person's chat, tagged; takes in the person's messages only, routed by reply or to the last bot", async () => {
    const telegram = await fakeTelegram();
    const channel = createTelegramChannel({ token: "123:secret", chatId: "42", apiBase: telegram.base, pollSeconds: 1 });
    await channel.deliver({ sessionId: "s_a", from: "Scout", kind: "question", text: "Which city?", at: 1 });
    await channel.deliver({ sessionId: "s_b", from: "Clerk", kind: "message", text: "Filed it.", at: 2 });
    expect(telegram.sent).toEqual([
      { chat_id: "42", text: "❓ Scout: Which city?\n\n[bot s_a]" },
      { chat_id: "42", text: "Clerk: Filed it.\n\n[bot s_b]" },
    ]);
    const received: [string, string][] = [];
    channel.start?.({ receive: async (sessionId, text) => void received.push([sessionId, text]) });
    telegram.queue.push(
      { update_id: 1, message: { chat: { id: 42 }, text: "Oslo", reply_to_message: { text: "❓ Scout: Which city?\n\n[bot s_a]" } } },
      { update_id: 2, message: { chat: { id: 42 }, text: "thanks" } },
      { update_id: 3, message: { chat: { id: 7 }, text: "I am not the person" } },
    );
    await expect.poll(() => received.length, { timeout: 3000 }).toBe(2);
    expect(received).toEqual([
      ["s_a", "Oslo"],
      ["s_b", "thanks"],
    ]);
    channel.stop?.();
  });

  it("says when the API refuses, without the token", async () => {
    const telegram = await fakeTelegram();
    const channel = createTelegramChannel({ token: "123:secret", chatId: "42", apiBase: `${telegram.base}/wrong` });
    const error = await channel.deliver({ sessionId: "s_a", from: "Scout", kind: "notice", text: "x", at: 1 }).catch((caught: Error) => caught);
    expect(String(error)).toContain("sendMessage failed");
    expect(String(error)).not.toContain("secret");
  });
});
