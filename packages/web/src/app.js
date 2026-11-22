// @ts-check
// The page. It knows the gateway's API and the journal's events, nothing else. No framework: this file wires the
// pure model (model.js, timeline.js), the network client (client.js), the DOM builders (render.js) and the desk (desk.js).

import { checkFiles, uploadProblem } from "./attachments.js";
import { ApiError, createApi, downloadFile, followEvents, uploadFile } from "./client.js";
import { afterHealth, afterStream, CONNECTION_WORDS } from "./connection.js";
import { createDesk } from "./desk.js";
import { createFiles } from "./files-ui.js";
import { clampDeskFrac, deskLayout, fracOf } from "./layout.js";
import { loadPrefs, savePrefs } from "./prefs.js";
import { applyEvent, createState, pendingActions } from "./model.js";
import { continueWith, freshName, freshNotices, STARS, starOf } from "./bots.js";
import { chatTimeline, listTime, presence, preview } from "./chat.js";
import { h, renderEntry, renderItem, star } from "./render.js";
import { greeting, startupWarnings } from "./text.js";
import { composerButton, deskIntent, needsYou, railStatus, titleBadge } from "./timeline.js";

const $ = (/** @type {string} */ id) => /** @type {HTMLElement} */ (document.getElementById(id));
const input = (/** @type {string} */ id) => /** @type {HTMLInputElement} */ (document.getElementById(id));
const area = (/** @type {string} */ id) => /** @type {HTMLTextAreaElement} */ (document.getElementById(id));

// ---------- the token (only when the server asks for one; kept for this tab only) ----------
const tokenKey = "ogb-token";
const readToken = () => {
  try {
    return sessionStorage.getItem(tokenKey) ?? undefined;
  } catch {
    return undefined;
  }
};
const api = createApi({ token: readToken });

// ---------- banners and the connection ----------
/** @type {import("./connection.js").Connection} */
let connection = "connecting";
/** @type {ReturnType<typeof setTimeout> | undefined} */
let offlineTimer;

/** Whether the open session's event stream is connected (the health poll alone does not know). */
let streamLive = false;

function setConnection(/** @type {typeof connection} */ next) {
  // The stream reports each retry: the same state again must not restart the two-second clock, or the banner never shows.
  if (next === connection && next !== "live") return;
  connection = next;
  $("token-form").hidden = next !== "unauthorized";
  clearTimeout(offlineTimer);
  const words = CONNECTION_WORDS[next];
  if (words === "") banner("offline", null);
  else offlineTimer = setTimeout(() => banner("offline", words, "bad"), 2000); // after two seconds the person should know why nothing moves
}

function banner(/** @type {string} */ key, /** @type {string | null} */ message, /** @type {string} */ kind = "", /** @type {HTMLElement[]} */ extra = []) {
  const parent = $("banners");
  const existing = parent.querySelector(`[data-key="${key}"]`);
  if (message === null) return existing?.remove();
  const box = h("div", { class: `banner ${kind}`.trim(), attrs: { "data-key": key } }, [h("span", { text: message }), ...extra]);
  if (existing) existing.replaceWith(box);
  else parent.append(box);
}

/** The start-up warnings: one line each, neutral, with Dismiss. Information lines never get here. */
function startupBanner(/** @type {string[]} */ warnings) {
  const existing = $("banners").querySelector('[data-key="startup"]');
  if (warnings.length === 0) return existing?.remove();
  const close = h("button", { text: "Dismiss", attrs: { type: "button" } });
  close.addEventListener("click", () => banner("startup", null));
  const list = h(
    "ul",
    { class: "lines" },
    warnings.map((text) => h("li", { text })),
  );
  const box = h("div", { class: "banner warn", attrs: { "data-key": "startup", role: "status" } }, [list, close]);
  if (existing) existing.replaceWith(box);
  else $("banners").append(box);
}

function report(/** @type {unknown} */ error) {
  if (error instanceof ApiError && error.status === 401) return setConnection("unauthorized");
  const text = error instanceof ApiError ? error.message : "Something went wrong.";
  const close = h("button", { text: "Dismiss", attrs: { type: "button" } });
  close.addEventListener("click", () => banner("error", null));
  banner("error", text, "bad", [close]);
}

async function pollHealth() {
  const health = await api.health().catch(() => null);
  setConnection(afterHealth(connection, health, { selected: selected !== null, streamLive }));
}

// ---------- the rail ----------
/** @type {{ id: string, title: string, createdAt: number, notice?: { at: number, text: string }, last?: { at: number, who: "person" | "bot", text: string }, star?: string, yolo?: boolean, summary?: string, next?: string, status: string, state: { run: string, held: boolean, queued: number } | null, pending: number, lastRunEnd: string | null, takeover: boolean }[]} */
let rows = [];
/** @type {{ profiles: string[], defaultProfile?: string, models: string[], takeover: boolean, liveView: boolean, files: boolean, limits: { fileBytes: number, files: number }, startup: unknown[] }} */
let options = { profiles: [], models: [], takeover: false, liveView: false, files: false, limits: { fileBytes: 25 * 1024 * 1024, files: 20 }, startup: [] };
/** @type {string | null} */
let selected = null;

