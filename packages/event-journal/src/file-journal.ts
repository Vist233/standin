import { mkdir, open, readFile, truncate } from "node:fs/promises";
import type { FileHandle } from "node:fs/promises";
import { join } from "node:path";
import { EVENT_SCHEMA_VERSION, type EventDraft, OgbError, type SessionEvent } from "@standin/contracts";
import type { EventJournal } from "./journal.ts";
import { assertDraft, assertSessionId, formatEvent, parseLog } from "./log-format.ts";
import { followSession, Listeners } from "./subscription.ts";

export interface FileJournalOptions {
  directory: string;
  /** Milliseconds since the epoch; injected so tests are deterministic. */
  now?: () => number;
  /** Flush each append to disk before resolving (default true). Turn off only for throwaway data. */
  fsync?: boolean;
  /** Replaces the single write of one line; tests use it to simulate a disk that fills up half way through a line. */
  writeLine?: (handle: FileHandle, line: string) => Promise<unknown>;
}

interface SessionState {
  seq: number;
  size: number;
  handle: FileHandle | undefined;
  /** Appends of one session run one after another; this is the tail of that chain. */
  tail: Promise<unknown>;
  listeners: Listeners;
}

/**
 * One file per session, `<directory>/<sessionId>.jsonl`. Exactly one process may write a directory: a second
 * writer would assign the same sequence numbers. (The runtime is one process; a lock file is a later addition.)
 */
export function createFileJournal(options: FileJournalOptions): EventJournal {
  const now = options.now ?? Date.now;
  const fsync = options.fsync ?? true;
  const writeLine = options.writeLine ?? ((handle: FileHandle, line: string) => handle.write(line));
  const sessions = new Map<string, Promise<SessionState>>();
  let closed = false;

  const pathOf = (sessionId: string) => join(options.directory, `${sessionId}.jsonl`);

  async function readText(sessionId: string): Promise<string> {
    try {
      return await readFile(pathOf(sessionId), "utf8");
    } catch (cause) {
      if ((cause as NodeJS.ErrnoException).code === "ENOENT") return "";
      throw new OgbError("unavailable", `cannot read journal of '${sessionId}'`, { cause });
    }
  }

  /** First touch of a session: parse the file, cut off an interrupted last write, remember the sequence number. */
  async function load(sessionId: string): Promise<SessionState> {
    const parsed = parseLog(await readText(sessionId), sessionId);
    if (parsed.torn) {
      try {
        await truncate(pathOf(sessionId), parsed.validBytes);
      } catch (cause) {
        throw new OgbError("unavailable", `cannot repair the interrupted last write of '${sessionId}'`, { cause });
      }
    }
    return { seq: parsed.events.length, size: parsed.validBytes, handle: undefined, tail: Promise.resolve(), listeners: new Listeners() };
  }

  function stateOf(sessionId: string): Promise<SessionState> {
    assertSessionId(sessionId);
    let state = sessions.get(sessionId);
    if (!state) {
      state = load(sessionId);
      sessions.set(sessionId, state);
      // A failed load must not be cached: the next call tries again (the disk may have recovered).
      state.catch(() => sessions.delete(sessionId));
    }
    return state;
  }

  async function writeOne(sessionId: string, state: SessionState, draft: EventDraft): Promise<SessionEvent> {
    const event: SessionEvent = { v: EVENT_SCHEMA_VERSION, seq: state.seq + 1, at: now(), sessionId, type: draft.type, payload: draft.payload };
    const line = formatEvent(event);
    try {
      if (!state.handle) {
        await mkdir(options.directory, { recursive: true });
        state.handle = await open(pathOf(sessionId), "a");
      }
      await writeLine(state.handle, line);
      if (fsync) await state.handle.datasync();
    } catch (cause) {
      await discardPartialWrite(sessionId, state);
      throw new OgbError("unavailable", `cannot append to journal of '${sessionId}'`, { cause });
    }
    state.seq = event.seq;
    state.size += Buffer.byteLength(line);
    state.listeners.publish(event);
    return event;
  }

  /** After a failed write the file may hold part of the line: cut back to the last good size so the log stays valid. */
  async function discardPartialWrite(sessionId: string, state: SessionState): Promise<void> {
    const handle = state.handle;
    state.handle = undefined;
    await handle?.close().catch(() => {});
    await truncate(pathOf(sessionId), state.size).catch(() => {});
  }

  const journal: EventJournal = {
    async append(sessionId, draft) {
      if (closed) throw new OgbError("unavailable", "journal is closed");
      assertDraft(draft);
      const state = await stateOf(sessionId);
      const result = state.tail.then(() => writeOne(sessionId, state, draft));
      state.tail = result.catch(() => {}); // one failed append must not block the ones behind it
      return result;
    },

    async read(sessionId, after = 0) {
      const state = await stateOf(sessionId);
      await state.tail; // an append that was accepted before this call is visible to it
      const { events } = parseLog(await readText(sessionId), sessionId);
      return events.filter((event) => event.seq > after);
    },

    subscribe(sessionId, after = 0) {
      return (async function* () {
        const state = await stateOf(sessionId);
        yield* followSession({ listeners: state.listeners, readHistory: () => journal.read(sessionId, after), after, isClosed: () => closed });
      })();
    },

    async lastSeq(sessionId) {
      const state = await stateOf(sessionId);
      await state.tail;
      return state.seq;
    },

    async close() {
      closed = true;
      for (const pending of sessions.values()) {
        const state = await pending.catch(() => undefined);
        if (!state) continue;
        state.listeners.wakeAll();
        await state.tail;
        await state.handle?.close().catch(() => {});
        state.handle = undefined;
      }
    },
  };
  return journal;
}
