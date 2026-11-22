# StandIn

A personal agent that works in its own computer. One Docker container runs your agent sessions; each session has its own Linux desktop and a real, headed Chromium. A local web page lets you chat with the agent, watch its browser live, and take over with your own mouse and keyboard when a site wants you to sign in, then hand it back. Logins are shared by all your sessions, so you sign in once.

Built on the [Sakura agent framework](https://www.npmjs.com/package/sakura-agent). Personal and local: the page listens on `127.0.0.1` only and has no accounts.

## What it does
- **Chat and work:** the agent uses a shell, the browser (it reads the page's DOM to decide, never a screenshot guess) and the desktop (screenshots, mouse, keyboard, drag), and hands tasks to helper agents.
- **Watch and take over:** the Desk panel shows the agent's desktop live (VNC through noVNC, view only). Take over to type a password or scan a QR code yourself; passwords with symbols and Chinese text both work. Hand back with a note and the agent checks the page again.
- **Asks when it must:** logins, one-time codes, CAPTCHAs, payments: the agent stops and asks; a card shows what it needs.
- **Files both ways:** attach files to a message; the agent saves results and sends you download links.
- **Safe by default:** every tool call goes through review and redaction; the model key is read once and removed from the process environment; commands run with the workspace's environment only.
- **Survives restarts:** sessions, queued messages and logins live on a volume; an interrupted run is repaired or resumed.

## Quick start
You need Docker (about 8 GB of memory for Docker), and a model key. The default model is DeepSeek v4.1 flash through [Command Code](https://commandcode.ai); any OpenAI-compatible endpoint works through a `models.json`.

```bash
git clone https://github.com/Vist233/Vesper.git && cd Vesper
docker build -f image/Dockerfile -t ogb-box:dev .
export COMMANDCODE_API_KEY=...            # read by compose, never written anywhere
docker compose -f image/compose.yaml up -d
open http://127.0.0.1:8787/
```
Stop with `docker compose -f image/compose.yaml down` (your sessions and logins stay in the volume `ogb-data`). Behind a slow network, the Dockerfile takes mirror build arguments (`APT_MIRROR_BASE`, `NPM_REGISTRY`, `NODE_DIST_BASE`, `PLAYWRIGHT_DOWNLOAD_HOST`).

Settings are environment variables of the container: `OGB_MAX_WORKSPACES` (desktops running at once, default 8; more sessions may exist, the least recently used desktop stops and wakes again when needed), `OGB_RUN_TURNS`, `OGB_RUN_SECONDS`, `OGB_RUN_TOKENS` (limits of one run), `OGB_HUMAN_WAIT_MINUTES` and `OGB_TAKEOVER_MAX_MINUTES` (optional waiting limits; unset waits for ever).

## How it is built
One container, two supervised services (s6-overlay):
- **app**: the page and its HTTP/SSE/WebSocket gateway, the session runtime (Sakura agents, plugins, review, a journal per session, crash recovery), the model registry.
- **desk-daemon**: per session an Xvfb display, a window manager, a headed Chromium with a DevTools port, and on demand an x11vnc stream behind a token bridge that drops input from view-only connections. It keeps the browsers' cookies equal (one set of logins) and caps how many desktops run.

Code is one package per concern under `packages/` (contracts, router, session-store, event-journal, session-runtime, gateway, web, desk-daemon, workspace-client, plugin-host, profiles, model-registry, secrets, agents-md, connectors, app) and first-party plugins under `plugins/` (browser, computer, handoff, mail-sim). Packages talk only through `packages/contracts`; `npm run boundaries` enforces the dependency table in `scripts/allowed-dependencies.json`. Each package has its own tests and test doubles (`src/testing`).

## Development
Needs Node 24 or newer.
```bash
npm install
npm run check        # boundaries, types, lint, format, unit and integration tests
npm run test:e2e     # container tests (real Xvfb, Chromium, x11vnc); needs the image
npm run test:web     # the page in a real Chromium (run inside the image)
npm run journey      # the whole running box without a model: live view, take-over, typing, hand-back
npm run scan         # personal paths, keys and session ids in tracked files
```

License: [MIT](LICENSE).
