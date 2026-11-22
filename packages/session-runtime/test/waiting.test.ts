import { JOURNAL_FIXTURES } from "@standin/contracts/testing";
import { describe, expect, it } from "vitest";
import { applyToWaiting, emptyWaiting, waitingFrom } from "../src/waiting.ts";

describe("waitingFrom, with the shared journal fixtures", () => {
  it("a plain chat has nothing waiting and remembers how the last run ended", () => {
    expect(waitingFrom(JOURNAL_FIXTURES.plainChatTurn())).toEqual({ ...emptyWaiting(), lastRunEnd: "end" });
  });

  it("the login journey: the question waits until the take-over answers it; both take-overs end", () => {
    const events = JOURNAL_FIXTURES.loginTakeoverJourney();
    const asked = events.findIndex((e) => e.type === "human.question");
    expect(waitingFrom(events.slice(0, asked + 1)).questions).toEqual([{ id: "q_1", at: events[asked]?.at }]);
    const opened = events.findIndex((e) => e.type === "takeover.opened");
    expect(waitingFrom(events.slice(0, opened + 1)).takeover).toEqual({ since: events[opened]?.at, viewed: false });
    const viewer = events.findIndex((e) => e.type === "takeover.viewer_connected");
    expect(waitingFrom(events.slice(0, viewer + 1)).takeover).toMatchObject({ viewed: true });
    const done = waitingFrom(events);
    expect(done.questions).toEqual([]);
    expect(done.takeover).toBeNull();
    expect(done.lastRunEnd).toBe("end");
  });

  it("approvals: one pending, one expired by a restart", () => {
    const events = JOURNAL_FIXTURES.approvalsPendingAndExpired();
    expect(waitingFrom(events).approvals).toEqual([{ id: "a_2", tool: "post_public", at: events[3]?.at }]);
    expect(waitingFrom(events.slice(0, 4)).approvals.map((a) => a.id)).toEqual(["a_1", "a_2"]);
  });

  it("a question that expired no longer waits", () => {
    const events = JOURNAL_FIXTURES.waitLimitsReached();
    expect(waitingFrom(events.slice(0, 3)).questions).toHaveLength(1);
    expect(waitingFrom(events).questions).toEqual([]);
    expect(waitingFrom(events).takeover).toBeNull();
  });

  it("a text written during a take-over waits until a signal with its id reaches the router", () => {
    const events = JOURNAL_FIXTURES.messageQueuedDuringTakeover();
    const queued = events.findIndex((e) => e.type === "message.queued");
    expect(waitingFrom(events.slice(0, queued + 1)).queued).toEqual([{ id: "m_1", text: "Also check the second tab." }]);
    const waiting = waitingFrom(events.slice(0, queued + 1));
    applyToWaiting(waiting, { type: "router.input", payload: { type: "signal", draft: { id: "m_1" } }, at: 1 });
    expect(waiting.queued).toEqual([]);
  });

  it("ignores events it does not know and payloads of the wrong shape", () => {
    const waiting = emptyWaiting();
    for (const type of ["message.user", "tool.call", "human.question", "approval.requested", "run.finished", "plugin.x.y"])
      applyToWaiting(waiting, { type, payload: null, at: 1 });
    applyToWaiting(waiting, { type: "run.finished", payload: { reason: 3 }, at: 1 });
    expect(waiting).toEqual(emptyWaiting());
  });
});
