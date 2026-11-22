import type { Delivery, SignalDraft } from "@standin/contracts";
import { Router } from "../router.ts";
import type { RouterInput, RouterOptions, RouterOutput } from "../types.ts";
import { FakeClock } from "./fake-clock.ts";

interface SimSession {
  run: "idle" | "starting" | "active";
  startDelivery: Delivery | undefined;
  /** Steers handed to the run and not yet consumed by a model turn. They are lost if the run ends first (the framework drops them). */
  pendingSteers: Delivery[];
}

export interface Consumption {
  sessionId: string;
  signalId: string;
  how: "start-input" | "steer";
}

/**
 * The part of the real runtime that the router depends on, as a small model that follows the protocol of
 * `RouterInput`: it reports what happened, in order. It records which signals reached the model, which is
 * what "delivered" means, and it throws if the router ever breaks a rule (two runs at once, a steer to a
 * run that does not exist, a start while a run is active).
 */
export class SimulatedRuntime {
  readonly clock = new FakeClock();
  readonly router: Router;
  readonly consumed: Consumption[] = [];
  readonly stopped: string[] = [];
  readonly outputs: RouterOutput[] = [];
  private readonly sessions = new Map<string, SimSession>();
  /** Sessions where Stop was pressed and the user has not written since: no run may start there. */
  private readonly held = new Set<string>();
  private backlog: Delivery[] = [];
  private executing = false;

  constructor(options: RouterOptions = {}) {
    this.router = new Router(options);
  }

  private session(sessionId: string): SimSession {
    let found = this.sessions.get(sessionId);
    if (!found) {
      found = { run: "idle", startDelivery: undefined, pendingSteers: [] };
      this.sessions.set(sessionId, found);
    }
    return found;
  }

  state(sessionId: string): SimSession["run"] {
    return this.session(sessionId).run;
  }

  /** Sends an input to the router and carries out whatever it delivers. */
  send(input: RouterInput): RouterOutput {
    const output = this.router.handle(input);
    this.outputs.push(output);
    // Reports caused by executing a delivery (a Stop ends the run) are sent while we are inside this loop;
    // their deliveries wait their turn so that deliveries are carried out in the order the router issued them.
    this.backlog.push(...output.deliveries);
    if (!this.executing) {
      this.executing = true;
      try {
        for (let delivery = this.backlog.shift(); delivery; delivery = this.backlog.shift()) this.execute(delivery);
      } finally {
        this.executing = false;
        this.backlog = [];
      }
    }
    return output;
  }

  signal(sessionId: string, draft: SignalDraft): RouterOutput {
    if (draft.source === "user") this.held.delete(sessionId);
    return this.send({ type: "signal", sessionId, at: this.clock.now(), draft });
  }

  stop(sessionId: string, id: string): RouterOutput {
    this.held.add(sessionId);
    return this.send({ type: "stop", sessionId, at: this.clock.now(), id });
  }

  tick(): RouterOutput {
    return this.send({ type: "tick", at: this.clock.now() });
  }

  advance(ms: number): void {
    this.clock.advance(ms);
    this.tick();
  }

  /** The run that was asked for begins; its input is consumed. */
  completeStart(sessionId: string): boolean {
    const session = this.session(sessionId);
    const delivery = session.startDelivery;
    if (session.run !== "starting" || !delivery || delivery.kind !== "start-run") return false;
    session.run = "active";
    session.startDelivery = undefined;
    for (const signalId of delivery.signalIds) this.consumed.push({ sessionId, signalId, how: "start-input" });
    this.send({ type: "run-started", sessionId, at: this.clock.now(), deliveryId: delivery.id });
    return true;
  }

  /** A model turn happens: every steer handed to the run is read, in order, and acknowledged. */
  consumeSteers(sessionId: string): number {
    const session = this.session(sessionId);
    if (session.run !== "active") return 0;
    const steers = session.pendingSteers.splice(0);
    for (const steer of steers) {
      for (const signalId of steer.signalIds) this.consumed.push({ sessionId, signalId, how: "steer" });
      this.send({ type: "delivery-acked", sessionId, at: this.clock.now(), deliveryId: steer.id });
    }
    return steers.length;
  }

  /** The run ends; steers it had not yet read are lost, exactly as the framework drops them. */
  finishRun(sessionId: string): boolean {
    const session = this.session(sessionId);
    if (session.run === "idle") return false;
    session.run = "idle";
    session.startDelivery = undefined;
    session.pendingSteers = [];
    this.send({ type: "run-finished", sessionId, at: this.clock.now() });
    return true;
  }

  /** The runtime cannot carry out the waiting steers (or the start) and says so, in order. */
  failPending(sessionId: string): number {
    const session = this.session(sessionId);
    const failed: Delivery[] = [...(session.startDelivery ? [session.startDelivery] : []), ...session.pendingSteers];
    if (session.startDelivery) session.run = "idle";
    session.startDelivery = undefined;
    session.pendingSteers = [];
    for (const delivery of failed) this.send({ type: "delivery-failed", sessionId, at: this.clock.now(), deliveryId: delivery.id });
    return failed.length;
  }

  private execute(delivery: Delivery): void {
    const session = this.session(delivery.sessionId);
    switch (delivery.kind) {
      case "start-run":
        if (this.held.has(delivery.sessionId)) throw new Error(`router started a run in ${delivery.sessionId} while it was held after Stop`);
        if (session.run !== "idle") throw new Error(`router started a run in ${delivery.sessionId} while it was ${session.run}`);
        session.run = "starting";
        session.startDelivery = delivery;
        break;
      case "steer":
        if (session.run === "active") {
          session.pendingSteers.push(delivery);
        } else if (session.run === "idle") {
          // The framework would drop this silently; the adapter notices and reports it. It must not happen
          // while the router believes a run is active, so a failure here is a router bug.
          throw new Error(`router steered ${delivery.sessionId} while no run was active`);
        } else {
          throw new Error(`router steered ${delivery.sessionId} while its run was still starting`);
        }
        break;
      case "stop":
        this.stopped.push(...delivery.signalIds);
        this.finishRun(delivery.sessionId);
        break;
    }
  }

  /** Lets time pass and finishes everything in flight until nothing is running and nothing is waiting except in held sessions. Returns false if it did not settle. */
  drain(maxRounds = 10_000): boolean {
    for (let round = 0; round < maxRounds; round += 1) {
      let progressed = false;
      for (const sessionId of [...this.sessions.keys()]) {
        if (this.completeStart(sessionId)) progressed = true;
        if (this.consumeSteers(sessionId) > 0) progressed = true;
        if (this.state(sessionId) === "active" && this.finishRun(sessionId)) progressed = true;
      }
      const wake = this.router.nextWakeup();
      if (!progressed && wake !== undefined) {
        this.clock.set(wake);
        this.tick();
        progressed = true;
      }
      if (!progressed) return this.isQuiet();
    }
    return false;
  }

  isQuiet(): boolean {
    for (const sessionId of this.sessions.keys()) {
      const view = this.router.inspect(sessionId);
      if (view.run !== "idle" || view.unsettled.length > 0) return false;
      if (view.queued.length > 0 && !view.held) return false; // a held session keeps its queue until the user writes
    }
    return true;
  }
}
