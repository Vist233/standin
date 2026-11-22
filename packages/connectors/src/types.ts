/** Times are milliseconds since the epoch. */
export interface MailSummary {
  id: string;
  folder: string;
  from: string;
  subject: string;
  date: number;
  unread: boolean;
}

export interface MailMessage extends MailSummary {
  to: string[];
  cc: string[];
  body: string;
}

export interface MailQuery {
  folder?: string;
  /** Words that must appear in the subject, sender or body. */
  text?: string;
  from?: string;
  unreadOnly?: boolean;
  /** Default 20. */
  limit?: number;
}

export interface MailDraft {
  to: string[];
  cc?: string[];
  subject: string;
  body: string;
}

/** Where a watch continues from, and how it reports its position (to be kept on disk by the caller). */
export interface MailWatchOptions {
  after?: string | undefined;
  onCursor?: ((cursor: string) => void) | undefined;
}

/** Stops a watch. Calling it twice is harmless. */
export type Stop = () => void;

/**
 * What a provider can do with mail it only reads. A plugin that offers this and not `MailSender` gives the agent read-only
 * mail: the host registers only the tools a provider supports. (Read-only is real only where the login itself is
 * scoped; a plugin's description says which.)
 */
export interface MailReader {
  /** Newest first. */
  list(query: MailQuery): Promise<MailSummary[]>;
  /** Marks the message as read. Unknown id: rejects with kind `not_found`. */
  read(id: string): Promise<MailMessage>;
  /**
   * Calls `onMail` once for each message that arrives after the watch started (never for mail that was already there). With `after`
   * (a cursor this provider gave earlier through `onCursor`) it first reports what arrived since that point, so mail that came while
   * the box was down is not lost. A cursor is the provider's own text; callers only keep it.
   */
  watch(onMail: (mail: MailSummary) => void, options?: MailWatchOptions): Stop;
}

export interface MailSender {
  /** Sends the message from the account's own address. Returns the id of the copy in the sent folder. */
  send(draft: MailDraft): Promise<{ id: string }>;
}

export interface CalendarEvent {
  id: string;
  title: string;
  start: number;
  end: number;
  attendees: string[];
  location?: string;
  description?: string;
}

export type NewCalendarEvent = Omit<CalendarEvent, "id">;

export interface CalendarProvider {
  /** Events that overlap the range, by start time. */
  list(range: { from: number; to: number }): Promise<CalendarEvent[]>;
  read(id: string): Promise<CalendarEvent>;
  create(event: NewCalendarEvent): Promise<CalendarEvent>;
  update(id: string, patch: Partial<NewCalendarEvent>): Promise<CalendarEvent>;
  /** Calls `onEvent` for each event that appears after the watch started. */
  watch(onEvent: (event: CalendarEvent) => void): Stop;
}

/**
 * An optional extra of providers that can make addresses (a domain's mail service, a mail API). `credential` is what reaches the new
 * address (a token): the caller keeps it where it keeps its own credentials (a plugin: its private data directory) and never shows it.
 */
export interface Provisioner {
  create(name: string): Promise<{ address: string; credential: string }>;
}

/** What a provider plugin hands over: any of the parts it supports. */
export interface Provider {
  mail?: { reader?: MailReader; sender?: MailSender };
  calendar?: CalendarProvider;
  provisioner?: Provisioner;
  /** The account's own address, used as the sender. */
  address?: string;
}

/** One entry of the accounts file: where the secrets are is a reference, never a value. */
export interface Account {
  name: string;
  kind: string;
  auth?: string;
  settings?: Record<string, unknown>;
}
