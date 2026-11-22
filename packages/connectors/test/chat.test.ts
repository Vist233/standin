// Chat bridges (docs/26 4.3): the Matrix and Satori adapters pass one contract against stand-in servers; the bridge sends the person's
// messages to the right bot as theirs and everyone else's (in watched rooms) as untrusted signals, and keeps its cursor on disk.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { SignalDraft } from "@standin/contracts";
import { afterEach, describe, expect, it } from "vitest";
import { createChatBridge, openMatrix, openSatori, satoriText } from "../src/index.ts";
import { chatSourceContract, createFakeMatrix, createFakeSatori } from "../src/testing/index.ts";

chatSourceContract("matrix", async () => {
  const server = createFakeMatrix();
  const open = () => openMatrix({ homeserver: "https://matrix.example.test", token: server.token, fetch: server.fetch, pollMs: 40 });
  return { source: await open(), say: server.say, sent: () => server.sent, reopen: open, self: server.self };
});

const satoris: { close(): void }[] = [];
afterEach(() => {
  for (const s of satoris.splice(0)) s.close();
});
chatSourceContract("satori", async () => {
  const server = createFakeSatori();
  const open = async () => {
    const made = openSatori({ baseUrl: "http://satori.example.test/satori", token: server.token, fetch: server.fetch, connect: server.connect, pollMs: 40 });
    satoris.push(made);
    return made;
  };
  return { source: await open(), say: server.say, sent: () => server.sent, reopen: open, self: server.self };
});

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});
const until = async (check: () => boolean) => {
  for (let i = 0; i < 200 && !check(); i += 1) await new Promise((r) => setTimeout(r, 10));
};

describe("the chat bridge", () => {
  it("the person's reply reaches the bot that wrote; others in a watched room become untrusted signals; unwatched rooms are ignored", async () => {
    const server = createFakeMatrix();
    const source = await openMatrix({ homeserver: "https://matrix.example.test", token: server.token, fetch: server.fetch, pollMs: 30 });
    const dir = mkdtempSync(join(tmpdir(), "ogb-chat-"));
    dirs.push(dir);
    const received: string[] = [];
    const signals: { bot: string; draft: SignalDraft }[] = [];
    const bridge = createChatBridge({
      name: "matrix",
      source,
      person: ["@me:x", "@whatsapp_861234:x"],
      personRoom: "!dm",
      watch: { "!family": "s_keeper" },
      signal: async (bot, draft) => void signals.push({ bot, draft }),
      cursorFile: join(dir, "cursor.json"),
      retryMs: 10,
    });
    await bridge.start?.({ receive: async (bot, text) => void received.push(`${bot}: ${text}`) });
    await bridge.deliver({ sessionId: "s_scout", from: "Scout", kind: "question", text: "Which city?", at: 1 });
    await bridge.deliver({ sessionId: "s_writer", from: "Writer", kind: "message", text: "Draft ready.", at: 2 });
    expect(server.sent.map((m: { text: string }) => m.text)).toEqual(["❓ Scout: Which city?\n[bot s_scout]", "Writer: Draft ready.\n[bot s_writer]"]);
    await new Promise((r) => setTimeout(r, 50)); // the bridge has its position

    server.say("!dm", "@whatsapp_861234:x", "Shanghai", server.sent[0]?.id); // a reply to Scout's question, from WhatsApp
    server.say("!dm", "@me:x", "thanks"); // no reply: the last bot that wrote
    server.say("!family", "@aunt:x", "Dinner on Sunday?");
    server.say("!random", "@spam:x", "buy now");
    await until(() => received.length === 2 && signals.length === 1);
    bridge.stop?.();
    expect(received).toEqual(["s_scout: Shanghai", "s_scout: thanks"]);
    expect(signals).toHaveLength(1);
    expect(signals[0]).toMatchObject({ bot: "s_keeper", draft: { source: "external:chat-matrix" } });
    expect(signals[0]?.draft.text).toContain("Dinner on Sunday?");
    expect(signals[0]?.draft.id).toMatch(/^chat-matrix-\$e\d+$/);

    // A restart continues from the cursor kept on disk: what was said meanwhile still arrives, nothing twice.
    server.say("!family", "@aunt:x", "said while down");
    const again = createChatBridge({
      name: "matrix",
      source,
      person: ["@me:x"],
      personRoom: "!dm",
      watch: { "!family": "s_keeper" },
      signal: async (bot, draft) => void signals.push({ bot, draft }),
      cursorFile: join(dir, "cursor.json"),
      retryMs: 10,
    });
    await again.start?.({ receive: async () => {} });
    await until(() => signals.length === 2);
    again.stop?.();
    expect(signals.map((s) => s.draft.text.split(": ").at(-1))).toEqual(["Dinner on Sunday?", "said while down"]);
  });

  it("Satori content: elements become text, entities are undone", () => {
    expect(satoriText('<at id="1" name="Ann"/> hi &lt;3 <img src="x"/>')).toBe("@Ann hi <3");
  });
});
