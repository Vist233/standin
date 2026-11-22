/**
 * A channel is one way the person and their bots talk: the page, mail to the person's own address, a chat platform. Every channel does the
 * same two things: what the person writes comes in through `inbox.receive` and becomes their message to the bot; what the person should get
 * goes out through `deliver`. The runtime knows channels only by this shape (docs/24 section 3).
 *
 * Only the person reaches a channel (an end they are signed in to). Text from anyone else, such as a mail from a stranger, is not a channel
 * message: it comes in as a plugin's signal and is marked untrusted.
 */
export interface Outgoing {
  sessionId: string;
  /** The bot's name, so the person knows who writes. */
  from: string;
  /** `notice`: the result of a scheduled run; `question`: something only the person can answer; `message`: what the bot sent them on purpose. */
  kind: "notice" | "question" | "message";
  text: string;
  at: number;
}

export interface ChannelInbox {
  /** The person wrote to a bot through this channel. */
  receive(sessionId: string, text: string): Promise<void>;
}

export interface Channel {
  readonly name: string;
  /** Starts listening for the person's messages, if this channel brings any in. */
  start?(inbox: ChannelInbox): void | Promise<void>;
  /** Gives the person something; the channel decides how (and whether, for example only while the page is closed). */
  deliver(message: Outgoing): Promise<void>;
  stop?(): void | Promise<void>;
}
