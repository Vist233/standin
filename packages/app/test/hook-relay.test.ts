// The puller of the hook relay: hands each waiting delivery to the runtime and acknowledges all of them, accepted or not.
import { describe, expect, it } from "vitest";
import { createHookRelayPuller } from "../src/hook-relay.ts";

describe("hook relay puller", () => {
  it("pulls with the key, passes each delivery on, acknowledges every one; a refused delivery is logged, not retried", async () => {
    const waiting = [
      { id: "q:1", bot: "s_a", hook: "github", token: "good", body: "{}", delivery: "d-1" },
      { id: "q:2", bot: "s_a", hook: "github", token: "bad", body: "{}" },
    ];
    const acked: string[] = [];
    const seenKeys: string[] = [];
    const fakeFetch = (async (input: string | URL | Request, init?: RequestInit) => {
      seenKeys.push(new Headers(init?.headers).get("authorization") ?? "");
      if (String(input).endsWith("/pull")) return new Response(JSON.stringify({ items: waiting.splice(0) }));
      acked.push(...(JSON.parse(String(init?.body)) as { ids: string[] }).ids);
      return new Response("{}");
    }) as typeof fetch;
    const received: string[] = [];
    const logs: Record<string, unknown>[] = [];
    const puller = createHookRelayPuller({
      url: "https://relay.example.test/",
      key: "relay-key",
      fetch: fakeFetch,
      log: (entry) => void logs.push(entry),
      receive: async (bot, hook, token, _body, delivery) => {
        received.push(`${bot}/${hook}/${delivery ?? "-"}`);
        return token === "good";
      },
    });
    expect(await puller.pullOnce()).toBe(1);
    expect(received).toEqual(["s_a/github/d-1", "s_a/github/-"]);
    expect(acked).toEqual(["q:1", "q:2"]);
    expect(seenKeys.every((k) => k === "Bearer relay-key")).toBe(true);
    expect(logs.some((l) => String(l.message).includes("refused"))).toBe(true);
    expect(await puller.pullOnce()).toBe(0); // nothing waiting: no acknowledgement call
    expect(acked).toHaveLength(2);
  });
});
