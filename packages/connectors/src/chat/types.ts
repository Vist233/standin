/**
 * The seam to chat bridges (docs/26 4.3). The bridges themselves (a Matrix homeserver with mautrix bridges, a Satori server over
 * QQ, Feishu, DingTalk, WeChat) run apart from Vesper and are maintained apart; Vesper speaks one of two standard protocols to them.
 */
export interface ChatEvent {
  /** Unique within the bridge: a retry or a replay gives the same id. */
  id: string;
  room: string;
  /** The sender's id on the bridge (`@alice:example.org`, a Satori user id). */
  sender: string;
  senderName?: string | undefined;
  text: string;
  /** Milliseconds since the epoch. */
  at: number;
  /** The message this one replies to, when the protocol says so (used to route the person's replies). */
  replyTo?: string | undefined;
}

export interface ChatSource {
  /**
   * The events after `cursor` (none of the history before the first call), waiting up to the protocol's long-poll time when there are
   * none. The returned cursor goes into the next call; kept on disk, it carries a restart over.
   */
  next(cursor: string | undefined, signal?: AbortSignal): Promise<{ events: ChatEvent[]; cursor: string }>;
  /** Writes `text` into `room`; returns the id of the message it made. */
  send(room: string, text: string): Promise<{ id: string }>;
  /** The bridge account's own id: its own messages are never events. */
  readonly self?: string | undefined;
}