/** @param {{ createdAt: number, last?: { at: number } }} a @param {{ createdAt: number, last?: { at: number } }} b */
const byLatest = (a, b) => (b.last?.at ?? b.createdAt) - (a.last?.at ?? a.createdAt);

async function refreshSessions() {
  try {
    // As in a chat app: the bot with the latest message first; a new bot (no message yet) by when it was made.
    rows = (await api.listSessions()).sessions.sort(byLatest);
    renderRail();
    renderHeader(); // a new summary or name arrives with the list, not with an event
    showNotices();
  } catch (error) {
    if (error instanceof ApiError && error.status === 401) setConnection("unauthorized");
  }
}

const STATUS_WORDS = { needs: "needs you", error: "error", working: "working", idle: "idle" };

/** A bot's star, in its tint. */
function avatar(/** @type {{ id: string, star?: string }} */ bot, /** @type {number} */ size) {
  const mark = star("avatar", size);
  mark.style.setProperty("--tint", starOf(bot).tint);
  return mark;
}

/** The rail is a contact list of bots: star, name, what it is working on, and a dot for its state (docs/18 section 1). */
function renderRail() {
  const list = $("sessions");
  const scroller = $("rail"); // the list is rebuilt at every event: emptying it would throw the rail back to the top
  const scrolled = scroller.scrollTop;
  list.replaceChildren();
  for (const row of rows) {
    const live =
      row.id === selected
        ? { state: { run: model.run }, pending: pendingActions(model), lastRunEnd: model.lastRunEnd, takeover: Boolean(model.takeover) }
        : row;
    const status = railStatus(live);
    // A contact as in a chat app: who, their last message (or "typing…"), when, and how many things wait for you.
    const line = preview(row, status);
    const pending = row.id === selected ? needsYou(model).length : row.pending;
    const button = h("button", { attrs: { type: "button", "aria-current": String(row.id === selected), "data-status": status, title: row.title } }, [
      avatar(row, 24),
      h("span", { class: "who" }, [
        h("span", { class: "c-head" }, [
          h("span", { class: "title", text: row.title }),
          h("span", { class: "when", text: row.last ? listTime(row.last.at, Date.now()) : "" }),
        ]),
        h("span", { class: "c-msg" }, [
          h("span", { class: `line${line.tone ? ` ${line.tone}` : ""}`, text: line.text }),
          pending > 0 ? h("span", { class: "badge", text: String(pending), attrs: { "aria-label": `${pending} waiting for you` } }) : null,
        ]),
      ]),
      h("span", { class: "sr", text: STATUS_WORDS[status] }),
    ]);
    button.addEventListener("click", () => {
      location.hash = `#/s/${row.id}`;
      if (window.innerWidth < 920) {
        railOpen = false; // on a narrow window the rail is a drawer: picking a bot closes it
        applyLayout();
      }
    });
    list.append(h("li", {}, [button]));
  }
  scroller.scrollTop = scrolled;
}

// ---------- notices: the result of a scheduled run reaches the person as a browser notification ----------
const seenKey = "ogb-notices-seen";
function showNotices() {
  /** @type {Record<string, number>} */
  let seen = {};
  try {
    seen = JSON.parse(localStorage.getItem(seenKey) ?? "{}");
  } catch {
    // no storage: every page load starts fresh, which only means old notices are not replayed
  }
  const { fresh, seen: next } = freshNotices(rows, seen);
  try {
    localStorage.setItem(seenKey, JSON.stringify(next));
  } catch {
    // see above
  }
  for (const notice of fresh) {
    if (notice.id === selected && document.visibilityState === "visible") continue; // already in front of the person
    if (!("Notification" in window) || Notification.permission !== "granted") continue;
    const shown = new Notification(notice.title, { body: notice.text, tag: `ogb-${notice.id}`, icon: "/favicon-32.png" });
    shown.addEventListener("click", () => {
      window.focus();
      location.hash = `#/s/${notice.id}`;
      shown.close();
    });
  }
}
function renderNotifyButton() {
  $("notify-me").hidden = !("Notification" in window) || Notification.permission !== "default";
}
$("notify-me").addEventListener("click", async () => {
  await Notification.requestPermission().catch(() => "denied");
  renderNotifyButton();
});
renderNotifyButton();

$("rail-toggle").addEventListener("click", () => {
  railOpen = !railOpen;
  railWasPromptedOpen = railOpen; // the person asked for it: do not shut it again behind their back
  applyLayout();
});

// ---------- a new bot: a small sheet with a name, a star and an optional first job ----------
let chosenStar = /** @type {string} */ (STARS[0].id);

function pickStar(/** @type {string} */ id, /** @type {boolean} */ fillName) {
  const nameField = input("bot-title");
  const before = STARS.find((candidate) => candidate.id === chosenStar);
  chosenStar = id;
  for (const choice of $("star-choices").querySelectorAll("button")) choice.setAttribute("aria-pressed", String(choice.dataset.star === id));
  // One click fills the name too, unless the person typed a name of their own.
  const typed = nameField.value.trim();
  const preset = STARS.find((candidate) => candidate.id === id);
  if (fillName && preset && (typed === "" || (before && typed.startsWith(before.name)))) nameField.value = freshName(rows, preset.name);
}

