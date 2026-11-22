// @ts-check
// Pure functions of the view model besides the chat itself (chat.js): the cards that need the person, whether the desk
// should open by itself, the state of a contact, the composer's button, and the tab title.

import { fmtDuration } from "./text.js";

/**
 * @typedef {import("./model.js").Item} Item
 */

/**
 * What waits for the person: unanswered questions and undecided approvals, oldest first. Expired approvals are not in
 * the list (the page shows them disabled, in place, but nothing is asked of the person).
 * @param {{ items: readonly Item[] }} state
 */
export function needsYou(state) {
  return state.items.filter((item) => (item.kind === "question" && !item.answered) || (item.kind === "approval" && item.status === "pending"));
}

/** Restore an active take-over. Otherwise a recent browser action or open login question highlights the Desk button.
 * @param {{ items: readonly Item[], takeover: unknown, deskTrigger: import("./model.js").DeskTrigger | null }} state
 * @param {number} now
 * @param {number} [recentMs]
 * @returns {{ intent: "stage" | "light-chip", key: number } | null}
 */
export function deskIntent(state, now, recentMs = 30_000) {
  if (state.takeover) return { intent: "stage", key: -1 };
  const question = state.items.findLast((item) => item.kind === "question" && item.ask === "login" && !item.answered);
  if (question) return { intent: "light-chip", key: question.seq };
  const trigger = state.deskTrigger;
  if (trigger?.reason === "browser" && now - trigger.at <= recentMs) return { intent: "light-chip", key: trigger.run || trigger.seq };
  return null;
}

/**
 * The dot in the rail. Needs you beats error beats working beats idle; a take-over counts as needing the person.
 * @param {{ state?: { run: string } | null, pending?: number, lastRunEnd?: string | null, takeover?: boolean }} row
 * @returns {"needs" | "error" | "working" | "idle"}
 */
export function railStatus(row) {
  if ((row.pending ?? 0) > 0 || row.takeover) return "needs";
  if (row.state && row.state.run !== "idle") return "working";
  if (row.lastRunEnd === "error") return "error";
  return "idle";
}

/**
 * What the round button of the composer is. While a run goes it is Stop; with text in the box it steers instead (Enter
 * always sends the text, a click has to be able to as well); with nothing to send and nothing to stop it is disabled.
 * While the person is in control of the desktop nothing can be sent: a message would end the hold and let the agent act.
 * @param {boolean} running
 * @param {boolean} hasText
 * @param {boolean} [locked]
 * @returns {{ label: "Send" | "Steer" | "Stop", glyph: string, disabled: boolean, stops: boolean }}
 */
export function composerButton(running, hasText, locked = false) {
  if (locked) return { label: "Send", glyph: "↑", disabled: true, stops: false };
  if (running && !hasText) return { label: "Stop", glyph: "■", disabled: false, stops: true };
  return { label: running ? "Steer" : "Send", glyph: "↑", disabled: !hasText, stops: false };
}

/**
 * The one-line marker the timeline keeps for a question or an approval once its card is pinned above the composer (the card
 * exists once; the timeline only remembers that it happened and, when it is over, how long it took).
 * @param {Item} item
 * @returns {string}
 */
export function questionMarker(item) {
  if (item.kind === "question") {
    const login = item.ask === "login";
    if (!item.answered) return login ? "Asked you to sign in" : "Asked you a question";
    const took = item.answeredAt > item.at ? ` · ${fmtDuration(item.answeredAt - item.at)}` : "";
    return `${login ? "You signed in" : "You answered"}${took}`;
  }
  if (item.kind === "approval") {
    if (item.status === "pending") return `Asked you to allow ${item.tool}`;
    if (item.status === "approved") return `You allowed ${item.tool}`;
    if (item.status === "denied") return `You refused ${item.tool}`;
    return `Expired: ${item.tool}`;
  }
  return "";
}

/** The tab title: the name, with how many things wait for the person in front of it. */
export function titleBadge(/** @type {number} */ count) {
  return Number.isInteger(count) && count > 0 ? `(${count}) StandIn` : "StandIn";
}
