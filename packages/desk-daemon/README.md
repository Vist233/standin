# @standin/desk-daemon

A separate process (`desk-daemon`) that owns the desktops of the box. It serves `WorkspaceHost` (see `@standin/contracts`, `workspace-host.ts`) on a Unix socket, one JSON object per line. The runtime talks to it through `workspace-client`; it never links this code.

**Interface (deep on purpose):** `ensure(spec)`, `destroy(id)`, `health(id)`, `takeover.open(id)`, `takeover.close(id)`. Every call is idempotent; `ensure` and `takeover.open` wake a stopped workspace; `health` and `destroy` never do.

**What it hides:** Xvfb and openbox per workspace, headed Chromium with its own profile and a DevTools port on 127.0.0.1, x11vnc plus a token-gated WebSocket bridge, restart with backoff, process groups, stale lock files, port and display numbers (one *slot* per workspace fixes all of them; see decisions D-T3-2).

**What it never knows:** sessions, models, agents, tools, the event journal.

| File | One job |
|---|---|
| `supervisor.ts` | `SupervisedProcess`: run one OS process in its own process group, restart with backoff, readiness and health probe, no orphan |
| `display.ts` | Xvfb + openbox of one workspace |
| `browser-proc.ts` | Chromium flags, profile locks, DevTools probe |
| `ws-bridge.ts` | WebSocket-to-TCP bridge that demands a token (RFC 6455, binary only) |
| `takeover.ts` | x11vnc + bridge, ticket and its expiry |
| `workspace.ts` | one workspace: start, stop, health, paths |
| `host.ts` | `DeskHost`: all workspaces, records on disk, one operation at a time per workspace |
| `server.ts` | the socket server and request dispatch |
| `main.ts` | the `desk-daemon` program; configuration from environment variables |
| `testing/` | `stubConfig` (the daemon over stub programs); the fake host and the contract suite live in `workspace-client/testing` |

**Environment of the program:** `OGB_DESK_DATA_DIR` (default `/data/desk`), `OGB_DESK_SOCKET` (default `/run/ogb/desk-daemon.sock`), `OGB_X11_DIR`, `OGB_CHROMIUM_PATH`, `OGB_MAX_WORKSPACES`. Nothing secret.

**Tests.** The contract suite (`workspaceHostContract`) runs against the fake, against `DeskHost` with stub programs, and against `DeskHost` through the socket. The stubs (`src/testing/stubs/`) stand in for Xvfb, openbox, Chromium and x11vnc, so the real supervision, port, record and bridge code runs on a laptop without X. The same suite and the kill tests run with the real programs in the container (`test/e2e/`).