for (const preset of STARS) {
  const mark = star("avatar", 22);
  mark.style.setProperty("--tint", preset.tint);
  const choice = h("button", { attrs: { type: "button", "data-star": preset.id, "aria-pressed": "false" } }, [mark, h("span", { text: preset.name })]);
  choice.addEventListener("click", () => pickStar(preset.id, true));
  $("star-choices").append(choice);
}

function openBotSheet() {
  const sheet = /** @type {HTMLDialogElement} */ ($("bot-sheet"));
  area("bot-job").value = "";
  const name = freshName(rows);
  pickStar(STARS.find((candidate) => candidate.name === name)?.id ?? STARS[rows.length % STARS.length]?.id ?? "vega", false);
  input("bot-title").value = name;
  sheet.showModal();
  input("bot-title").select();
}

$("new-bot").addEventListener("click", openBotSheet);
$("empty-new").addEventListener("click", openBotSheet);
$("bot-cancel").addEventListener("click", () => /** @type {HTMLDialogElement} */ ($("bot-sheet")).close());
$("bot-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  const title = input("bot-title").value.trim();
  const job = area("bot-job").value.trim();
  const create = /** @type {HTMLButtonElement} */ ($("bot-create"));
  if (!title || create.disabled) return;
  create.disabled = true;
  try {
    const { session } = await api.createSession({ title, star: chosenStar });
    /** @type {HTMLDialogElement} */ ($("bot-sheet")).close();
    if (job) await api.send(session.id, job, crypto.randomUUID());
    await refreshSessions();
    location.hash = `#/s/${session.id}`;
    area("message").focus();
  } catch (error) {
    report(error);
  } finally {
    create.disabled = false;
  }
});

// ---------- the bot's name in the top bar: click to rename ----------
function startRename() {
  const row = rows.find((candidate) => candidate.id === selected);
  if (!row) return;
  const field = input("bot-rename");
  field.value = row.title;
  field.hidden = false;
  $("bot-name").hidden = true;
  field.focus();
  field.select();
}

async function finishRename(/** @type {boolean} */ save) {
  const field = input("bot-rename");
  if (field.hidden) return;
  field.hidden = true;
  $("bot-name").hidden = false;
  const row = rows.find((candidate) => candidate.id === selected);
  const title = field.value.trim();
  if (!save || !row || !title || title === row.title) return;
  row.title = title; // shown at once; the server's answer and the next poll agree
  renderHeader();
  renderRail();
  try {
    await api.updateSession(row.id, { title });
  } catch (error) {
    report(error);
  }
  await refreshSessions();
}

// ---------- yolo: the person switches this bot's approvals and review off and on, while it runs ----------
$("yolo").addEventListener("click", async () => {
  const row = rows.find((candidate) => candidate.id === selected);
  if (!row) return;
  const on = !row.yolo;
  if (
    on &&
    !window.confirm(`Switch off approvals and review for ${row.title}? It will send, post and delete without asking you until you switch them back on.`)
  )
    return;
  try {
    await api.updateSession(row.id, { yolo: on });
  } catch (error) {
    report(error);
  }
  await refreshSessions();
});

$("bot-name").addEventListener("click", startRename);
$("bot-rename").addEventListener("keydown", (event) => {
  const key = /** @type {KeyboardEvent} */ (event);
  if (key.key === "Enter" && !key.isComposing) {
    event.preventDefault();
    void finishRename(true);
  } else if (key.key === "Escape") {
    event.preventDefault();
    void finishRename(false);
  }
});
$("bot-rename").addEventListener("blur", () => void finishRename(true));

// ---------- one session ----------
/** @type {AbortController | null} */
let following = null;
/** @type {ReturnType<typeof createState>} */
let model = createState();
/** @type {Map<string, { el: HTMLElement, sig: string }>} */
let blockEls = new Map();
let frameQueued = false;
/** The most recent action that highlighted the Desk button. */
let lastDeskKey = 0;
let deskOpened = false;

const actions = {
  download: (/** @type {string} */ session, /** @type {string} */ name) => {
    // An agent may write the workspace id (s-1) instead of the session id (s_1): both name this session's files.
    if (!selected || (session !== selected && session !== selected.replaceAll("_", "-"))) return;
    void downloadFile({ session: selected, name, token: readToken })
      .then((blob) => {
        const url = URL.createObjectURL(blob);
        const link = h("a", { attrs: { href: url, download: name } });
        link.click();
        setTimeout(() => URL.revokeObjectURL(url), 10_000);
      })
      .catch(report);
  },
  answer: (/** @type {string} */ _id, /** @type {string} */ text) => sendText(text),
  decide: (/** @type {string} */ approvalId, /** @type {boolean} */ approved) => {
    if (selected) api.decide(selected, approvalId, approved).catch(report);
  },
  openDesk: () => void openDesk("control"),
  retry: () => void sendText("Please try again."),
};

