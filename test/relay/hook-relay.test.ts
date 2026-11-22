// The hook relay worker (relay/hook-relay) against an in-memory KV: stores deliveries for anyone with a token, hands them only to the
// box's key, removes what is acknowledged.
import { describe, expect, it } from "vitest";
import worker from "../../relay/hook-relay/worker.mjs";

function memoryKv() {
  const data = new Map<string, string>();
  return {
    data,
    async put(key: string, value: string) {
      data.set(key, value);
    },
    async get(key: string) {
      return data.get(key) ?? null;
    },
    async delete(key: string) {
      data.delete(key);
    },
    async list({ prefix, limit }: { prefix: string; limit: number }) {
      return {
        keys: [...data.keys()]
          .filter((k) => k.startsWith(prefix))
          .sort()
          .slice(0, limit)
          .map((name) => ({ name })),
      };
    },
  };
}
const env = () => ({ HOOKS: memoryKv(), RELAY_KEY: "relay-key-0123456789" });
const call = (e: ReturnType<typeof env>, path: string, init: RequestInit = {}) =>
  worker.fetch(new Request(`https://relay.example.test${path}`, init), e) as Promise<Response>;
const box = { authorization: "Bearer relay-key-0123456789" };

describe("hook relay", () => {
  it("keeps a delivery with its token and delivery id; the box pulls it with its key and acknowledges it", async () => {
    const e = env();
    const posted = await call(e, "/hooks/s_bot1/github?token=t-1", { method: "POST", body: '{"a":1}', headers: { "x-github-delivery": "d-9" } });
    expect(posted.status).toBe(202);
    expect((await call(e, "/pull")).status).toBe(401);
    expect((await call(e, "/pull", { headers: { authorization: "Bearer wrong" } })).status).toBe(401);
    const { items } = (await (await call(e, "/pull", { headers: box })).json()) as {
      items: { id: string; bot: string; hook: string; token: string; body: string; delivery: string }[];
    };
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({ bot: "s_bot1", hook: "github", token: "t-1", body: '{"a":1}', delivery: "d-9" });
    await call(e, "/ack", { method: "POST", headers: box, body: JSON.stringify({ ids: [items[0]?.id] }) });
    expect(e.HOOKS.data.size).toBe(0);
  });

  it("refuses a delivery without a token, a GET, and a body over 64 KB", async () => {
    const e = env();
    expect((await call(e, "/hooks/s_bot1/github", { method: "POST", body: "{}" })).status).toBe(401);
    expect((await call(e, "/hooks/s_bot1/github?token=t")).status).toBe(405);
    expect((await call(e, "/hooks/s_bot1/github?token=t", { method: "POST", body: "x".repeat(65 * 1024) })).status).toBe(413);
    expect(e.HOOKS.data.size).toBe(0);
  });
});
