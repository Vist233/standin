# hook-relay

A Cloudflare Worker that lets outside services (GitHub, calendars, IFTTT) reach a Vesper box that listens on loopback only. It is
maintained and deployed apart from the box (docs/26 3.4); the box only pulls from it.

- **Deploy (the owner):** create a KV namespace, copy `wrangler.toml.example` to `wrangler.toml` with its id, `npx wrangler deploy`,
  then `npx wrangler secret put RELAY_KEY` with a long random key. Optionally put it on a route of your domain.
- **Box:** `OGB_HOOK_RELAY_URL=https://<the worker's address>` and the secret `OGB_HOOK_RELAY_KEY` (the same key). The box pulls every
  15 s; a bot's `hook` tool then gives addresses on the relay.
- **What it does:** stores each delivery (with the token it came with) for up to 7 days; the box checks the token, wakes the bot, and
  acknowledges. The relay knows no hook tokens and decides nothing.
- **Limits:** 64 KB a body, 1000 waiting deliveries, 50 per pull.
- **Test:** `test/relay/hook-relay.test.ts` runs this worker against an in-memory KV.