async function sendText(/** @type {string} */ text) {
  if (!selected) return false;
  try {
    await api.send(selected, text, crypto.randomUUID());
    return true;
  } catch (error) {
    report(error);
    return false;
  }
}

function leaveSession() {
  following?.abort();
  following = null;
  streamLive = false;
  desk.switchSession();
  model = createState();
  blockEls = new Map();
  pinnedSig = "";
  $("pinned").replaceChildren();
  lastDeskKey = 0;
  takeoverSeen = false;
  keepChip = false;
  lastFrame = null;
  files.reset();
  $("timeline").replaceChildren();
  banner("gone", null);
  banner("held", null);
  banner("gaps", null);
}

const lastBotKey = "ogb-last-bot";
async function openSession(/** @type {string} */ id) {
  leaveSession();
  selected = id;
  try {
    localStorage.setItem(lastBotKey, id);
  } catch {
    // no storage: the next visit opens the bot with the latest message
  }
  renderRail();
  try {
    const endedBefore = takeoversEnded;
    const detail = await api.getSession(id);
    // Reloaded in the middle of a take-over: still in control. Not when the journal said it ended while this answer travelled.
    if (detail.takeover && selected === id && takeoversEnded === endedBefore) void openDesk("control");
  } catch (error) {
    report(error);
    if (error instanceof ApiError && error.status === 404) {
      selected = null;
      location.hash = "";
      return;
    }
  }
  const abort = new AbortController();
  following = abort;
  void followEvents({
    url: `/api/sessions/${id}/events`,
    after: () => model.lastSeq,
    token: readToken,
    signal: abort.signal,
    onEvents(events) {
      for (const event of events) applyEvent(model, event);
      scheduleRender();
    },
    onConnection(state) {
      if (abort.signal.aborted) return;
      streamLive = state === "live";
      if (state === "gone") banner("gone", "This session no longer exists.", "bad");
      else setConnection(afterStream(connection, state));
      if (state === "live" || state === "reconnecting") void pollHealth();
    },
  });
  scheduleRender();
}

function scheduleRender() {
  if (frameQueued) return;
  frameQueued = true;
  // A window that is covered or not painting gets no animation frames (even when not "hidden"): the timer makes sure the
  // page still renders, or it would wait for ever with the greeting on screen.
  const run = () => {
    if (!frameQueued) return;
    frameQueued = false;
    render();
  };
  requestAnimationFrame(run);
  setTimeout(run, 100);
}

/** Signature of a chat entry: changes exactly when something visible in it can have changed (its text, its tail, its day label). */
function signature(/** @type {import("./chat.js").ChatEntry} */ entry) {
  if (entry.type === "day") return entry.label;
  return `${/** @type {any} */ (entry.item).rev ?? 0}:${entry.tail}`;
}

function render() {
  const timeline = $("timeline");
  const scroller = $("scroller");
  const nearBottom = scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight < 120;
  const loaded = blockEls.size > 0; // a history that loads all at once arrives without motion; later messages move in
  for (const entry of chatTimeline(model.items, Date.now())) {
    const sig = signature(entry);
    const known = blockEls.get(entry.key);
    if (known?.sig === sig) continue;
    const el = renderEntry(entry, actions);
    if (known) known.el.replaceWith(el);
    else {
      if (loaded) el.classList.add("fresh");
      timeline.append(el);
    }
    blockEls.set(entry.key, { el, sig });
  }
  // Typing, as a person shows it: three dots under the conversation while the bot works and asks nothing of you.
  $("typing").hidden = !(selected !== null && model.run === "active" && needsYou(model).length === 0 && !model.takeover);
  if (nearBottom) scroller.scrollTop = scroller.scrollHeight;
  const isEmpty = !(blockEls.size > 0 && selected !== null);
  $("empty").hidden = !isEmpty;
  const bot = rows.find((candidate) => candidate.id === selected);
  $("greeting").textContent = bot ? `Say hello to ${bot.title}.` : greeting(new Date().getHours());
  $("hint").textContent = bot
    ? "Tell it what you need in your own words. It works on its own computer and writes back when there is something to say."
    : "Each bot is someone who works for you on their own computer. Start a conversation with one.";
  $("empty-new").hidden = selected !== null;
  $("empty-avatar").replaceChildren(...(bot ? [avatar(bot, 44)] : []));
  area("message").placeholder = bot ? `Message ${bot.title}` : "Message";
  document.querySelector(".main")?.setAttribute("data-empty", String(isEmpty));
  renderPinned();
  renderComposer();
  renderBanners();
  renderRail();
  renderHeader();
  followDesk();
}

