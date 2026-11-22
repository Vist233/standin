# @standin/gateway

HTTP API, server-sent events with `Last-Event-ID`, a relay for the live browser view and the take-over desktop, and the static page. Thin on purpose: every route calls one method of the session runtime (or the workspace host) and returns; it knows no agent internals.

**Imports:** `contracts`, `session-runtime` (types and `workspaceIdFor`), `workspace-client` (tests only: the fake host). Keeps no session state of its own: take-over, pending approvals and questions all come from the runtime and its journal. Node built-ins only; no web framework, no WebSocket library.
**Never knows:** how a session works inside, models, plugins, the daemon's protocol.

## Using it
```ts
const gateway = createGateway({
  runtime,                    // a SessionRuntime (or any object with the methods of GatewayRuntime)
  workspaces: host,           // a WorkspaceHost (workspace-client): `view.open` and `takeover.open` for the desk view and take-over
  startup: () => lines,       // the start-up report lines, shown by the page when something is not up
  catalog: () => ({ profiles, defaultProfile, models }),             // names for the new-session form
  staticDir,                  // packages/web/src
  token,                      // optional bearer token
});
await gateway.listen({ port: 8080 });   // 127.0.0.1 unless you say otherwise
```
`listen({ host })` with a non-loopback address (needed inside a container, where a published port reaches `eth0`, not `lo`) **throws unless a token is configured**: the error "an open port without a password" cannot be made.

## Rules for every request
| Check | What | Why |
|---|---|---|
| Host | must be `127.0.0.1`, `localhost`, `[::1]` or a name in `extraHosts` (any port) → else 403 | DNS rebinding: a hostile page whose name resolves to 127.0.0.1 sends its own name |
| Origin | if present, must equal `http(s)://<Host header>` → else 403. Required on WebSocket upgrades | cross-site and cross-port requests from the owner's browser |
| CORS | no `Access-Control-*` header is ever sent; no preflight is answered | nothing outside this origin may read a response |
| Bearer | when `token` is set, every `/api/*` call except `/api/health` needs `Authorization: Bearer <token>` (constant-time comparison). The page itself is public so it can load and ask for the token | |
| Body | at most `maxBodyBytes` (64 KiB) → else 413; `Content-Type: application/json`; a JSON object | |
| Static | decoded once; no NUL, backslash, dot segment or dot-file; real path must stay inside the real root (links that leave it are refused); only known extensions | no directory traversal |
| Headers | `nosniff`, `no-referrer`, `X-Frame-Options: DENY`, `Cache-Control: no-store` on the API; a strict CSP on the page (`script-src 'self'`, no inline script or style) | |

Errors are `{ "error": { "kind", "message" } }` with the kind from `contracts` (`invalid_input` 400, `denied` 403 (401 for a bad token), `not_found` 404, `conflict` 409, `unavailable` 503, bodies too large 413). An `internal` or `corrupt` error and any unexpected exception show only "the server failed; see its log"; the text goes to the log.

## API (version 2; `GET /api/health` reports `api: 2`)
`:id` is a session id (`[A-Za-z0-9_-]{1,64}`). All bodies are JSON.

