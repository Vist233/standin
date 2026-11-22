// Webhooks through the gateway (docs/26 3.4): outside the API's own token, opened by the hook's token; the delivery id is passed on;
// every refusal looks the same; the body is bounded.
import { afterEach, describe, expect, it } from "vitest";
import { type GatewayRig, type RigOptions, startRig } from "./rig.ts";

const rigs: GatewayRig[] = [];
async function rig(options: RigOptions = {}) {
  const made = await startRig(options);
  rigs.push(made);
  return made;
}
afterEach(async () => {
  for (const r of rigs.splice(0)) await r.cleanup();
});
const post = (r: GatewayRig, path: string, body: string, headers: Record<string, string> = {}) =>
  fetch(`http://127.0.0.1:${r.port}${path}`, { method: "POST", headers: { "content-type": "application/json", ...headers }, body });

describe("webhooks", () => {
  it("a delivery with the hook's token (in the address or as a bearer) reaches the bot with its delivery id; even when the API has its own token", async () => {
    const r = await rig({ token: "api-tok-0123" });
    r.runtime.add("s_bot1", "Bot");
    const first = await post(r, "/hooks/s_bot1/github?token=good", '{"action":"opened"}', { "x-github-delivery": "d-1" });
    expect(first.status).toBe(202);
    const second = await post(r, "/hooks/s_bot1/github", "ping", { authorization: "Bearer good" });
    expect(second.status).toBe(202);
    expect(r.runtime.calls.filter((c) => c.startsWith("receiveHook"))).toEqual([
      'receiveHook:s_bot1:github:d-1:{"action":"opened"}',
      "receiveHook:s_bot1:github:-:ping",
    ]);
  });

  it("a wrong token, an unknown bot and a GET all fail without saying which; a body over 64 KB is refused", async () => {
    const r = await rig();
    r.runtime.add("s_bot1", "Bot");
    expect((await post(r, "/hooks/s_bot1/github?token=bad", "{}")).status).toBe(404);
    expect((await post(r, "/hooks/s_none/github?token=good", "{}")).status).toBe(404);
    expect((await fetch(`http://127.0.0.1:${r.port}/hooks/s_bot1/github?token=good`)).status).toBe(405);
    expect((await post(r, "/hooks/s_bot1/github?token=good", "x".repeat(65 * 1024))).status).toBe(413);
    expect((await post(r, "/hooks/s_bot1/Bad_Name?token=good", "{}")).status).not.toBe(202); // not a hook address at all
  });
});
