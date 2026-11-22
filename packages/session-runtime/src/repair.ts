import type { EventDraft, SessionEvent } from "@standin/contracts";
import { interruptedResult } from "./events.ts";
import { waitingFrom } from "./waiting.ts";

/**
 * What a restart leaves half done, as journal events to write when the session is opened again. The page then shows the
 * truth instead of a spinner that never ends: a take-over nobody can still be in, an approval that nobody can decide any
 * more (the book is in memory), tool calls that never got a result, and a run that started and never finished (the page
 * would count its time for ever). A run the framework then resumes writes a new `run.started`. Pure: the journal in, drafts out.
 */
export function repairAfterRestart(events: readonly SessionEvent[]): EventDraft[] {
  const drafts: EventDraft[] = [];

  const waiting = waitingFrom(events);
  if (waiting.takeover) {
    drafts.push({
      type: "takeover.closed",
      payload: { note: "The server restarted while the take-over was open.", viewed: waiting.takeover.viewed },
    });
  }
  for (const approval of waiting.approvals) drafts.push({ type: "approval.expired", payload: { id: approval.id, reason: "restart" } });

  const calls = new Map<string, SessionEvent>();
  for (const event of events) {
    if (event.type === "tool.call") calls.set((event.payload as { id: string }).id, event);
    else if (event.type === "tool.result") calls.delete((event.payload as { call?: { id?: string } }).call?.id ?? "");
  }
  for (const event of calls.values()) drafts.push({ type: "tool.result", payload: interruptedResult(event.payload) });

  const lastRun = events.findLast((event) => event.type === "run.started" || event.type === "run.finished");
  if (lastRun?.type === "run.started") drafts.push({ type: "run.finished", payload: { reason: "restart" } });

  return drafts;
}
