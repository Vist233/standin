import type { MessageAttachment, SessionEvent, TakeoverOpenedPayload } from "@standin/contracts";

/** What the person's side of a session is doing, folded from the journal. The one place that knows how these events end. */
export interface Waiting {
  /** Questions to the person with no answer and no expiry, oldest first. `at` is when it was asked. */
  questions: { id: string; at: number }[];
  /** Approvals with no decision and no expiry. */
  approvals: { id: string; tool: string; at: number }[];
  /** The open take-over, or null. `viewed` is true once a viewer connected. */
  takeover: { since: number; viewed: boolean } | null;
  /** Texts the person wrote during a take-over that no signal has delivered yet, oldest first. */
  queued: { id: string; text: string; attachments?: MessageAttachment[] }[];
  /** The `reason` of the last `run.finished`, or null before any run ended. */
  lastRunEnd: string | null;
}

export const emptyWaiting = (): Waiting => ({ questions: [], approvals: [], takeover: null, queued: [], lastRunEnd: null });

/** Folds one more event into `waiting`. Unknown events and odd payloads change nothing, so it can be fed every event of the journal. */
export function applyToWaiting(waiting: Waiting, event: { type: string; payload: unknown; at: number }): void {
  const payload = (typeof event.payload === "object" && event.payload !== null ? event.payload : {}) as Record<string, unknown>;
  const id = typeof payload.id === "string" ? payload.id : "";
  switch (event.type) {
    case "human.question":
      if (id) waiting.questions.push({ id, at: event.at });
      break;
    case "human.answered":
    case "human.expired":
      waiting.questions = waiting.questions.filter((q) => q.id !== id);
      break;
    case "approval.requested":
      if (id) waiting.approvals.push({ id, tool: typeof payload.tool === "string" ? payload.tool : "", at: event.at });
      break;
    case "approval.decided":
    case "approval.expired":
      waiting.approvals = waiting.approvals.filter((a) => a.id !== id);
      break;
    case "takeover.opened":
      waiting.takeover = { since: (event.payload as TakeoverOpenedPayload).since, viewed: false };
      break;
    case "takeover.viewer_connected":
      if (waiting.takeover) waiting.takeover.viewed = true;
      break;
    case "takeover.closed":
      waiting.takeover = null;
      break;
    case "message.queued":
      if (id && typeof payload.text === "string" && !waiting.queued.some((q) => q.id === id))
        waiting.queued.push({
          id,
          text: payload.text,
          ...(Array.isArray(payload.attachments) ? { attachments: payload.attachments as MessageAttachment[] } : {}),
        });
      break;
    case "router.input": {
      // A signal with this id reached the router: a queued text is delivered.
      const draftId = (payload.draft as { id?: unknown } | undefined)?.id;
      if (payload.type === "signal" && typeof draftId === "string") waiting.queued = waiting.queued.filter((q) => q.id !== draftId);
      break;
    }
    case "run.finished":
      waiting.lastRunEnd = typeof payload.reason === "string" ? payload.reason : null;
      break;
  }
}

export function waitingFrom(events: readonly SessionEvent[]): Waiting {
  const waiting = emptyWaiting();
  for (const event of events) applyToWaiting(waiting, event);
  return waiting;
}
