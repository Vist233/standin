import { type Delivery, type EventDraft, type JsonValue, type MessageAttachment, OgbError, type SignalDraft } from "@standin/contracts";
import type { EventJournal } from "@standin/event-journal";
import { Router, type RouterInput, type RouterOptions, type RouterOutput } from "@standin/router";
import type { Agent, Event } from "sakura-agent";
import { describeRunError, errorKindOf, JournalMapper, pauseOf, runReasonOf, textOf, retryableRun } from "./events.ts";
import { repairAfterRestart } from "./repair.ts";
import { applyToWaiting, emptyWaiting, type Waiting, waitingFrom } from "./waiting.ts";
import type { LogSink, SessionStatus } from "./types.ts";

export interface ActorDeps {
  sessionId: string;
  agent: Agent;
  journal: EventJournal;
  routerOptions: RouterOptions | undefined;
  now: () => number;
  log: LogSink;
  /** Called before every run starts (the runtime raises the turn limit here: the framework counts turns for the whole session). */
  beforeRun?: () => Promise<void>;
  /** Called after a run's end is journalled, not awaited (the summary line is made here). */
  afterRun?: () => void;
  /** The run time limit in milliseconds, used only to tell a time pause from a budget pause in the journal. */
  maxRunMs?: number;
  /** Told after a question or a take-over event is written, so the wait limits can be looked at again. */
  onAnnounce?: (type: string) => void;
}

/**
 * Everything that happens to one session goes through here, one thing at a time. The order of work for an input:
 * (1) write it to the journal (the commit point), (2) let the router decide, (3) carry out the deliveries.
 * If (1) fails nothing else has happened, so a refused write leaves no trace. Because the router is deterministic,
 * the journalled inputs are enough to rebuild its state after a restart; the decisions and deliveries are derived.
 */
export class SessionActor {
  private readonly router: Router;
  private chain: Promise<unknown> = Promise.resolve();
  private readonly runs = new Set<Promise<void>>();
  /** Steered texts handed to the current run and not yet read by the model, oldest first. */
  private pendingSteers: { deliveryId: string; text: string }[] = [];
  private timer: ReturnType<typeof setTimeout> | undefined;
  private closed = false;
  /** Set when the journal refused a write of an agent event; new input is refused until the session is reopened. */
  private fault: unknown;
  private readonly mapper = new JournalMapper();
  /** What the person's side is doing, folded from every event this actor writes (and from the journal at open). */
  private waiting: Waiting = emptyWaiting();
  private runStartedAt = 0;
  private holds = 0;
  /** Files named by messages submitted but not yet read by the agent, found again by the text the agent reads. Lost in a crash: the text still names them. */
  private readonly attachmentsByText = new Map<string, MessageAttachment[]>();
  private callsSettled: (() => void)[] = [];

  private readonly deps: ActorDeps;

  constructor(deps: ActorDeps) {
    this.deps = deps;
    this.router = new Router(deps.routerOptions);
  }

  get sessionId(): string {
    return this.deps.sessionId;
  }

  // ---------- public, each call is serialized ----------

  /** A message from the person. */
  async message(id: string, text: string, answers: "person" | "takeover" | false = "person", attachments: readonly MessageAttachment[] = []): Promise<void> {
    if (attachments.length > 0) this.attachmentsByText.set(text, [...attachments]);
    if (answers) await this.answerQuestions(answers);
    return this.submit({ type: "signal", sessionId: this.sessionId, at: this.deps.now(), draft: { id, source: "user", text } }).then(() => {});
  }

  signal(draft: SignalDraft): Promise<void> {
    return this.submit({ type: "signal", sessionId: this.sessionId, at: this.deps.now(), draft }).then(() => {});
  }

  stop(id: string): Promise<void> {
    return this.submit({ type: "stop", sessionId: this.sessionId, at: this.deps.now(), id }).then(() => {});
  }

  /** An informational event for readers of the journal (not a router input). */
  async announce(type: string, payload: JsonValue): Promise<void> {
    await this.record(type, payload);
    if (type.startsWith("human.") || type.startsWith("takeover.")) this.deps.onAnnounce?.(type);
  }

