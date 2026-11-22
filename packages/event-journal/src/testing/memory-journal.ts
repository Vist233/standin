import { EVENT_SCHEMA_VERSION, type EventDraft, OgbError, type SessionEvent } from "@standin/contracts";
import type { EventJournal } from "../journal.ts";
import { assertDraft, assertSessionId } from "../log-format.ts";
import { followSession, Listeners } from "../subscription.ts";

export interface MemoryJournal extends EventJournal {
  /** The next `count` appends fail with `unavailable` and store nothing (a full disk). */
  failNextAppends(count?: number): void;
}

/** In-memory journal with the same contract as the file journal, for tests of other modules. */
export function createMemoryJournal(options: { now?: () => number } = {}): MemoryJournal {
  const now = options.now ?? Date.now;
  const logs = new Map<string, SessionEvent[]>();
  const listeners = new Map<string, Listeners>();
  let failures = 0;
  let closed = false;

  const logOf = (sessionId: string) => {
    assertSessionId(sessionId);
    const existing = logs.get(sessionId);
    if (existing) return existing;
    const created: SessionEvent[] = [];
    logs.set(sessionId, created);
    return created;
  };
  const listenersOf = (sessionId: string) => {
    const existing = listeners.get(sessionId);
    if (existing) return existing;
    const created = new Listeners();
    listeners.set(sessionId, created);
    return created;
  };

  const journal: MemoryJournal = {
    failNextAppends(count = 1) {
      failures = count;
    },
    async append(sessionId, draft: EventDraft) {
      if (closed) throw new OgbError("unavailable", "journal is closed");
      assertDraft(draft);
      const log = logOf(sessionId);
      if (failures > 0) {
        failures -= 1;
        throw new OgbError("unavailable", "disk full (simulated)");
      }
      const event: SessionEvent = {
        v: EVENT_SCHEMA_VERSION,
        seq: log.length + 1,
        at: now(),
        sessionId,
        type: draft.type,
        payload: structuredClone(draft.payload),
      };
      log.push(event);
      listenersOf(sessionId).publish(event);
      return structuredClone(event);
    },
    async read(sessionId, after = 0) {
      return structuredClone(logOf(sessionId).filter((event) => event.seq > after));
    },
    subscribe(sessionId, after = 0) {
      return followSession({ listeners: listenersOf(sessionId), readHistory: () => journal.read(sessionId, after), after, isClosed: () => closed });
    },
    async lastSeq(sessionId) {
      return logOf(sessionId).length;
    },
    async close() {
      closed = true;
      for (const set of listeners.values()) set.wakeAll();
    },
  };
  return journal;
}
