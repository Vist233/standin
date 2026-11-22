import type { Decision, Delivery, SignalDraft } from "@standin/contracts";

/**
 * Everything the router can be told. Every input carries `at` (milliseconds on the caller's clock), so the router
 * never reads a clock itself. Inputs are plain JSON: journalling them and replaying them rebuilds the exact state.
 */
export type RouterInput =
  | { type: "signal"; sessionId: string; at: number; draft: SignalDraft }
  | { type: "stop"; sessionId: string; at: number; id: string }
  /** Ends the hold that Stop (or waiting for the person) set, without a message from the person. Used when a wait gives up. */
  | { type: "release"; sessionId: string; at: number }
  /** The run that a `start-run` delivery asked for has begun. Without `deliveryId`: a run began by other means (resume after a restart). */
  | { type: "run-started"; sessionId: string; at: number; deliveryId?: string }
  /** The run ended (finished, failed or was stopped). Deliveries the run did not consume are given back to the queue. */
  | { type: "run-finished"; sessionId: string; at: number }
  /** A `steer` was consumed by the model (it is part of the conversation now). */
  | { type: "delivery-acked"; sessionId: string; at: number; deliveryId: string }
  /** A `start-run` or `steer` could not be carried out. Its signals return to the queue and are retried after `retryDelayMs`. */
  | { type: "delivery-failed"; sessionId: string; at: number; deliveryId: string }
  /** Time passed; lets a held group (merge window) or a retry become due. */
  | { type: "tick"; at: number };

export interface RouterOutput {
  deliveries: Delivery[];
  decisions: Decision[];
}

export interface RouterOptions {
  /** Quick signals of one source that arrive within this many ms of the first are delivered as one (default 0: never hold). */
  mergeWindowMs?: number;
  /** How long a signal waits after a failed delivery before it is offered again (default 1000). */
  retryDelayMs?: number;
  /** How many recent signal ids per session are remembered for duplicate detection (default 10000). */
  rememberedIds?: number;
}

export type RunState = "idle" | "starting" | "active";

/** Read-only view for logs and tests. */
export interface SessionView {
  run: RunState;
  /** True after Stop until the user writes again. */
  held: boolean;
  queued: string[];
  unsettled: string[];
}
