import { EVENT_SCHEMA_VERSION, isSessionEvent, OgbError, type SessionEvent } from "@standin/contracts";

export interface ParsedLog {
  events: SessionEvent[];
  /** Bytes of complete, valid lines. Anything after this is the tail of an interrupted write. */
  validBytes: number;
  torn: boolean;
}

/**
 * One event per line (JSON Lines). A line only counts once its newline is on disk, so a crash in the middle of a
 * write leaves a last line without a newline: that is dropped, never half-read. The writer had not been told the
 * append succeeded, so dropping it breaks no promise. A COMPLETE line that does not parse is a different matter
 * (disk damage): it is reported as `corrupt` and nothing is guessed.
 */
export function parseLog(text: string, sessionId: string): ParsedLog {
  const lastNewline = text.lastIndexOf("\n");
  const complete = lastNewline === -1 ? "" : text.slice(0, lastNewline + 1);
  const torn = complete.length !== text.length;
  const events: SessionEvent[] = [];
  const lines = complete === "" ? [] : complete.slice(0, -1).split("\n");
  lines.forEach((line, index) => {
    const expectedSeq = index + 1;
    let value: unknown;
    try {
      value = JSON.parse(line);
    } catch (cause) {
      throw new OgbError("corrupt", `journal of '${sessionId}': line ${expectedSeq} is not JSON`, { cause });
    }
    if (!isSessionEvent(value)) throw new OgbError("corrupt", `journal of '${sessionId}': line ${expectedSeq} is not an event`);
    if (value.v > EVENT_SCHEMA_VERSION) {
      throw new OgbError(
        "unsupported_version",
        `journal of '${sessionId}': line ${expectedSeq} has schema version ${value.v}, this code reads up to ${EVENT_SCHEMA_VERSION}`,
      );
    }
    if (value.sessionId !== sessionId) throw new OgbError("corrupt", `journal of '${sessionId}': line ${expectedSeq} belongs to '${value.sessionId}'`);
    if (value.seq !== expectedSeq) throw new OgbError("corrupt", `journal of '${sessionId}': expected seq ${expectedSeq} but found ${value.seq}`);
    events.push(value);
  });
  return { events, validBytes: Buffer.byteLength(complete), torn };
}

export function formatEvent(event: SessionEvent): string {
  return `${JSON.stringify(event)}\n`;
}

const SESSION_ID = /^[A-Za-z0-9_-]{1,128}$/;

/** Session ids become file names, so anything that could leave the directory is refused up front. */
export function assertSessionId(sessionId: string): void {
  if (!SESSION_ID.test(sessionId)) throw new OgbError("invalid_input", "session id must be 1 to 128 characters of letters, digits, '-' or '_'");
}

export function assertDraft(draft: { type: string; payload: unknown }): void {
  if (typeof draft.type !== "string" || draft.type === "") throw new OgbError("invalid_input", "event type must be a non-empty string");
  if (draft.payload === undefined) throw new OgbError("invalid_input", "event payload must be JSON (use null for none)");
}
