# @standin/web

The page: plain HTML, one stylesheet and a few ES modules. **No framework, no build step, no `innerHTML`**; the gateway serves `src/` as static files with a strict CSP. The page knows the gateway's API (`packages/gateway/README.md`) and the journal's event vocabulary (`@standin/contracts`, `events.ts`), nothing else. noVNC 1.7.0 is vendored unchanged under `src/vendor/novnc` (see `ORIGIN.md` there) and loaded lazily when the desk opens.

## Files (all in `src/`, all served)
| File | One reason to change | Needs a browser? |
|---|---|---|
| `model.js` | how journal events become a view state (`createState`, `applyEvent`, `foldEvents`): messages, tool calls (the review of an inner call joins its parent; a call with no result when the run ends is "interrupted"), questions, approvals (expired), take-over, errors, the desk trigger | no |
| `timeline.js` | what the conversation column shows: `groupTimeline`, `activitySummary`, `toolLabel`, `needsYou`, `nowLine`, `deskIntent`, `railStatus`, `composerButton`, `questionMarker`, `titleBadge` | no |
| `text.js` | text helpers: `splitFences` (plain text with fenced code kept apart), `fmtDuration`, `hostOf`, `titleFrom` | no |
| `sse.js` | reader of `text/event-stream` (the page uses `fetch`, not `EventSource`, so it can send the token and `Last-Event-ID`) | no |
| `client.js` | the JSON API and `followEvents`, which reconnects by itself from the last sequence number (backoff 0.5 s to 8 s, a watchdog for a quiet stream, stops on 401 and 404) | no (takes `fetch`) |
| `layout.js` | the widths of rail, conversation and desk for a window: `deskLayout`, `clampDeskFrac`, `defaultDeskW` | no |
| `prefs.js` | what is remembered between visits (desk width, folded or not), guarded `localStorage` | no |
| `desk.js` | the desk's connection: a view ticket for watching, a control ticket after Take over (a new connection, never a mode change), `focus()` after reconnecting, disconnect on close and after 30 s of a hidden tab | no (takes the viewer class) |
| `render.js` | DOM builders for messages, the folded activity line and its rows, needs-you cards | yes |
| `app.js` | wiring | yes |
| `index.html`, `style.css` | structure and the look | yes |

## The page (Vesper; docs/14-design-direction.md)
The identity is the owner's logo (`assets/`, copies in `src/assets/`): the icon in the top bar, as the tab icon and on the empty state; the wide logo is for the repository README. The small four-point **star** is the agent's presence (hollow idle, filled indigo and breathing while it works, amber when it needs the person), drawn by `star()` in `render.js`.
- **Top bar:** rail toggle, mark, the session's title, the **Desk chip** (a live thumbnail, the host being worked on, the star; the same picture node that lives in the pane moves into it). No permanent connection light: the offline banner appears after 2 s.
- **Rail:** New chat (Cmd/Ctrl+K) and the sessions with a star-shaped status dot. On a window narrower than 1280 px with a desk open it is a drawer.
- **Conversation:** the person's words in a sunk bubble, the agent's words as plain text (fenced code in a monospace block), one quiet **work-log line** for all the calls between two messages ("Worked 40 s · 7 steps · 1 refused", opened: rows with verb, target, duration; "Allowed by review" only inside), a one-line **marker** for a question or approval ("Asked you to sign in", then "You signed in · 2 min"), errors as a brick-red notice with the cause and Retry.
- **Now line** (28 px above the composer; empty and collapsed when idle): "Browsing · reading space.bilibili.com 0:42", "Needs you", "You have control · the agent is waiting", "Back with you · checking the page", "Stopped by an error". A **needs-you card** (amber, pinned, once) replaces it; the tab title says "(1) Vesper".
- **Desk, docked:** a pane to the right of the conversation (1440: 260 | 580 | 600) with a 9 px divider (drag, arrow keys 24 px, double-click resets; the width is kept as a fraction in `localStorage` key `vesper.desk`). Below 920 px it is a band on top (42vh at most); below 600 px a full-screen sheet. It opens by itself on a fresh browser call and on an open login question, and only lights the chip if the person folded it (Cmd/Ctrl+\\ or the fold button). When the run has ended and no browser call came for 60 s the picture stops and the last frame stays in the chip.
- **Take-over, the stage:** the rail hides, the conversation is a 360 px column, the desk takes the rest in a dark frame with "You have control", **Send text** and **Hand back**; the composer is replaced by the hand-back note field. Text with non-ASCII characters goes through the gateway's page-input route, ASCII is sent key by key.
- **Files:** a paperclip in the composer and drag-and-drop onto the conversation (a dashed target shows). Chosen files appear in a tray above the box with their size and progress; an empty or oversized file says why ("Not sent: larger than 25 MB"); they upload at once in a session and go with the first message in a new one, which then carries them as attachments (a message of files alone is allowed). The **Files** button in the top bar opens the session's file list with a Download for each (fetched with the token, then saved). During a take-over the stage has **Upload file**: the file goes into the session's folder and the panel says which path to choose in the remote file dialog. A user message that the runtime marked with attachments shows them as small chips under the bubble.
- **Motion** (transform and opacity only, off under `prefers-reduced-motion`): the star breathing, the desk arriving, the needs-you card rising with one ring pulse on its star.

Deferred (owner's list): dark theme, a floating desk, several desks, suggestion chips, markdown, per-session layout memory, the title menu with model and profile (the API does not return them), hand-back shortcut, phone sheet header ("Back to chat" bar).

## Rules the code keeps
- No `innerHTML`, `outerHTML`, `insertAdjacentHTML`, `document.write`, `eval` or inline handler (a test greps for them), so every string from an event is text; no inline script or style (the CSP forbids them).
- The model never throws on a payload it does not understand and ignores an event whose `seq` it has already applied, so a reconnect that repeats events changes nothing. Property tests hold it to: any events in any order give a valid state; a stream cut and resent with overlap gives exactly the clean stream's state; folding in two halves equals folding at once, **including the groups and summaries**, for every cut of every shared journal fixture.
- Accessibility: a skip link, labels on every field, `role="log"` with a polite live region, status banners as live regions, focus rings, text contrast of at least 4.5:1, a 44 px minimum is not yet applied (phone layout is deferred).

## Tests
`npm test` runs the pure tests (model, timeline, text, sse, desk with a fake viewer, client against the real gateway, a grep of the page's source). `test/web/page.e2e.ts.pending` holds the browser tests for this layout; they run in the container with Playwright (rename to `page.e2e.ts`; `npm run test:web`). `OGB_MANUAL=1 PORT=8099 npx vitest run --config vitest.web.config.ts test/web/manual.e2e.ts` serves the page over the shared journal fixtures and a fake desktop that speaks RFB, to look at it by hand.
