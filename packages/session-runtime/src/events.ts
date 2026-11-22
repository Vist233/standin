import type { EventDraft, JsonValue, PauseReason, SessionErrorKind, ToolOutcome, ToolRef } from "@standin/contracts";
import type { Event, PauseReason as FrameworkPause, RunEndReason } from "sakura-agent";

/** A copy of any value as plain JSON (undefined becomes null). */
export function json(value: unknown): JsonValue {
  return JSON.parse(JSON.stringify(value ?? null)) as JsonValue;
}

const isObject = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);
const TARGET_KEYS = ["url", "path", "file_path", "target"] as const;

/** The id suffix `tool_call` gives the review of the inner call it runs (search-tools.ts). */
export const INNER_SUFFIX = "/inner";

/** What a call is about, with the `tool_call` indirection removed: the page shows `browser · open · https://...`. */
export function toolRefOf(call: { name: string; args?: unknown }): ToolRef {
  let name = call.name;
  let args: unknown = call.args;
  if (name === "tool_call" && isObject(args) && typeof args.name === "string") {
    name = args.name;
    args = args.args;
  }
  const input = isObject(args) ? args : {};
  const ref: ToolRef = { name };
  if (typeof input.action === "string") ref.action = input.action;
  for (const key of TARGET_KEYS) {
    const value = input[key];
    if (typeof value === "string" && value !== "") {
      ref.target = value.length > 300 ? `${value.slice(0, 300)}…` : value;
      break;
    }
  }
  return ref;
}

function callPayload(call: { id: string; name: string; args?: unknown }): Record<string, JsonValue> {
  const payload: Record<string, JsonValue> = { id: call.id, name: call.name, arguments: json(call.args), tool: json(toolRefOf(call)) };
  if (call.id.endsWith(INNER_SUFFIX)) payload.parentCallId = call.id.slice(0, -INNER_SUFFIX.length);
  return payload;
}

/** The framework's end-of-run reasons in the page's words (the fixtures of `@standin/contracts/testing` use these). */
export function runReasonOf(reason: RunEndReason): string {
  return reason === "done" ? "end" : reason === "paused" ? "pause" : reason;
}

export function outcomeOf(result: { content?: readonly { type: string; text?: string }[]; isError?: boolean; details?: unknown }): ToolOutcome {
  const marked = isObject(result.details) ? result.details.outcome : undefined;
  if (marked === "refused" || marked === "needs_approval" || marked === "interrupted") return marked;
  const first = textOf(result.content ?? []);
  if (result.isError && first.startsWith("Not allowed:")) return "refused"; // the loop's wording for a call a plugin denied
  return result.isError ? "error" : "ok";
}

/**
 * How the framework's run events become journal events (the page reads these). Streaming deltas are not journalled: the
 * finished message is, and a delta log would be most of the file. It remembers which calls have started, so that a call
 * that was refused before it started (the loop sends only an end) still shows as a call with a result, and so the actor can
 * wait for running calls to settle.
 */
export class JournalMapper {
  private readonly open = new Map<string, Record<string, JsonValue>>();

  get openCalls(): number {
    return this.open.size;
  }

  map(event: Event): EventDraft[] {
    switch (event.type) {
      case "run_start":
        return [{ type: "run.started", payload: null }];
      case "run_end":
        return []; // `run.finished` is written by the actor from the run's result, which carries the pause reason
      case "message_end":
        return [{ type: event.message.role === "user" ? "message.user" : "message.assistant", payload: json(event.message) }];
      case "tool_start": {
        const payload = callPayload(event.call);
        this.open.set(event.call.id, payload);
        return [{ type: "tool.call", payload }];
      }
      case "tool_end": {
        const drafts: EventDraft[] = [];
        let payload = this.open.get(event.call.id);
        if (!payload) {
          payload = callPayload(event.call);
          drafts.push({ type: "tool.call", payload });
        }
        this.open.delete(event.call.id);
        drafts.push({ type: "tool.result", payload: { call: payload, result: json(event.result), outcome: outcomeOf(event.result) } });
        return drafts;
      }
      case "paused":
        return [{ type: "agent.paused", payload: json(event.reason) }];
      case "compaction":
        return [{ type: "agent.compaction", payload: { tokensBefore: event.tokensBefore } }];
      case "goal":
        return [{ type: "agent.goal", payload: json(event.status) }];
      case "signal":
        return [{ type: "agent.signal", payload: { text: event.text } }];
      case "plugin":
        return [{ type: `agent.plugin.${event.name}`, payload: json(event.data) }];
      default:
        return []; // turn_start, turn_end, message_start, message_update, reasoning_update, message_reset
    }
  }

