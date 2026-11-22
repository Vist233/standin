import { isJsonObject, type JsonValue } from "./json.ts";

/** Raise when a stored event changes shape in a way old readers cannot handle. */
export const EVENT_SCHEMA_VERSION = 1;

/** Event types the core writes. Plugins may add their own types, which must contain a dot (`plugin.name.thing`). */
export const CORE_EVENT_TYPES = [
  "router.input",
  "signal.decision",
  "delivery.issued",
  "run.started",
  "run.finished",
  "message.user",
  "message.assistant",
  "agent.message",
  "tool.call",
  "tool.result",
  "session.error",
  "human.question",
  "message.queued",
  "human.answered",
  "human.expired",
  "approval.requested",
  "approval.decided",
  "approval.expired",
  "takeover.opened",
  "takeover.viewer_connected",
  "takeover.closed",
  "session.summary",
  "session.notice",
  "schedule.changed",
  "safety.yolo",
] as const;

/*
 * Payload shapes of the core events, as the page reads them (usable plan D6, additive: a field added here never breaks an
 * old stored event, so every new field is optional unless it is new to a new event type). `EventDraft.payload` stays
 * `JsonValue`; these interfaces describe what is inside it. `model.retry` is deferred and not part of this vocabulary.
 */

/** What a tool call was about, unwrapped from the `tool_call` indirection so the page need not know it exists. */
export interface ToolRef {
  name: string;
  action?: string;
  /** The url or path the call acts on, when it has one. */
  target?: string;
}

export interface ToolCallPayload {
  id: string;
  name: string;
  arguments?: JsonValue;
  tool?: ToolRef;
  /** Set on the review event of an inner call: the id of the call it belongs to, so the page shows one line, not two. */
  parentCallId?: string;
}

const TOOL_OUTCOMES = ["ok", "error", "refused", "needs_approval", "interrupted"] as const;
export type ToolOutcome = (typeof TOOL_OUTCOMES)[number];

export interface ToolResultPayload {
  call: ToolCallPayload;
  result: JsonValue;
  outcome?: ToolOutcome;
}

export type SessionErrorKind = "auth" | "quota" | "network" | "model" | "other";
export interface SessionErrorPayload {
  kind: SessionErrorKind;
  message: string;
  retryable: boolean;
}

export type PauseReason = "budget" | "time" | "quota" | "blocked" | "input" | "stuck";
export interface RunFinishedPayload {
  reason: string;
  pause?: { reason: PauseReason; detail?: string };
}

export interface HumanQuestionPayload {
  id: string;
  question: string;
  kind?: "login" | "code" | "choice" | "info";
  /** The tab url (or other place) the question is about. */
  where?: string;
}
export interface HumanAnsweredPayload {
  id: string;
  by: "person" | "takeover";
}

/** A file the person attached to a message, as the page and the agent see it. `path` is where the agent's own tools find it. */
export interface MessageAttachment {
  name: string;
  size: number;
  path: string;
}

/** The part of a `message.user` payload that attachments add (the rest is the framework's message). */
export interface MessageUserExtras {
  attachments?: MessageAttachment[];
}

/** The person wrote while a take-over was open: the text waits and is delivered after the hand-back. */
export interface MessageQueuedPayload {
  id: string;
  text: string;
  attachments?: MessageAttachment[];
}

/** A question to the person that waited past the optional limit and was given up. */
export interface HumanExpiredPayload {
  id: string;
  afterMinutes: number;
}

export interface ApprovalRequestedPayload {
  id: string;
  tool: string;
  args: JsonValue;
}
export interface ApprovalDecidedPayload {
  id: string;
  approved: boolean;
}
export interface ApprovalExpiredPayload {
  id: string;
  reason: "restart" | "superseded" | "timeout";
}

export interface TakeoverOpenedPayload {
  since: number;
  workspaceId: string;
}
export type TakeoverViewerConnectedPayload = Record<string, never>;
export interface TakeoverClosedPayload {
  note?: string;
  /** True when a viewer connected to the desktop while the take-over was open. */
  viewed: boolean;
}

export interface EventDraft {
  type: string;
  payload: JsonValue;
}

/** What the journal stores and the page receives. `seq` starts at 1 and has no gaps inside one session. */
export interface SessionEvent extends EventDraft {
  v: number;
  seq: number;
  at: number; // milliseconds since the epoch, from the journal's clock
  sessionId: string;
}

/** Structural check of a parsed value; does not check that `type` is a known type. */
export function isSessionEvent(value: unknown): value is SessionEvent {
  if (!isJsonObject(value)) return false;
  return (
    Number.isInteger(value.v) &&
    Number.isInteger(value.seq) &&
    (value.seq as number) >= 1 &&
    typeof value.at === "number" &&
    Number.isFinite(value.at) &&
    typeof value.sessionId === "string" &&
    typeof value.type === "string" &&
    value.type.length > 0 &&
    "payload" in value
  );
}
