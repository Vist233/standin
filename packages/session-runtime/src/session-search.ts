import type { SessionEvent } from "@standin/contracts";
import type { Tool } from "sakura-agent";
import { textOf } from "./events.ts";
import { text } from "./tool-result.ts";

const MAX_HITS = 8;
const SNIPPET = 240;

export interface SearchableBot {
  id: string;
  title: string;
}

export interface SessionHit {
  bot: string;
  title: string;
  seq: number;
  at: string;
  who: "person" | "agent";
  snippet: string;
}

const words = (value: string) => value.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? [];

/** The words of the conversation (the person's and the agent's messages) that match every word of the query, best first. */
export function searchEvents(bots: readonly { bot: SearchableBot; events: readonly SessionEvent[] }[], query: string, max = MAX_HITS): SessionHit[] {
  const wanted = [...new Set(words(query))];
  if (wanted.length === 0) return [];
  const scored: { hit: SessionHit; score: number }[] = [];
  for (const { bot, events } of bots) {
    for (const event of events) {
      const who = event.type === "message.user" ? "person" : event.type === "message.assistant" || event.type === "agent.message" ? "agent" : null;
      if (!who) continue;
      const payload = event.payload as { content?: { type: string; text?: string }[]; text?: string; role?: string } | null;
      if (event.type === "message.assistant" && payload?.role !== "assistant") continue;
      const body = (payload?.content ? textOf(payload.content) : (payload?.text ?? "")).trim();
      if (!body || body.startsWith("[signal source=")) continue;
      const lower = body.toLowerCase();
      if (!wanted.every((word) => lower.includes(word))) continue;
      const score = wanted.reduce((sum, word) => sum + lower.split(word).length - 1, 0);
      const first = Math.min(...wanted.map((word) => lower.indexOf(word)));
      const start = Math.max(0, first - 60);
      const snippet = `${start > 0 ? "…" : ""}${body.slice(start, start + SNIPPET).replace(/\s+/g, " ")}${start + SNIPPET < body.length ? "…" : ""}`;
      scored.push({
        hit: { bot: bot.id, title: bot.title, seq: event.seq, at: new Date(event.at).toISOString(), who, snippet },
        score: score + event.seq / 1e9,
      });
    }
  }
  return scored
    .sort((a, b) => b.score - a.score)
    .slice(0, max)
    .map((entry) => entry.hit);
}

/** `session_search`: finds earlier conversations of all the person's bots (this one included). */
export function createSessionSearchTool(source: { bots: () => Promise<SearchableBot[]>; read: (botId: string) => Promise<readonly SessionEvent[]> }): Tool {
  return {
    name: "session_search",
    description:
      "Searches the conversations of all the person's bots (this one too) for words: what was asked, decided or found before. Returns up to 8 hits with the bot's name and a snippet. Use it before asking the person something they may have told another bot.",
    parameters: { type: "object", properties: { query: { type: "string" } }, required: ["query"] },
    effect: "read",
    replay: "safe",
    async execute(args) {
      const query = typeof (args as { query?: unknown } | null)?.query === "string" ? ((args as { query: string }).query as string) : "";
      if (words(query).length === 0) return text("'query' must contain words to look for.", true);
      const bots = await source.bots();
      const read = await Promise.all(bots.map(async (bot) => ({ bot, events: await source.read(bot.id).catch(() => []) })));
      const hits = searchEvents(read, query);
      return text(hits.length === 0 ? "Nothing found." : JSON.stringify(hits));
    },
  };
}