/** The bot in the top bar (star, name to click and rename, its task) and the tab title with how many things wait for the person. */
function renderHeader() {
  const row = rows.find((candidate) => candidate.id === selected);
  $("session-title").hidden = !row;
  $("yolo").hidden = !row;
  if (row) {
    $("yolo").setAttribute("aria-pressed", String(Boolean(row.yolo)));
    $("yolo").title = row.yolo
      ? "Yolo is on: this bot runs every tool without asking you and without review. Click to switch approvals and review back on."
      : "Approvals and review for this bot: on. Click to switch them off (yolo).";
    $("bot-star").replaceChildren(avatar(row, 22));
    $("bot-name").textContent = row.title;
    const status = presence(
      { run: model.run, pending: needsYou(model).length, takeover: Boolean(model.takeover), lastAt: row.last?.at ?? lastSeen(model.items) },
      Date.now(),
    );
    $("bot-summary").textContent = status;
    $("bot-summary").dataset.tone = status === "typing…" ? "live" : status === "waiting for you" || status === "you have the screen" ? "needs" : "";
  }
  document.title = titleBadge(selected ? needsYou(model).length : rows.reduce((sum, candidate) => sum + candidate.pending, 0));
}

/** When the bot last said something, from the conversation itself (the bot's info may not have it yet). */
function lastSeen(/** @type {readonly import("./model.js").Item[]} */ items) {
  for (let i = items.length - 1; i >= 0; i -= 1) {
    const item = /** @type {import("./model.js").Item} */ (items[i]);
    if (item.kind === "assistant" || item.kind === "say") return item.at;
  }
  return null;
}

/** @type {string} */
let pinnedSig = "";
function renderPinned() {
  const waiting = needsYou(model);
  const sig = waiting.map((item) => `${item.kind}:${/** @type {any} */ (item).id}`).join(",");
  if (sig === pinnedSig) return;
  pinnedSig = sig;
  const list = $("pinned");
  list.replaceChildren();
  for (const item of waiting) list.append(renderItem(item, actions, { pinned: true }).el);
}

function renderBanners() {
  if (model.held && !model.takeover && needsYou(model).length === 0) {
    // an open question already says what to do
    const text =
      model.waiting > 0
        ? `Stopped. ${model.waiting} ${model.waiting === 1 ? "signal is" : "signals are"} waiting while held; write a message to continue.`
        : "Stopped. Write a message to continue.";
    banner("held", text, "calm");
  } else banner("held", null);
  banner("gaps", model.gaps > 0 ? "Some events were missed; reload the page to see everything." : null, "bad");
}

// ---------- the composer ----------
let submitting = false;

function renderComposer() {
  const text = area("message").value.trim();
  // While the person has control the composer gives way to the hand-back control: a message would end the hold.
  const controlling = Boolean(model.takeover) || desk.mode === "control";
  $("composer").hidden = controlling || selected === null; // a message goes to a bot: with none chosen there is only "New bot"
  $("handback-bar").hidden = !controlling;
  const button = composerButton(model.run === "active", text !== "" || files.count() > files.failed());
  const send = $("send");
  send.textContent = button.glyph;
  send.setAttribute("aria-label", button.label);
  /** @type {HTMLButtonElement} */ (send).disabled = submitting || button.disabled;
}

function fitTextarea() {
  const field = area("message");
  field.style.height = "auto";
  field.style.height = `${Math.min(field.scrollHeight, 220)}px`;
}

async function submit() {
  if (submitting) return;
  if (model.takeover || desk.mode === "control") return; // the person is in control: a message would end the hold and let the agent act
  const field = area("message");
  const text = field.value.trim();
  const hasFiles = files.count() > files.failed();
  if (composerButton(model.run === "active", text !== "" || hasFiles).stops) {
    if (selected) api.stop(selected).catch(report);
    return;
  }
  if ((text === "" && !hasFiles) || !selected) return;
  const target = selected;
  submitting = true;
  renderComposer();
  try {
    await files.uploadAll(target);
    if (files.failed() > 0 || files.pending() > 0) {
      banner("files", "Some files were not sent. Remove them or try again; your message is still here.", "bad");
      return;
    }
    banner("files", null);
    const attachments = files.attachments();
    await api.send(target, text || "I attached files.", crypto.randomUUID(), attachments);
    field.value = "";
    fitTextarea();
    files.clear();
  } catch (error) {
    report(error);
  } finally {
    submitting = false;
    renderComposer();
  }
}

$("composer").addEventListener("submit", (event) => {
  event.preventDefault();
  void submit();
});
$("message").addEventListener("input", () => {
  fitTextarea();
  renderComposer();
});
$("message").addEventListener("keydown", (event) => {
  const key = /** @type {KeyboardEvent} */ (event);
  if (key.key === "Enter" && !key.shiftKey && !key.isComposing) {
    event.preventDefault();
    void submit();
  }
});

// ---------- files: the tray, the drop target, the Files list ----------
const files = createFiles({
  tray: $("tray"),
  getSession: () => selected,
  limits: () => options.limits,
  api,
  token: readToken,
  report,
  onChange: () => renderComposer(),
});

