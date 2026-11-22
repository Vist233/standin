import type { EventDraft, SessionEvent } from "@standin/contracts";

/**
 * The journal is the commit point of a session: an event exists once `append` has resolved, and then it
 * survives a crash. Sequence numbers start at 1 per session and never have gaps or repeats.
 */
export interface EventJournal {
  /** Resolves with the stored event (sequence number and time filled in). Concurrent calls are ordered. */
  append(sessionId: string, draft: EventDraft): Promise<SessionEvent>;

  /** Events with `seq > after`, in order. `after` defaults to 0 (everything). Unknown sessions have no events. */
  read(sessionId: string, after?: number): Promise<SessionEvent[]>;

  /**
   * Replays events with `seq > after` and then follows new ones, in order, without gaps or repeats, until the caller
   * stops iterating or the journal is closed. `after` is the `Last-Event-ID` of a reconnecting page.
   */
  subscribe(sessionId: string, after?: number): AsyncIterable<SessionEvent>;

  /** Highest sequence number of the session, 0 when it has none. */
  lastSeq(sessionId: string): Promise<number>;

  /** Ends subscriptions and releases files. Appends after close fail with `unavailable`. */
  close(): Promise<void>;
}
