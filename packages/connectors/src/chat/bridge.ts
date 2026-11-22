import type { Channel, ChannelInbox, Outgoing, SignalDraft } from "@vesper/contracts";
import { cursorIn } from "../event-source.ts";
import type { ChatEvent, ChatSource } from "./types.ts";

export interface ChatBridgeOptions {
  /** A short name (`matrix`, `satori`): the channel is `chat-<name>`, others' messages are `external:chat-<name>`. */
  name: string;
  source: ChatSource;
  /** The person: their ids on the bridge (one per network the bridge reaches). Only these come in as the person. */
  person: readonly string[];
  /** Where the bots write to the person (a direct room). */
  personRoom: string;
  /** Rooms whose other people a bot watches: room → bot. Messages of others in rooms not listed are ignored. */
  watch?: Readonly<Record<string, string>>;
  /** How others' messages reach a bot (the runtime's `signal`). */
  signal(sessionId: string, draft: SignalDraft): Promise<void>;
  /** Where the position is kept across restarts. */
  cursorFile?: string | undefined;
  /** What is written to the person (default: every message, question and notice). */
  kinds?: Outgoing["kind"][];
  log?: (entry: Record<string, unknown>) => void;
  /** Pause after a failed call (default 5000 ms). */
  retryMs?: number;
}

const TAG = /\[bot ([A-Za-z0-9_-]{1,80})\]/;
const clean = (text: string, max: number) =>
  text
    .split("")
    .map((char) => (char.charCodeAt(0) < 32 || char.charCodeAt(0) === 127 ? " " : char))
    .join("")
    .replace(/ +/g, " ")
    .trim()
    .slice(0, max);

/**
 * A chat bridge as a channel (contracts/channels.ts) and a source of signals. The person's own messages are the channel's input:
 * routed to the bot named by `[bot <id>]` in the message it replies to, else to the last bot that wrote to them. Everyone else's
 * messages in a watched room are untrusted signals to that room's bot (a one-line notice: who, where, the text). A bot's message
 * goes to the person's room, ending with `[bot <id>]`.
 */
export function createChatBridge(options: ChatBridgeOptions): Channel {
  const person = new Set(options.person);
  const kinds = new Set(options.kinds ?? ["message", "question", "notice"]);
  const sentBy = new Map<string, string>(); // message id → bot, for replies
  let lastBot: string | undefined;
  let controller: AbortController | undefined;
  const log = options.log ?? (() => {});

  async function handle(event: ChatEvent, inbox: ChannelInbox): Promise<void> {
    if (event.sender === options.source.self) return;
    if (person.has(event.sender)) {
      const bot = (event.replyTo && sentBy.get(event.replyTo)) || TAG.exec(event.text)?.[1] || lastBot;
      if (!bot) return log({ level: "warn", message: "a message from the person names no bot and no bot wrote first", bridge: options.name });
      lastBot = bot;
      await inbox.receive(bot, event.text.replace(TAG, "").trim());
      return;
    }
    const bot = options.watch?.[event.room];
    if (!bot) return;
    await options.signal(bot, {
      id: `chat-${options.name}-${event.id}`.slice(0, 200),
      source: `external:chat-${options.name}`,
      text: `Chat message from ${clean(event.senderName ? `${event.senderName} (${event.sender})` : event.sender, 160)} in ${clean(event.room, 120)}: ${clean(event.text, 2000)}`,
    });
  }

  return {
    name: `chat-${options.name}`,
    async deliver(message) {
      if (!kinds.has(message.kind)) return;
      const prefix = message.kind === "question" ? "❓ " : "";
      const { id } = await options.source.send(options.personRoom, `${prefix}${message.from}: ${message.text}\n[bot ${message.sessionId}]`);
      sentBy.set(id, message.sessionId);
      if (sentBy.size > 2000) sentBy.delete(sentBy.keys().next().value as string);
      lastBot = message.sessionId;
    },
    start(inbox) {
      const position = cursorIn(options.cursorFile);
      let cursor = position.after;
      controller = new AbortController();
      const { signal } = controller;
      void (async () => {
        while (!signal.aborted) {
          try {
            const batch = await options.source.next(cursor, signal);
            if (signal.aborted) break; // stopped while waiting: the next start handles this batch from the kept cursor
            for (const event of batch.events) {
              await handle(event, inbox).catch((error) => log({ level: "warn", message: "a chat message could not be delivered", error: String(error) }));
            }
            cursor = batch.cursor;
            position.onCursor?.(cursor);
          } catch (error) {
            if (signal.aborted) break;
            log({ level: "warn", message: "the chat bridge did not answer", bridge: options.name, error: String(error) });
            await new Promise((resolve) => setTimeout(resolve, options.retryMs ?? 5000));
          }
        }
      })();
    },
    stop() {
      controller?.abort();
      controller = undefined;
    },
  };
}