| Method and path | Body | Answer |
|---|---|---|
| `GET /api/health` | | `{ ok, api, ready }` (no token needed) |
| `GET /api/options` | | `{ profiles, defaultProfile?, models, takeover, liveView, files, limits: { fileBytes, files }, startup }`; `startup` is the start-up report lines (`{ level, text }`) |
| `GET /api/sessions` | | `{ sessions: [{ id, title, status, createdAt, state: { run, held, queued } \| null, takeover, pending, lastRunEnd }] }`. `pending` counts what waits for the person (approvals without a decision, questions without an answer), `lastRunEnd` is the reason of the last `run.finished`; both are folded incrementally from the journal (only new events are read at each poll) |
| `POST /api/sessions` | `{ title?, profile?, model?, extraPlugins? }` (exactly the runtime's four fields; **nothing else is read**, a field about review or redaction is refused 403 by the profiles module) | 201 `{ session }` |
| `GET /api/sessions/:id` | | `{ session, state, approvals, takeover: { since, viewed } \| null, pending, lastRunEnd }` |
| `POST /api/sessions/:id/resume` | | `{ session }` (reopens a stored session; idempotent) |
| `POST /api/sessions/:id/messages` | `{ text, id?, attachments?: [{ name, size }] }` (each attachment must be a file of this session with that size; at most 20) (`id` makes a retry safe) | 202. **One door for the person's words**: the router decides whether it steers a running agent, starts a run, ends a Stop hold, or answers an `ask_human` question. There is no separate "steer" or "answer" endpoint; the page only labels the box by `state.run` |
| `POST /api/sessions/:id/stop` | `{ id? }` | 202. The session is held: nothing starts by itself until the next message (`state.held`, `state.queued`) |
| `GET /api/sessions/:id/approvals` | | `{ approvals: [{ id, tool, args }] }` |
| `POST /api/sessions/:id/approvals/:aid` | `{ approved: boolean }` | 200; repeating a decision changes nothing |
| `GET /api/sessions/:id/history?after=N` | | `{ events }` with `seq > N` |
| `GET /api/sessions/:id/events` | header `Last-Event-ID: N` or `?after=N` | `text/event-stream`, see below |
| `POST /api/sessions/:id/live-view` | `{}` | `{ url }`: a one-time WebSocket URL for `/ws/:id/view` (a **view-only** picture of the workspace's display). Behind it the gateway asks the desk-daemon for a `view` ticket (`view.open`). 503 `unavailable` when the workspace does not exist yet |
| `POST /api/sessions/:id/takeover` | | `{ url, since }`: `runtime.openTakeover` (holds the session, journals `takeover.opened`), then `takeover.open` for a **control** ticket; returns a one-time URL for `/ws/:id/takeover`. If a take-over is already open (a page reload) it joins it: a fresh ticket, no second `takeover.opened`. If the daemon gives no ticket, the hold is released again |
| `POST /api/sessions/:id/handback` | `{ note? }` | `{ ok, wasOpen }`: `runtime.closeTakeover(note)` (journals `takeover.closed {note, viewed}` and tells the agent the true hand-back text), then `takeover.close` drops the daemon's stream. A repeat says `wasOpen: false` |
| `POST /api/sessions/:id/text` | `{ text }` | `{ inserted }`: types text (any Unicode, at most 2000 characters) into the focused field of the page in the workspace's browser through `host.input.insertText`; 409 unless a take-over is open; the text is never logged |
| `POST /api/sessions/:id/files` | raw file body; `x-file-name` header (percent-encoded UTF-8) | 201 `{ file: { name, size, modifiedAt } }` (the name as stored: sanitised, a taken name gets `-2`, nothing is overwritten). At most 25 MB per file (413) and 20 files per session (409); the content is never logged, only name and size |
| `GET /api/sessions/:id/files` | | `{ files: [{ name, size, modifiedAt }] }` |
| `GET /api/sessions/:id/files/:name` | | the bytes as `application/octet-stream` with `Content-Disposition: attachment`, `nosniff` and `no-store`; only a name that is already clean exists (paths and dot-files are 404) |
| `DELETE /api/sessions/:id` | | `{ ok }`: `runtime.deleteSession`; harmless for a session that does not exist |

## Event stream
`GET /api/sessions/:id/events` replays every journal event with `seq` greater than `Last-Event-ID`, then follows live. One frame per event:
```
id: 42
data: {"v":1,"seq":42,"at":1731345678901,"sessionId":"s_ab12","type":"message.assistant","payload":{…}}

```
`retry: 2000` is sent first; `: ping` comment lines every 15 s while quiet. The source is the journal's gap-free subscription, written one event at a time; the gateway waits for the socket to drain before the next write (backpressure to the journal), and drops a client that does not read for 30 s (it reconnects from its last id and loses nothing). A browser's `EventSource` cannot send an `Authorization` header, so the page reads the stream with `fetch` and sends `Last-Event-ID` itself. At most 200 streams at once (503 with `Retry-After`).

## WebSocket relay (`/ws/:id/view`, `/ws/:id/takeover`)
A browser cannot put a header on a WebSocket, and a long-lived token must not travel in a URL. So the page asks the API (with the bearer token) for a **one-time ticket**: it works once, for that session and that kind, for 30 s. The upgrade also needs a valid Origin. For every page ticket the gateway has already fetched a ticket of its own from the desk-daemon (`view.open` or `takeover.open`; the daemon returns the same one while valid, so a daemon ticket is never given to two pages as a page ticket). On upgrade the gateway opens a loopback connection to the daemon's stream, repeats the handshake with only the WebSocket headers (no cookie, no authorization), an Origin the stream accepts and the daemon's token in the query, and from the `101` on only moves bytes both ways.
- `view`: the daemon's token has mode `view`; **the daemon's bridge, not the gateway and not the page, drops every key, pointer and clipboard message.** The page's noVNC `viewOnly` is only a hint.
- `takeover`: mode `control`, a raw pipe. When the stream is reached the gateway calls `runtime.reportTakeoverViewer`, which journals `takeover.viewer_connected`: this is what makes "the person used the desktop" true in the hand-back text.
- Mode never changes on a live connection: going from watching to taking over is a new ticket and a new WebSocket.
- At most 32 relays at once. When either side leaves, both are closed.

## Testing
`@standin/gateway/testing`: `createFakeRuntime` (in-memory, same contract for the parts the gateway uses), `startProbe` (an HTTP client that can set any Host header and read event streams), `startEchoUpgradeServer` (stands in for the desk-daemon's stream; can require a token). The tests also run the gateway over the real `session-runtime` with a scripted model.