$("attach").addEventListener("click", () => $("file-input").click());
$("file-input").addEventListener("change", () => {
  const picker = input("file-input");
  files.addFiles(picker.files ?? []);
  picker.value = "";
});
(() => {
  let depth = 0;
  const hasFiles = (/** @type {DragEvent} */ event) => [...(event.dataTransfer?.types ?? [])].includes("Files");
  const main = /** @type {HTMLElement} */ (document.querySelector(".main"));
  main.addEventListener("dragenter", (event) => {
    if (!hasFiles(event) || model.takeover) return;
    event.preventDefault();
    depth += 1;
    $("drop").hidden = false;
  });
  main.addEventListener("dragover", (event) => {
    if (hasFiles(event)) event.preventDefault();
  });
  main.addEventListener("dragleave", () => {
    depth = Math.max(0, depth - 1);
    if (depth === 0) $("drop").hidden = true;
  });
  main.addEventListener("drop", (event) => {
    if (!hasFiles(event)) return;
    event.preventDefault();
    depth = 0;
    $("drop").hidden = true;
    if (!model.takeover) files.addFiles(event.dataTransfer?.files ?? []);
  });
  // A file dropped beside the page must not make the browser open it and leave the conversation.
  window.addEventListener("dragover", (event) => event.preventDefault());
  window.addEventListener("drop", (event) => event.preventDefault());
})();

// ---------- layout: the rail, the conversation, the docked desk ----------
let railOpen = window.innerWidth >= 920;
/** What the person sees of the desk: nothing, the chip in the top bar, the docked pane, or the stage (take-over). */
/** @type {"closed" | "chip" | "docked" | "stage"} */
let deskState = "closed";
/** The desk's width as a fraction of the window once the person has dragged the divider; null means the default. */
/** @type {number | null} */
let deskFrac = null;
const prefs = loadPrefs(window.innerWidth);
deskFrac = prefs.frac;

function applyLayout() {
  const vw = window.innerWidth;
  const layout = deskLayout(vw, railOpen, deskState, clampDeskFrac(deskFrac, vw));
  const body = $("body");
  body.dataset.desk = deskState;
  body.dataset.placement = layout.placement;
  body.dataset.railDrawer = String(layout.railDrawer);
  body.style.setProperty("--rail-w", `${layout.railDrawer ? 0 : layout.railW}px`);
  body.style.setProperty("--desk-w", `${layout.placement === "split" ? layout.deskW : 0}px`);
  if (layout.railDrawer && deskState !== "closed" && railOpen && !railWasPromptedOpen) railOpen = false; // a docked desk takes the room: the rail is a drawer and starts shut
  $("rail").hidden = !railOpen;
  $("rail-toggle").setAttribute("aria-expanded", String(railOpen));
  $("rail-toggle").setAttribute("aria-label", railOpen ? "Fold the bots away" : "Show the bots");
  $("divider").hidden = !(layout.placement === "split" && deskState === "docked");
  const divider = $("divider");
  divider.setAttribute("aria-valuenow", String(layout.deskW));
  divider.setAttribute("aria-valuemin", "480");
}
let railWasPromptedOpen = false;

window.addEventListener("resize", applyLayout);

(() => {
  const divider = $("divider");
  const widthFromPointer = (/** @type {number} */ clientX) => window.innerWidth - clientX;
  divider.addEventListener("pointerdown", (event) => {
    divider.setPointerCapture(event.pointerId);
    divider.dataset.dragging = "true";
  });
  divider.addEventListener("pointermove", (event) => {
    if (divider.dataset.dragging !== "true") return;
    deskFrac = fracOf(widthFromPointer(event.clientX), window.innerWidth);
    applyLayout();
  });
  const remember = () => {
    prefs.frac = deskFrac;
    savePrefs(prefs);
  };
  const stop = () => {
    delete divider.dataset.dragging;
    remember();
  };
  divider.addEventListener("pointerup", stop);
  divider.addEventListener("pointercancel", stop);
  divider.addEventListener("dblclick", () => {
    deskFrac = null;
    applyLayout();
    remember();
  });
  divider.addEventListener("keydown", (event) => {
    const step = event.key === "ArrowLeft" ? 24 : event.key === "ArrowRight" ? -24 : 0;
    if (!step) return;
    event.preventDefault();
    const vw = window.innerWidth;
    const current = Number(divider.getAttribute("aria-valuenow")) || 600;
    deskFrac = fracOf(current + step, vw);
    applyLayout();
    remember();
  });
})();

// ---------- the desk ----------
let lastFrame = /** @type {HTMLCanvasElement | null} */ (null);
/** True while the desk is shut on purpose and only the chip remains (so the controller's "closed" does not hide the chip). */
let keepChip = false;

const screen = $("desk-screen");

/** Shows the desk in one of its four states. The picture is one node: it moves between the pane and the chip's thumbnail. */
function showDesk(/** @type {"closed" | "chip" | "docked" | "stage"} */ view) {
  deskState = view;
  deskOpened = view === "docked" || view === "stage";
  $("desk").hidden = !deskOpened;
  if (deskOpened) {
    $("desk").insertBefore(screen, $("desk-type"));
    screen.classList.remove("in-chip");
  } else if (view === "chip" && desk.mode !== "closed") {
    $("desk-thumb").replaceChildren(screen);
    screen.classList.add("in-chip");
  } else {
    screen.classList.remove("in-chip");
    $("desk-thumb").replaceChildren(...(view === "chip" && lastFrame ? [lastFrame] : []));
  }
  $("desk-pill").setAttribute("aria-pressed", String(deskOpened));
  if (deskOpened) delete $("desk-pill").dataset.light;
  applyLayout();
  renderChip();
}

