import type { Channel, ChannelInbox } from "@standin/contracts";

export interface TelegramChannelOptions {
  /** The bot's token (from @BotFather). A secret: it is never logged. */
  token: string;
  /** The person's own chat with the bot: the only chat messages go to, and the only one taken in. */
  chatId: string;
  /** Default https://api.telegram.org (tests point it at a stand-in). */
  apiBase?: string;
  /** How long one long poll waits for a message, in seconds (default 25). */
  pollSeconds?: number;
}

const TAG = /\[bot ([A-Za-z0-9_-]{1,80})\]/;

interface Update {
  update_id: number;
  message?: { chat: { id: number | string }; text?: string; reply_to_message?: { text?: string } };
}

/**
 * The person's Telegram chat with a bot account as a channel (contracts/channels.ts). Out: every message, question and notice, ending with
 * `[bot <id>]`. In: the person's messages in that chat (long polling): a reply to a bot's message goes to that bot, any other message to the
 * bot that wrote last. Messages from any other chat are ignored.
 */
export function createTelegramChannel(options: TelegramChannelOptions): Channel {
  const base = `${options.apiBase ?? "https://api.telegram.org"}/bot${options.token}`;
  const chat = String(options.chatId);
  let lastBot: string | undefined;
  let polling: AbortController | undefined;

  async function call<T>(method: string, body: Record<string, unknown>, signal?: AbortSignal): Promise<T> {
    const response = await fetch(`${base}/${method}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
      ...(signal ? { signal } : {}),
    });
    const data = (await response.json()) as { ok: boolean; result?: T; description?: string };
    if (!data.ok) throw new Error(`Telegram ${method} failed: ${data.description ?? response.status}`); // the token is in the URL, never in this text
    return data.result as T;
  }

  async function poll(inbox: ChannelInbox, signal: AbortSignal): Promise<void> {
    let offset = 0;
    while (!signal.aborted) {
      try {
        const updates = await call<Update[]>("getUpdates", { offset, timeout: options.pollSeconds ?? 25, allowed_updates: ["message"] }, signal);
        for (const update of updates) {
          offset = update.update_id + 1;
          const message = update.message;
          if (!message?.text || String(message.chat.id) !== chat) continue;
          const sessionId = TAG.exec(message.reply_to_message?.text ?? "")?.[1] ?? lastBot;
          if (sessionId) await inbox.receive(sessionId, message.text).catch(() => undefined);
        }
      } catch {
        if (signal.aborted) return;
        await new Promise((resolve) => setTimeout(resolve, 2000)); // the network or the API is down: try again a little later
      }
    }
  }

  return {
    name: "telegram",
    async deliver(message) {
      lastBot = message.sessionId;
      const label = message.kind === "question" ? "❓ " : message.kind === "notice" ? "🔔 " : "";
      await call("sendMessage", { chat_id: chat, text: `${label}${message.from}: ${message.text}\n\n[bot ${message.sessionId}]` });
    },
    start(inbox) {
      polling = new AbortController();
      void poll(inbox, polling.signal);
    },
    stop() {
      polling?.abort();
      polling = undefined;
    },
  };
}
