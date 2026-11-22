import type { Delivery, Signal, SignalDraft, SignalPriority, SignalSource, Trust } from "@standin/contracts";
import { renderGroup } from "./render.ts";
import type { RouterInput, RouterOptions, RouterOutput, RunState, SessionView } from "./types.ts";

interface Queued {
  signal: Signal;
  arrival: number; // global arrival counter: the tie-break that keeps arrival order
  notBefore: number; // a retried signal waits until this time
}

interface Unsettled {
  delivery: Delivery;
  items: Queued[];
}

interface SessionState {
  run: RunState;
  queue: Queued[]; // sorted by (priority, arrival)
  unsettled: Map<string, Unsettled>;
  seen: Set<string>;
  seenOrder: string[];
  deliveryCount: number;
  /** After Stop: nothing leaves the queue until the user writes again. */
  held: boolean;
}

export function trustOf(source: SignalSource): Trust {
  return source === "user" || source === "system" ? "trusted" : "untrusted";
}

export function priorityOf(source: SignalSource): SignalPriority {
  return source === "user" ? "user" : "normal";
}

const RANK: Record<SignalPriority, number> = { user: 0, normal: 1 };

/**
 * Turns signals into deliveries, one decision at a time. The rules:
 * - A session has at most one run at a time. Idle: the first due group starts a run with it as input. Active: it is
 *   steered, in order. Starting: signals wait (a run that has not begun cannot be steered).
 * - The user's own messages go ahead of everything not yet delivered; Stop is delivered at once; the rest keeps arrival order.
 * - Stop ends the run and holds the session: nothing is deleted, but nothing leaves the queue until the user's next
 *   message, which starts the run and brings the waiting signals along in order.
 * - Quick signals of one source may be merged into one delivery.
 * - A signal id is accepted once per session, so a producer that retries cannot cause a second delivery.
 * - A delivery that was not consumed (it failed, or the run ended first) goes back to the queue in its old place.
 * No clock, no I/O, no randomness: the same inputs give the same outputs.
 */
export class Router {
  private readonly sessions = new Map<string, SessionState>();
  private readonly mergeWindowMs: number;
  private readonly retryDelayMs: number;
  private readonly rememberedIds: number;
  private now = 0;
  private arrivalCounter = 0;

  constructor(options: RouterOptions = {}) {
    this.mergeWindowMs = options.mergeWindowMs ?? 0;
    this.retryDelayMs = options.retryDelayMs ?? 1000;
    this.rememberedIds = options.rememberedIds ?? 10_000;
  }

  handle(input: RouterInput): RouterOutput {
    this.now = Math.max(this.now, input.at);
    const out: RouterOutput = { deliveries: [], decisions: [] };
    if (input.type === "tick") {
      for (const sessionId of this.sessions.keys()) this.pump(sessionId, out);
      return out;
    }
    const session = this.session(input.sessionId);
    switch (input.type) {
      case "signal":
        this.onSignal(input.sessionId, session, input.draft, out);
        break;
      case "stop":
        this.onStop(input.sessionId, session, input.id, out);
        break;
      case "release":
        session.held = false;
        break;
      case "run-started":
        this.onRunStarted(session, input.deliveryId);
        break;
      case "run-finished":
        this.onRunFinished(session);
        break;
      case "delivery-acked":
        this.settle(session, input.deliveryId);
        break;
      case "delivery-failed":
        this.onDeliveryFailed(session, input.deliveryId);
        break;
    }
    this.pump(input.sessionId, out);
    return out;
  }

  /** The time at which a tick would change something (a held group becomes due, a retry becomes due), or undefined. */
  nextWakeup(): number | undefined {
    let earliest: number | undefined;
    for (const session of this.sessions.values()) {
      const head = session.queue[0];
      if (!head || session.run === "starting" || session.held) continue;
      const due = this.dueTime(session);
      if (due > this.now && (earliest === undefined || due < earliest)) earliest = due;
    }
    return earliest;
  }

  inspect(sessionId: string): SessionView {
    const session = this.sessions.get(sessionId);
    if (!session) return { run: "idle", held: false, queued: [], unsettled: [] };
    return { run: session.run, held: session.held, queued: session.queue.map((q) => q.signal.id), unsettled: [...session.unsettled.keys()] };
  }

  private session(sessionId: string): SessionState {
    let session = this.sessions.get(sessionId);
    if (!session) {
      session = { run: "idle", queue: [], unsettled: new Map(), seen: new Set(), seenOrder: [], deliveryCount: 0, held: false };
      this.sessions.set(sessionId, session);
    }
    return session;
  }

  private remember(session: SessionState, id: string): boolean {
    if (session.seen.has(id)) return false;
    session.seen.add(id);
    session.seenOrder.push(id);
    if (session.seenOrder.length > this.rememberedIds) {
      const oldest = session.seenOrder.shift();
      if (oldest !== undefined) session.seen.delete(oldest);
    }
    return true;
  }