  /** The run is over: any call still open will not get a result from the loop. Returns closing results for them. */
  interrupt(): EventDraft[] {
    const drafts = [...this.open.values()].map((payload): EventDraft => ({ type: "tool.result", payload: interruptedResult(payload) }));
    this.open.clear();
    return drafts;
  }
}

export function interruptedResult(call: JsonValue): JsonValue {
  return {
    call,
    result: { content: [{ type: "text", text: "The run ended before this call finished." }], isError: true },
    outcome: "interrupted",
  };
}

/** Our pause vocabulary from the framework's (`approval` is the person's decision pending: the page calls it blocked). */
export function pauseOf(pause: FrameworkPause, elapsedMs: number, maxRunMs: number | undefined): { reason: PauseReason; detail?: string } {
  if (pause === "approval") return { reason: "blocked", detail: "waiting for an approval" };
  if (pause === "budget" && maxRunMs !== undefined && elapsedMs >= maxRunMs)
    return { reason: "time", detail: `the run reached its ${Math.round(maxRunMs / 1000)} s limit` };
  return { reason: pause };
}

const REDACTIONS: [RegExp, string][] = [
  [/Bearer\s+[A-Za-z0-9._~+/=-]{8,}/gi, "Bearer [redacted]"],
  [/\b(?:sk|key|tok)-[A-Za-z0-9_-]{8,}/g, "[redacted]"],
  [/([?&](?:api[_-]?key|token|key)=)[^&\s]+/gi, "$1[redacted]"],
];

/** The cause of a failed run for the person: one short line, with anything that looks like a credential removed. */
/** A provider often answers with a JSON body (`{"error":{"message":...}}`): its own sentence is what the person should read. */
function providerSentence(line: string): string {
  const start = line.indexOf("{");
  if (start === -1) return line;
  try {
    const body = JSON.parse(line.slice(start)) as { error?: { message?: unknown } | string; message?: unknown };
    const said = typeof body.error === "string" ? body.error : (body.error?.message ?? body.message);
    return typeof said === "string" && said.trim() !== "" ? `${line.slice(0, start).trim()} ${said.trim()}`.trim() : line;
  } catch {
    return line;
  }
}

/** Whether trying again can help: not for a request the provider refused as invalid (a wrong model name, a bad parameter). */
export function retryableRun(kind: SessionErrorKind, error: string | undefined): boolean {
  if (kind !== "network" && kind !== "model") return false;
  return !/invalid_request|unsupported|not supported|\b400\b/i.test(error ?? "");
}

export function describeRunError(error: string | undefined): string {
  let line = providerSentence((error ?? "").split("\n")[0]?.trim() ?? "");
  for (const [pattern, replacement] of REDACTIONS) line = line.replace(pattern, replacement);
  return line === "" ? "The run ended with an error and gave no reason." : line.length > 300 ? `${line.slice(0, 300)}…` : line;
}

export function errorKindOf(error: string | undefined, pause: FrameworkPause | undefined): SessionErrorKind {
  if (pause === "quota") return "quota";
  const text = (error ?? "").toLowerCase();
  if (/\b(401|403)\b|unauthori[sz]ed|forbidden|api key|invalid key|authentication/.test(text)) return "auth";
  if (/\b(402|429)\b|quota|rate limit|insufficient|balance|billing/.test(text)) return "quota";
  if (/econn|enotfound|etimedout|timed out|timeout|network|fetch failed|socket|dns|offline/.test(text)) return "network";
  if (/\b5\d\d\b|overloaded|context|model|provider|invalid_request|stream/.test(text)) return "model";
  return "other";
}

export function textOf(content: readonly { type: string; text?: string }[]): string {
  return content.map((part) => (part.type === "text" ? (part.text ?? "") : "")).join("");
}