const desk = createDesk({
  api,
  screen,
  report,
  onChange(mode, message) {
    if (mode === "control") showDesk("stage");
    else if (mode === "closed") showDesk(keepChip ? "chip" : "closed");
    else if (deskState === "closed") showDesk("docked");
    else if (deskState === "stage") showDesk("docked");
    const chip = $("desk-mode");
    chip.textContent = mode === "control" ? "You have control" : mode === "connecting" ? "Connecting" : mode === "failed" ? "Not connected" : "";
    chip.hidden = chip.textContent === ""; // watching needs no label (owner's item 12)
    chip.className = `chip${mode === "control" ? " control" : ""}`;
    $("desk-collapse").hidden = mode === "control"; // in control only Hand back ends it (item 13)
    $("desk-takeover").hidden = mode !== "view";
    $("desk-reconnect").hidden = mode !== "failed";
    $("desk-type-toggle").hidden = mode !== "control";
    $("desk-upload").hidden = mode !== "control" || !options.files;
    if (mode !== "control") $("desk-upload-note").hidden = true;
    $("desk-handback-header").hidden = mode !== "control";
    if (mode !== "control") {
      $("desk-type").hidden = true;
      $("desk-hint").hidden = true;
      $("desk-type-toggle").setAttribute("aria-expanded", "false");
    }
    $("desk-note").textContent = message;
    renderComposer();
    if (mode === "closed" || mode === "view") void refreshSessions();
  },
});

/** The chip in the top bar: the host being worked on, a star for the state, a thumbnail of the picture. */
function renderChip() {
  const chip = $("desk-pill");
  const host = model.deskTrigger?.host ?? "";
  $("desk-host").textContent = host;
  chip.setAttribute("aria-label", host ? `Desk, ${host}` : "Desk");
  const mark = /** @type {SVGElement} */ (chip.querySelector(".star"));
  mark.setAttribute("class", `star${needsYou(model).length > 0 ? " needs" : model.run === "active" ? " on" : ""}`);
}

async function openDesk(/** @type {"view" | "control"} */ kind) {
  if (!selected) return;
  keepChip = false;
  showDesk(kind === "control" ? "stage" : "docked");
  await desk.open(selected, kind);
}

/** Collapses the desk to the chip; the picture goes on streaming into the thumbnail while the agent works. */
function collapseDesk() {
  prefs.collapsed = true;
  savePrefs(prefs);
  keepChip = true;
  showDesk("chip");
}

/** After the run ended and no browser call for a minute, the picture stops: the last frame stays in the chip. */
function freezeDesk() {
  const canvas = screen.querySelector("canvas");
  if (canvas && canvas.width > 0) {
    const frame = document.createElement("canvas");
    frame.width = 112;
    frame.height = 70;
    frame.getContext("2d")?.drawImage(canvas, 0, 0, 112, 70);
    lastFrame = frame;
  }
  keepChip = true;
  desk.close();
}

setInterval(() => {
  if (!selected || desk.mode !== "view" || deskState !== "chip") return;
  const last = model.deskTrigger?.at ?? 0;
  if (model.run !== "active" && Date.now() - last > 60_000) freezeDesk();
}, 5000);

/** Whether the journal said a take-over was open at the last render (to notice it ending). */
let takeoverSeen = false;
/** How many take-overs the page saw end: an older answer that still says "open" must not reopen control. */
let takeoversEnded = 0;

/** Restore an active take-over or highlight the Desk button once per reason; leave control when the take-over ended elsewhere. */
function followDesk() {
  if (!selected || !options.liveView) return;
  renderChip();
  const ended = takeoverSeen && !model.takeover;
  takeoverSeen = Boolean(model.takeover);
  if (ended) {
    takeoversEnded += 1;
    if (lastDeskKey === -1) lastDeskKey = 0; // a later take-over restores the stage again
    // Its time limit, a restart or another tab ended it: the person no longer has control, so the picture goes back to watching.
    if (desk.mode === "control" || deskState === "stage") void openDesk("view"); // also while the control picture still connects
  }
  const intent = deskIntent(model, Date.now());
  if (!intent || intent.key === lastDeskKey) return;
  lastDeskKey = intent.key;
  if (intent.intent === "light-chip") $("desk-pill").dataset.light = "true";
  else if (intent.intent === "stage") void openDesk("control");
}

/** Docks the desk again: the existing picture if it still streams, a new connection if it was frozen. */
async function dockFromChip() {
  prefs.collapsed = false;
  savePrefs(prefs);
  keepChip = false;
  if (desk.mode === "view" || desk.mode === "connecting") showDesk("docked");
  else await openDesk(model.takeover ? "control" : "view");
}

