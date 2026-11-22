import type { EventJournal } from "@standin/event-journal";
import type { SessionEvent } from "@standin/contracts";
import { waitingFrom } from "./waiting.ts";

/** Optional limits on waiting for the person, in minutes. Unset means wait for ever. */
export interface WaitLimits {
  /** How long a question to the person may stay unanswered. */
  humanWaitMinutes?: number;
  /** How long a take-over may stay open. */
  takeoverMaxMinutes?: number;
}

export type WaitItem = { kind: "question"; id: string; minutes: number } | { kind: "takeover"; minutes: number };
export interface Due {
  /** The wait that has run out, with the limit that applied. */
  expired: WaitItem[];
  /** When the next wait runs out, in the journal's time; undefined when nothing is waiting under a limit. */
  nextAt: number | undefined;
}

const MINUTE = 60_000;

/**
 * Which waits have run out at `now`, and when the next one will. Pure: the journal decides what is waiting (a question with
 * no answer, no expiry; a take-over with no close), so the answer survives a restart.
 */
export function dueWaits(events: readonly SessionEvent[], limits: WaitLimits, now: number): Due {
  const out: Due = { expired: [], nextAt: undefined };
  const consider = (startedAt: number, minutes: number, item: WaitItem) => {
    const at = startedAt + minutes * MINUTE;
    if (at <= now) out.expired.push(item);
    else out.nextAt = Math.min(out.nextAt ?? at, at);
  };
  const waiting = waitingFrom(events);
  if (limits.humanWaitMinutes !== undefined) {
    for (const question of waiting.questions)
      consider(question.at, limits.humanWaitMinutes, { kind: "question", id: question.id, minutes: limits.humanWaitMinutes });
  }
  if (limits.takeoverMaxMinutes !== undefined && waiting.takeover) {
    consider(waiting.takeover.since, limits.takeoverMaxMinutes, { kind: "takeover", minutes: limits.takeoverMaxMinutes });
  }
  return out;
}

export interface WaitWatcherDeps {
  sessionId: string;
  journal: EventJournal;
  limits: WaitLimits;
  now: () => number;
  /** Runs `fn` after `ms` and returns a function that cancels it. Injected so tests need no real waiting. */
  schedule: (fn: () => void, ms: number) => () => void;
  /** Gives up one wait. Must record the end of it in the journal, so that the next check does not find it again. */
  expire: (item: WaitItem) => Promise<void>;
  onError: (error: unknown) => void;
}

export interface WaitWatcher {
  /** Looks at the journal now, gives up what has run out, and sets one timer for the next. Call after a question or take-over starts, and when the session opens. */
  refresh(): Promise<void>;
  stop(): void;
}

/** Keeps at most one timer per session, for the earliest wait that has a limit. With no limits it never schedules anything. */
export function createWaitWatcher(deps: WaitWatcherDeps): WaitWatcher {
  let cancel: (() => void) | undefined;
  let stopped = false;
  let chain: Promise<void> = Promise.resolve();

  async function check(): Promise<void> {
    cancel?.();
    cancel = undefined;
    if (stopped) return;
    const { expired, nextAt } = dueWaits(await deps.journal.read(deps.sessionId, 0), deps.limits, deps.now());
    for (const item of expired) await deps.expire(item);
    if (stopped) return;
    const next = expired.length > 0 ? dueWaits(await deps.journal.read(deps.sessionId, 0), deps.limits, deps.now()).nextAt : nextAt;
    if (next !== undefined) cancel = deps.schedule(() => void watcher.refresh(), Math.max(0, next - deps.now()));
  }

  const watcher: WaitWatcher = {
    refresh() {
      if (deps.limits.humanWaitMinutes === undefined && deps.limits.takeoverMaxMinutes === undefined) return Promise.resolve();
      chain = chain.then(check).catch(deps.onError);
      return chain;
    },
    stop() {
      stopped = true;
      cancel?.();
      cancel = undefined;
    },
  };
  return watcher;
}
