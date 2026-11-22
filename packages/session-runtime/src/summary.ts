import type { SessionEvent } from "@standin/contracts";
import type { LlmClient } from "sakura-agent";
import { textOf } from "./events.ts";

/** The summary line is at most this long (docs/18 section 2). */
export const SUMMARY_MAX = 80;

const SIGNAL = /^\[signal source=/;
const INSTRUCTION =
  "Write one line (at most 80 characters) that says what the person wants this assistant to do, in the person's own language. " +
  "Name the task, not the conversation. No quotes, no full stop, nothing else.";

/** What the summary is made from: the person's last few messages (not signals) and the agent's last reply. */
export function summarySource(events: readonly SessionEvent[]): { person: string[]; reply: string } | null {
  const person: string[] = [];
  let reply = "";
  for (const event of events) {
    const payload = event.payload as { content?: { type: string; text?: string }[] } | null;
    const text = payload?.content ? textOf(payload.content).trim() : "";
    if (event.type === "message.user" && text && !SIGNAL.test(text)) person.push(text.slice(0, 600));
    if (event.type === "message.assistant" && text) reply = text.slice(0, 600);
  }
  return person.length === 0 ? null : { person: person.slice(-4), reply };
}

/** The agent's last reply of the journal, trimmed; "" when it has none. */
export function lastReply(events: readonly SessionEvent[]): string {
  for (let i = events.length - 1; i >= 0; i -= 1) {
    const event = events[i] as SessionEvent;
    const payload = event.payload as { role?: string; content?: { type: string; text?: string }[] } | null;
    if (event.type === "message.assistant" && payload?.role === "assistant" && payload.content) {
      const text = textOf(payload.content).trim();
      if (text) return text;
    }
  }
  return "";
}

/** One small model call; undefined when the model gives nothing usable (the old summary then stays). */
export async function summarize(llm: LlmClient, source: { person: string[]; reply: string }, signal: AbortSignal): Promise<string | undefined> {
  const transcript = [...source.person.map((text) => `Person: ${text}`), ...(source.reply ? [`Assistant: ${source.reply}`] : [])].join("\n\n");
  let out = "";
  for await (const event of llm.stream(
    { system: INSTRUCTION, messages: [{ role: "user", content: [{ type: "text", text: transcript }], ts: Date.now() }] as never, tools: [], maxTokens: 2000 },
    signal,
  )) {
    if (event.type === "text_delta") out += event.delta;
  }
  const line =
    out
      .split("\n")
      .map((part) => part.trim())
      .find((part) => part !== "") ?? "";
  const clean = line.replace(/^["'“”「」]+|["'“”「」。.]+$/g, "").trim();
  if (clean === "") return undefined;
  return clean.length > SUMMARY_MAX ? `${clean.slice(0, SUMMARY_MAX - 1)}…` : clean;
}