  private onSignal(sessionId: string, session: SessionState, draft: SignalDraft, out: RouterOutput): void {
    if (!this.remember(session, draft.id)) {
      out.decisions.push({ sessionId, signalId: draft.id, outcome: "duplicate" });
      return;
    }
    const signal: Signal = {
      id: draft.id,
      source: draft.source,
      trust: trustOf(draft.source),
      priority: priorityOf(draft.source),
      at: this.now,
      text: draft.text,
    };
    if (signal.priority === "user") session.held = false;
    this.enqueue(session, { signal, arrival: this.arrivalCounter++, notBefore: 0 });
    out.decisions.push({ sessionId, signalId: signal.id, outcome: "queued", signal });
  }

  private onStop(sessionId: string, session: SessionState, id: string, out: RouterOutput): void {
    if (!this.remember(session, id)) {
      out.decisions.push({ sessionId, signalId: id, outcome: "duplicate" });
      return;
    }
    session.held = true;
    if (session.run === "idle") {
      out.decisions.push({ sessionId, signalId: id, outcome: "absorbed" }); // nothing to stop: not an error
      return;
    }
    out.deliveries.push({ kind: "stop", id: this.nextDeliveryId(sessionId, session), sessionId, signalIds: [id] });
  }

  private onRunStarted(session: SessionState, deliveryId: string | undefined): void {
    if (deliveryId !== undefined) {
      const pending = session.unsettled.get(deliveryId);
      if (pending?.delivery.kind !== "start-run") return; // stale or unknown report
      session.unsettled.delete(deliveryId);
    }
    session.run = "active";
  }

  private onRunFinished(session: SessionState): void {
    session.run = "idle";
    for (const id of [...session.unsettled.keys()]) this.giveBack(session, id, 0); // not a fault: offer again at once
  }

  private onDeliveryFailed(session: SessionState, deliveryId: string): void {
    const pending = session.unsettled.get(deliveryId);
    if (!pending) return;
    if (pending.delivery.kind === "start-run") session.run = "idle";
    this.giveBack(session, deliveryId, this.retryDelayMs);
  }

  private settle(session: SessionState, deliveryId: string): void {
    session.unsettled.delete(deliveryId);
  }

  /** Puts the signals of an unsettled delivery back in the queue at their old places, to be offered again (after a pause when the delivery failed). */
  private giveBack(session: SessionState, deliveryId: string, pauseMs: number): void {
    const pending = session.unsettled.get(deliveryId);
    if (!pending) return;
    session.unsettled.delete(deliveryId);
    for (const item of pending.items) this.enqueue(session, { ...item, notBefore: this.now + pauseMs });
  }

  private enqueue(session: SessionState, item: Queued): void {
    const key = (q: Queued) => RANK[q.signal.priority] * 1e12 + q.arrival;
    let index = session.queue.length;
    while (index > 0 && key(session.queue[index - 1] as Queued) > key(item)) index -= 1;
    session.queue.splice(index, 0, item);
  }

  /** How many items at the front of the queue form the next delivery. Merging never crosses source or priority. */
  private groupSize(session: SessionState): number {
    const head = session.queue[0];
    if (!head) return 0;
    let size = 1;
    while (size < session.queue.length) {
      const next = session.queue[size] as Queued;
      const sameKind = next.signal.source === head.signal.source && next.signal.priority === head.signal.priority;
      if (!sameKind || next.signal.at - head.signal.at > this.mergeWindowMs) break;
      size += 1;
    }
    return size;
  }

  /** When the front group may leave: after its retry pause and after its merge window, unless something else already closed the group. */
  private dueTime(session: SessionState): number {
    const head = session.queue[0] as Queued;
    const closedByOthers = this.groupSize(session) < session.queue.length;
    const windowEnd = closedByOthers ? 0 : head.signal.at + this.mergeWindowMs;
    return Math.max(head.notBefore, windowEnd);
  }

  private pump(sessionId: string, out: RouterOutput): void {
    const session = this.session(sessionId);
    while (session.queue.length > 0 && !session.held && session.run !== "starting" && this.dueTime(session) <= this.now) {
      const items = session.queue.splice(0, this.groupSize(session));
      const signals = items.map((item) => item.signal);
      const text = renderGroup(signals);
      const id = this.nextDeliveryId(sessionId, session);
      const signalIds = signals.map((s) => s.id);
      let delivery: Delivery;
      if (session.run === "idle") {
        delivery = { kind: "start-run", id, sessionId, signalIds, input: text };
        session.run = "starting"; // one turn at a time: nothing else leaves until the run has begun
      } else {
        delivery = { kind: "steer", id, sessionId, signalIds, text };
      }
      session.unsettled.set(id, { delivery, items });
      out.deliveries.push(delivery);
    }
  }

  private nextDeliveryId(sessionId: string, session: SessionState): string {
    session.deliveryCount += 1;
    return `${sessionId}:d${session.deliveryCount}`;
  }
}
