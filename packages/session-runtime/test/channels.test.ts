// Channels (contracts/channels.ts): the person's messages come in through any channel as their own; what the person should get (a message,
// a question) goes out on every channel; a channel that fails never stops the bot. The page is the first channel.
import type { Channel, ChannelInbox, Outgoing } from "@vesper/contracts";
import { afterEach, describe, expect, it } from "vitest";
import { createRig, type Rig } from "../src/testing/index.ts";

const rigs: Rig[] = [];
afterEach(async () => {
  for (const rig of rigs.splice(0)) await rig.cleanup();
});

describe("channels", () => {
  it("a message through a channel is the person's own; the bot's message and question go out on it; a failing channel does not matter", async () => {
    let inbox: ChannelInbox | undefined;
    const sent: Outgoing[] = [];
    const chat: Channel = {
      name: "chat",
      start(given) {
        inbox = given;
      },
      async deliver(message) {
        sent.push(message);
      },
      stop() {
        inbox = undefined;
      },
    };
    const broken: Channel = { name: "broken", deliver: async () => Promise.reject(new Error("no network")) };
    const rig = createRig({
      runtime: { channels: [broken, chat] },
      profiles: { default: "general", profiles: { general: { plugins: [], alwaysDeclaredTools: ["send_to_user", "ask_human"] } } },
      script: (_request, index) =>
        [
          { toolCalls: [{ name: "send_to_user", args: { text: "Working on it." } }] },
          { toolCalls: [{ name: "ask_human", args: { question: "Which city?", kind: "choice" } }] },
          { text: "Asked." },
        ][index] ?? { text: "done" },
    });
    rigs.push(rig);
    const bot = await rig.runtime.createSession({ title: "Scout" });
    await rig.runtime.resumeAll();
    expect(inbox).toBeDefined();
    await inbox?.receive(bot.id, "find me a flat");
    await rig.runtime.whenIdle(bot.id);

    const events = await rig.runtime.read(bot.id);
    expect(JSON.stringify(events.find((e) => e.type === "message.user")?.payload)).toContain("find me a flat"); // as if typed on the page
    expect(sent.map(({ kind, text, from }) => ({ kind, text, from }))).toEqual([
      { kind: "message", text: "Working on it.", from: "Scout" },
      { kind: "question", text: "Which city?", from: "Scout" },
    ]);
    expect(events.filter((e) => e.type === "run.finished").map((e) => (e.payload as { reason: string }).reason)).toEqual(["end"]);
    await rig.runtime.close();
    expect(inbox).toBeUndefined(); // stopped with the runtime
  });
});
