import type { SessionEvent } from "@standin/contracts";
import { describe, expect, it } from "vitest";
import { createSessionSearchTool, searchEvents } from "../src/session-search.ts";

let seq = 0;
const ev = (type: string, payload: unknown): SessionEvent =>
  ({ v: 1, seq: ++seq, at: 1_700_000_000_000 + seq, sessionId: "s_a", type, payload }) as SessionEvent;
const said = (role: "user" | "assistant", text: string) =>
  ev(role === "user" ? "message.user" : "message.assistant", { role, content: [{ type: "text", text }], ts: 1 });

const vega = {
  bot: { id: "s_a", title: "Vega" },
  events: [said("user", "My blog is at blog.example.test, post on Fridays"), said("assistant", "Noted: Friday posts.")],
};
const lyra = {
  bot: { id: "s_b", title: "Lyra" },
  events: [
    said("user", "[signal source=system trust=trusted id=x]\n| Scheduled job about the blog"),
    said("assistant", "The blog post is live on blog.example.test"),
  ],
};

describe("searching the conversations of all bots", () => {
  it("finds messages with every word of the query, names the bot, and skips signals", () => {
    const hits = searchEvents([vega, lyra], "blog example");
    expect(hits.map((h) => `${h.title}:${h.who}`).sort()).toEqual(["Lyra:agent", "Vega:person"]); // the signal mentioning the blog is not a hit
    expect(hits.every((h) => h.snippet.includes("blog"))).toBe(true);
    expect(searchEvents([vega, lyra], "Friday")).toHaveLength(2);
    expect(searchEvents([vega, lyra], "nothing-like-this")).toEqual([]);
    expect(searchEvents([vega], "   ")).toEqual([]);
  });

  it("is a tool that reads every bot and survives one that cannot be read", async () => {
    const tool = createSessionSearchTool({
      bots: async () => [vega.bot, lyra.bot, { id: "s_gone", title: "Gone" }],
      read: async (id) => {
        if (id === "s_gone") throw new Error("no such session");
        return id === "s_a" ? vega.events : lyra.events;
      },
    });
    const result = await tool.execute({ query: "Friday" }, {} as never);
    const found = JSON.parse((result.content[0] as { text: string }).text) as { title: string }[];
    expect(found.map((h) => h.title)).toEqual(["Vega", "Vega"]);
    expect((await tool.execute({ query: "" }, {} as never)).isError).toBe(true);
  });
});