  /** A question waited past its limit: it is given up, and the hold it caused ends, so the agent can be told and go on. */
  async expireQuestion(id: string, afterMinutes: number): Promise<void> {
    if (!this.waiting.questions.some((q) => q.id === id)) return;
    await this.announce("human.expired", { id, afterMinutes });
  }

  /** Ends the hold of Stop or of waiting, without a message from the person. */
  releaseHold(): Promise<void> {
    return this.submit({ type: "release", sessionId: this.sessionId, at: this.deps.now() }).then(() => {});
  }

  /** The person answered every open question (in words, or by doing it themselves during a take-over). */
  async answerQuestions(by: "person" | "takeover"): Promise<void> {
    for (const { id } of [...this.waiting.questions]) await this.announce("human.answered", { id, by });
  }

  /** True while a question that needs the person's hands (login, code) or a take-over is open: nothing may start a run. */
  hasOpenQuestions(): boolean {
    return this.waiting.questions.length > 0;
  }

  /**
   * Holds the session like Stop does, but lets a tool call that is running finish first (at most `settleMs`): a person who
   * presses Take over should not cut a click in half. After that the run is cancelled, which also ends a call still running.
   */
  async holdForPerson(id: string, settleMs: number): Promise<void> {
    if (this.mapper.openCalls > 0) {
      await new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, settleMs);
        timer.unref();
        this.callsSettled.push(() => {
          clearTimeout(timer);
          resolve();
        });
      });
    }
    await this.stop(id);
  }

  /** What the person's side is doing: open questions, pending approvals, the take-over, texts waiting for its end. Read only. */
  get waitingFor(): Readonly<Waiting> {
    return this.waiting;
  }

  status(): SessionStatus {
    const view = this.router.inspect(this.sessionId);
    return {
      run: view.run,
      held: view.held,
      queued: view.queued.length,
      pending: this.waiting.questions.length + this.waiting.approvals.length,
      lastRunEnd: this.waiting.lastRunEnd,
    };
  }

  /** Resolves when no run is going and nothing is being processed (waiting signals in a held session do not count). */
  async idle(): Promise<void> {
    for (;;) {
      await this.chain.catch(() => {});
      if (this.runs.size === 0) return;
      await Promise.all([...this.runs]);
    }
  }

  async close(): Promise<void> {
    this.closed = true;
    if (this.timer) clearTimeout(this.timer);
    this.deps.agent.cancel();
    await this.idle();
  }

  // ---------- opening: rebuild the router, then settle what a crash left half done ----------

  /**
   * Replays the journalled router inputs, then looks at what was in flight when the last process died.
   * - A delivery whose text is already in the conversation (the framework wrote it before the crash) is treated as read,
   *   so it is not delivered twice.
   * - A run that was going is resumed by the framework; unread steers go back to the queue.
   * - Texts are compared by count: the conversation must hold more copies of a text than the journal has settled.
   */
  async open(): Promise<void> {
    const issued = new Map<string, Delivery>();
    const settledCount = new Map<string, number>();
    const settle = (deliveryId: string) => {
      const d = issued.get(deliveryId);
      if (!d || d.kind === "stop") return;
      const text = d.kind === "start-run" ? d.input : d.text;
      settledCount.set(text, (settledCount.get(text) ?? 0) + 1);
    };
    const stored = await this.deps.journal.read(this.sessionId);
    this.waiting = waitingFrom(stored);
    for (const draft of repairAfterRestart(stored)) await this.record(draft.type, draft.payload);
    for (const event of stored) {
      if (event.type !== "router.input") continue;
      const input = event.payload as unknown as RouterInput;
      for (const delivery of this.router.handle(input).deliveries) issued.set(delivery.id, delivery);
      if (input.type === "delivery-acked") settle(input.deliveryId);
      if (input.type === "run-started" && input.deliveryId !== undefined) settle(input.deliveryId);
    }
    const view = this.router.inspect(this.sessionId);
    if (view.run === "idle") {
      this.scheduleWakeup();
      return;
    }

    const inLog = new Map<string, number>();
    for (const message of await this.deps.agent.log.project()) {
      if (message.role === "user") inLog.set(textOf(message.content), (inLog.get(textOf(message.content)) ?? 0) + 1);
    }
    await this.exclusive(async () => {
      for (const id of view.unsettled) {
        const delivery = issued.get(id);
        if (!delivery || delivery.kind === "stop") continue;
        const text = delivery.kind === "start-run" ? delivery.input : delivery.text;
        if ((inLog.get(text) ?? 0) <= (settledCount.get(text) ?? 0)) continue; // not in the conversation: it was never read
        settledCount.set(text, (settledCount.get(text) ?? 0) + 1);
        await this.apply(
          delivery.kind === "start-run"
            ? { type: "run-started", sessionId: this.sessionId, at: this.deps.now(), deliveryId: id }
            : { type: "delivery-acked", sessionId: this.sessionId, at: this.deps.now(), deliveryId: id },
        );
      }
      const wasActive = this.router.inspect(this.sessionId).run === "active";
      const out = await this.apply({ type: "run-finished", sessionId: this.sessionId, at: this.deps.now() });
      if (wasActive && !out.deliveries.some((d) => d.kind === "start-run")) {
        // nothing is waiting, so the interrupted run is simply continued by the framework (a finished conversation ends at once)
        await this.beginRun(undefined);
        await this.apply({ type: "run-started", sessionId: this.sessionId, at: this.deps.now() });
      }
    });
  }

  // ---------- internals ----------

  private submit(input: RouterInput): Promise<RouterOutput> {
    if (this.closed) return Promise.reject(new OgbError("unavailable", `session '${this.sessionId}' is closed`));
    if (this.fault)
      return Promise.reject(
        new OgbError("unavailable", `session '${this.sessionId}' cannot write its journal; reopen it after fixing the disk`, { cause: this.fault }),
      );
    return this.exclusive(() => this.apply(input));
  }

  private exclusive<T>(work: () => Promise<T>): Promise<T> {
    const result = this.chain.then(work, work);
    this.chain = result.catch(() => {});
    return result;
  }

  /** Must run inside `exclusive`. */
  private async apply(input: RouterInput): Promise<RouterOutput> {
    await this.write({ type: "router.input", payload: input as unknown as JsonValue });
    const output = this.router.handle(input);
    for (const decision of output.decisions) await this.record("signal.decision", decision as unknown as JsonValue);
    for (const delivery of output.deliveries) {
      await this.record("delivery.issued", delivery as unknown as JsonValue);
      await this.execute(delivery);
    }
    this.scheduleWakeup();
    return output;
  }

  /** The only way an event reaches the journal from here: written first, then folded into `waiting`. */
  private async write(draft: EventDraft): Promise<void> {
    await this.deps.journal.append(this.sessionId, draft);
    applyToWaiting(this.waiting, { ...draft, at: this.deps.now() });
  }

  /** Informational events: the router inputs are the truth, so a failure here is logged and does not undo anything. */
  private async record(type: string, payload: JsonValue): Promise<void> {
    try {
      await this.write({ type, payload });
    } catch (error) {
      this.deps.log({ level: "error", message: "journal write failed", type, error: String(error) });
    }
  }

  private async execute(delivery: Delivery): Promise<void> {
    switch (delivery.kind) {
      case "start-run":
        await this.beginRun(delivery.input);
        await this.apply({ type: "run-started", sessionId: this.sessionId, at: this.deps.now(), deliveryId: delivery.id });
        break;
      case "steer":
        this.pendingSteers.push({ deliveryId: delivery.id, text: delivery.text });
        this.deps.agent.steer(delivery.text);
        break;
      case "stop":
        this.deps.agent.cancel();
        break;
    }
  }

  private async beginRun(input: string | undefined): Promise<void> {
    await this.deps.beforeRun?.();
    this.runStartedAt = this.deps.now();
    this.trackRun(input === undefined ? this.deps.agent.run() : this.deps.agent.run(input));
  }

  private trackRun(handle: ReturnType<Agent["run"]>): void {
    const done = (async () => {
      try {
        for await (const event of handle.events) await this.onEvent(event);
      } catch (error) {
        this.deps.log({ level: "error", message: "run events failed", error: String(error) });
      }
      let result: { reason: "done" | "cancelled" | "paused" | "error"; pause?: Parameters<typeof pauseOf>[0]; error?: string } = { reason: "error" };
      try {
        result = await handle.result;
      } catch (error) {
        result = { reason: "error", error: String(error) };
        this.deps.log({ level: "error", message: "run failed", error: String(error) });
      }
      this.pendingSteers = []; // steers the run never read are given back by run-finished
      this.deps.log({ level: "info", message: "run finished", reason: result.reason });
      for (const draft of this.mapper.interrupt()) await this.record(draft.type, draft.payload);
      await this.settled();
      if (result.reason === "error" || result.pause === "quota") {
        const kind = errorKindOf(result.error, result.pause);
        await this.record("session.error", {
          kind,
          message: result.pause === "quota" && !result.error ? "The model provider says the quota is used up." : describeRunError(result.error),
          retryable: retryableRun(kind, result.error),
        });
      }
      const pause = result.pause ? pauseOf(result.pause, this.deps.now() - this.runStartedAt, this.deps.maxRunMs) : undefined;
      await this.record("run.finished", { reason: runReasonOf(result.reason), ...(pause ? { pause } : {}) });
      this.deps.afterRun?.();
      if (!this.closed)
        await this.submit({ type: "run-finished", sessionId: this.sessionId, at: this.deps.now() }).catch((error) =>
          this.deps.log({ level: "error", message: "run-finished refused", error: String(error) }),
        );
      // A run that ended to wait for the person (login, code) holds the session: only the person's next message releases it.
      if (!this.closed && result.pause === "input" && this.waiting.questions.length > 0)
        await this.stop(`wait-${this.deps.now()}-${++this.holds}`).catch((error) =>
          this.deps.log({ level: "error", message: "could not hold the session", error: String(error) }),
        );
    })();
    this.runs.add(done);
    void done.finally(() => this.runs.delete(done));
  }

  private async onEvent(event: Event): Promise<void> {
    for (const mapped of this.mapper.map(event)) {
      const draft = this.withAttachments(mapped);
      try {
        await this.write(draft);
      } catch (error) {
        this.fault = error;
        this.deps.agent.cancel(); // stop before losing data
        this.deps.log({ level: "error", message: "journal write failed during a run; session stopped", error: String(error) });
      }
    }
    if (event.type === "tool_end") await this.settled();
    if (event.type === "message_end" && event.message.role === "user") {
      const text = textOf(event.message.content);
      const index = this.pendingSteers.findIndex((s) => s.text === text);
      if (index !== -1) {
        const [steer] = this.pendingSteers.splice(index, 1);
        if (steer && !this.fault) await this.submit({ type: "delivery-acked", sessionId: this.sessionId, at: this.deps.now(), deliveryId: steer.deliveryId });
      }
    }
  }

  /** A `message.user` the agent has read gets the files its text was sent with. */
  private withAttachments(draft: EventDraft): EventDraft {
    if (draft.type !== "message.user" || this.attachmentsByText.size === 0) return draft;
    const content = (draft.payload as { content?: { type: string; text?: string }[] } | null)?.content;
    const text = Array.isArray(content) ? textOf(content) : "";
    const attachments = this.attachmentsByText.get(text);
    if (!attachments) return draft;
    this.attachmentsByText.delete(text);
    return { type: draft.type, payload: { ...(draft.payload as object), attachments } as unknown as JsonValue };
  }

  private async settled(): Promise<void> {
    if (this.mapper.openCalls > 0) return;
    for (const wake of this.callsSettled.splice(0)) wake();
  }

  private scheduleWakeup(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
    const wake = this.router.nextWakeup();
    if (wake === undefined || this.closed) return;
    this.timer = setTimeout(() => void this.submit({ type: "tick", at: this.deps.now() }).catch(() => {}), Math.max(0, wake - this.deps.now()));
    this.timer.unref();
  }
}
