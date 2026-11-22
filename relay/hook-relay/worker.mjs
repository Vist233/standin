// The hook relay (opengrokbot docs/26 3.4): a Cloudflare Worker that takes webhooks from the internet and keeps them until the box
// pulls them. The box listens on loopback only, so it is never reached from outside; it asks here instead.
// The relay knows no hook tokens: it stores the token with the delivery, and the box checks it (one place decides).
//   POST /hooks/<bot>/<hook>?token=...   anyone (GitHub, a calendar, IFTTT): stored, 202
//   GET  /pull                           the box (Authorization: Bearer RELAY_KEY): up to 50 waiting deliveries
//   POST /ack   { "ids": [...] }         the box: removes them
// Storage: one KV namespace bound as HOOKS; deliveries expire after 7 days. Limits: 64 KB a body, 1000 waiting.
const MAX_BODY = 64 * 1024;
const MAX_WAITING = 1000;
const TTL_SECONDS = 7 * 24 * 3600;
const HOOK_PATH = /^\/hooks\/([A-Za-z0-9_-]{1,64})\/([a-z][a-z0-9-]{0,31})$/;

const json = (value, status = 200) => new Response(JSON.stringify(value), { status, headers: { "content-type": "application/json" } });

async function sameKey(given, expected) {
  if (!expected || !given) return false;
  const digest = async (text) => new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text)));
  const [a, b] = await Promise.all([digest(given), digest(expected)]);
  let diff = 0;
  for (let i = 0; i < a.length; i += 1) diff |= a[i] ^ b[i];
  return diff === 0;
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const hook = HOOK_PATH.exec(url.pathname);
    if (hook) {
      if (request.method !== "POST") return json({ error: "webhooks are POST" }, 405);
      const token = url.searchParams.get("token") ?? /^Bearer (.{1,200})$/.exec(request.headers.get("authorization") ?? "")?.[1] ?? "";
      if (!token) return json({ error: "no token" }, 401);
      const body = await request.text();
      if (body.length > MAX_BODY) return json({ error: "body too large" }, 413);
      const waiting = await env.HOOKS.list({ prefix: "q:", limit: MAX_WAITING });
      if (waiting.keys.length >= MAX_WAITING) return json({ error: "too many waiting deliveries" }, 503);
      const delivery = request.headers.get("x-github-delivery") ?? request.headers.get("idempotency-key") ?? request.headers.get("x-delivery-id") ?? undefined;
      const id = `q:${String(Date.now()).padStart(15, "0")}:${crypto.randomUUID()}`;
      await env.HOOKS.put(id, JSON.stringify({ bot: hook[1], hook: hook[2], token, body, delivery, at: Date.now() }), { expirationTtl: TTL_SECONDS });
      return json({ accepted: true }, 202);
    }
    if (!(await sameKey(/^Bearer (.{1,512})$/.exec(request.headers.get("authorization") ?? "")?.[1], env.RELAY_KEY))) return json({ error: "denied" }, 401);
    if (url.pathname === "/pull" && request.method === "GET") {
      const listed = await env.HOOKS.list({ prefix: "q:", limit: 50 });
      const items = [];
      for (const key of listed.keys) {
        const value = await env.HOOKS.get(key.name);
        if (value) items.push({ id: key.name, ...JSON.parse(value) });
      }
      return json({ items });
    }
    if (url.pathname === "/ack" && request.method === "POST") {
      const { ids } = await request.json();
      for (const id of Array.isArray(ids) ? ids.slice(0, 100) : []) if (typeof id === "string" && id.startsWith("q:")) await env.HOOKS.delete(id);
      return json({ ok: true });
    }
    return json({ error: "not found" }, 404);
  },
};