$("desk-pill").addEventListener("click", () => {
  if (deskState === "docked") collapseDesk();
  else if (deskState === "stage")
    return; // in control: only Hand back ends it
  else void dockFromChip();
});
$("desk-collapse").addEventListener("click", () => collapseDesk());
$("desk-reconnect").addEventListener("click", () => void desk.reconnect());
$("desk-takeover").addEventListener("click", () => void desk.takeover());
$("handback-bar").addEventListener("submit", async (event) => {
  event.preventDefault();
  const field = input("handback-note");
  const button = /** @type {HTMLButtonElement} */ ($("desk-handback-button"));
  if (button.disabled) return;
  button.disabled = true;
  try {
    if (await desk.handback(field.value.trim())) field.value = "";
  } finally {
    button.disabled = false;
  }
});
$("desk-handback-header").addEventListener("click", () => /** @type {HTMLFormElement} */ ($("handback-bar")).requestSubmit());
/** During a take-over the person's file goes into the session's files directory first; then they pick it in the remote file dialog. */
$("desk-upload").addEventListener("click", () => $("desk-file").click());
$("desk-file").addEventListener("change", async () => {
  const picker = input("desk-file");
  const file = picker.files?.[0];
  picker.value = "";
  const note = $("desk-upload-note");
  if (!file || !selected) return;
  note.hidden = false;
  const { rejected } = checkFiles([{ name: file.name, size: file.size }], 0, options.limits);
  if (rejected[0]) {
    note.textContent = `${file.name} ${rejected[0].reason}.`;
    return;
  }
  note.textContent = `Sending ${file.name}...`;
  try {
    const { file: stored } = await uploadFile({ session: selected, file, token: readToken });
    note.textContent = `Sent ${stored.name}. In the file dialog of the remote browser, choose ${stored.path ?? `${stored.name} in the agent's files folder`}.`;
  } catch (error) {
    note.textContent = error instanceof ApiError ? uploadProblem(file.name, error.status, error.message) : `${file.name} could not be sent.`;
  }
});
$("desk-type-toggle").addEventListener("click", () => {
  const open = $("desk-type").hidden;
  $("desk-type").hidden = !open;
  $("desk-hint").hidden = !open;
  $("desk-type-toggle").setAttribute("aria-expanded", String(open));
  if (open) input("type-text").focus();
});
$("type-show").addEventListener("click", () => {
  const field = input("type-text");
  const show = field.type === "password";
  field.type = show ? "text" : "password";
  $("type-show").textContent = show ? "Hide" : "Show";
  $("type-show").setAttribute("aria-pressed", String(show));
});
$("desk-type").addEventListener("submit", async (event) => {
  event.preventDefault();
  const field = input("type-text");
  const text = field.value;
  if (text === "") return;
  field.value = "";
  await desk.sendText(text);
  field.focus();
});

// ---------- shortcuts: Cmd/Ctrl+\\ folds the desk, Cmd/Ctrl+K makes a new bot; never while the desktop has the keyboard ----------
document.addEventListener("keydown", (event) => {
  if (!(event.metaKey || event.ctrlKey) || event.altKey || event.shiftKey) return;
  if (document.activeElement?.closest("#desk-screen")) return; // the keys belong to the remote desktop
  if (event.key === "\\" && selected && options.liveView) {
    event.preventDefault();
    if (deskState === "docked") collapseDesk();
    else if (deskState === "chip" || deskState === "closed") void dockFromChip();
  } else if (event.key.toLowerCase() === "k") {
    event.preventDefault();
    openBotSheet();
  }
});

// ---------- start ----------
$("greeting").textContent = greeting(new Date().getHours());
$("scroller").addEventListener("scroll", () => {
  $("top").dataset.scrolled = String($("scroller").scrollTop > 0);
});
$("token-form").addEventListener("submit", (event) => {
  event.preventDefault();
  try {
    sessionStorage.setItem(tokenKey, input("token").value.trim());
  } catch {
    // no storage: the token then lasts until the page is reloaded
  }
  location.reload();
});

function route() {
  const match = /^#\/s\/([A-Za-z0-9_-]+)$/.exec(location.hash);
  if (match?.[1]) {
    void openSession(match[1]);
  } else {
    selected = null;
    leaveSession();
    renderRail();
    render();
  }
  $("desk-pill").hidden = !selected || !options.liveView;
}
window.addEventListener("hashchange", route);

async function start() {
  try {
    options = await api.options();
    startupBanner(startupWarnings(options.startup));
    setConnection("live");
  } catch (error) {
    if (error instanceof ApiError && error.status === 401) setConnection("unauthorized");
    else setConnection("down");
  }
  await refreshSessions();
  // Opening the page continues the last conversation, as a chat app does; a new bot is one click away.
  if (!location.hash) {
    let remembered = null;
    try {
      remembered = localStorage.getItem(lastBotKey);
    } catch {
      // no storage: the bot with the latest message is opened instead
    }
    const id = continueWith(rows, remembered);
    if (id) history.replaceState(null, "", `#/s/${id}`);
  }
  route();
  setInterval(() => void pollHealth(), 5000);
  setInterval(() => void refreshSessions(), 5000);
}
void start();
