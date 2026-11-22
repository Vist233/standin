import { isOgbError } from "@standin/contracts";
import { describe, expect, it } from "vitest";
import type { EventJournal } from "../journal.ts";

export interface JournalHarness {
  journal: EventJournal;
  /** Makes the next append fail the way a full disk does. */
  failNextAppend(): void;
  cleanup(): Promise<void>;
}

async function take<T>(iterator: AsyncIterator<T>, count: number): Promise<T[]> {
  const items: T[] = [];
  while (items.length < count) {
    const next = await iterator.next();
    if (next.done) break;
    items.push(next.value);
  }
  return items;
}

/** Behaviour every journal must have; run against the memory fake and the file implementation. */
export function journalContract(name: string, create: () => Promise<JournalHarness>): void {
  describe(`journal contract: ${name}`, () => {
    async function withJournal(body: (harness: JournalHarness) => Promise<void>) {
      const harness = await create();
      try {
        await body(harness);
      } finally {
        await harness.journal.close();
        await harness.cleanup();
      }
    }

    it("numbers events from 1 without gaps and stamps the schema version", async () => {
      await withJournal(async ({ journal }) => {
        const first = await journal.append("s1", { type: "message.user", payload: { text: "hi" } });
        const second = await journal.append("s1", { type: "message.assistant", payload: null });
        expect([first.seq, second.seq]).toEqual([1, 2]);
        expect(first).toMatchObject({ v: 1, sessionId: "s1", type: "message.user", payload: { text: "hi" } });
        expect(await journal.lastSeq("s1")).toBe(2);
        expect(await journal.lastSeq("other")).toBe(0);
      });
    });

    it("keeps sessions apart", async () => {
      await withJournal(async ({ journal }) => {
        await journal.append("a", { type: "x.y", payload: 1 });
        await journal.append("b", { type: "x.y", payload: 2 });
        expect((await journal.read("a")).map((e) => e.payload)).toEqual([1]);
        expect((await journal.read("b")).map((e) => e.seq)).toEqual([1]);
        expect(await journal.read("never-used")).toEqual([]);
      });
    });

    it("reads only what comes after a sequence number", async () => {
      await withJournal(async ({ journal }) => {
        for (let i = 0; i < 5; i += 1) await journal.append("s1", { type: "x.y", payload: i });
        expect((await journal.read("s1", 3)).map((e) => e.seq)).toEqual([4, 5]);
        expect(await journal.read("s1", 5)).toEqual([]);
        expect(await journal.read("s1", 99)).toEqual([]);
      });
    });

    it("orders concurrent appends and loses none", async () => {
      await withJournal(async ({ journal }) => {
        const stored = await Promise.all(Array.from({ length: 50 }, (_, i) => journal.append("s1", { type: "x.y", payload: i })));
        expect(stored.map((e) => e.seq)).toEqual(Array.from({ length: 50 }, (_, i) => i + 1));
        const read = await journal.read("s1");
        expect(read.map((e) => e.payload)).toEqual(Array.from({ length: 50 }, (_, i) => i)); // same order as the calls
      });
    });

    it("resumes a subscription after a sequence number (Last-Event-ID) and then follows live events", async () => {
      await withJournal(async ({ journal }) => {
        for (let i = 1; i <= 3; i += 1) await journal.append("s1", { type: "x.y", payload: i });
        const iterator = journal.subscribe("s1", 1)[Symbol.asyncIterator]();
        const replayed = await take(iterator, 2);
        expect(replayed.map((e) => e.seq)).toEqual([2, 3]);
        const pending = take(iterator, 2);
        await journal.append("s1", { type: "x.y", payload: 4 });
        await journal.append("s1", { type: "x.y", payload: 5 });
        expect((await pending).map((e) => e.seq)).toEqual([4, 5]);
        await iterator.return?.();
      });
    });

    it("gives a subscriber that starts at 0 everything, exactly once, while appends are racing", async () => {
      await withJournal(async ({ journal }) => {
        await journal.append("s1", { type: "x.y", payload: 0 });
        const iterator = journal.subscribe("s1")[Symbol.asyncIterator]();
        const collected = take(iterator, 21);
        await Promise.all(Array.from({ length: 20 }, (_, i) => journal.append("s1", { type: "x.y", payload: i + 1 })));
        expect((await collected).map((e) => e.seq)).toEqual(Array.from({ length: 21 }, (_, i) => i + 1));
        await iterator.return?.();
      });
    });

    it("serves several subscribers independently and ends them when the journal closes", async () => {
      await withJournal(async ({ journal }) => {
        const a = journal.subscribe("s1")[Symbol.asyncIterator]();
        const b = journal.subscribe("s1", 1)[Symbol.asyncIterator]();
        const gotA = take(a, 2);
        await journal.append("s1", { type: "x.y", payload: 1 });
        await journal.append("s1", { type: "x.y", payload: 2 });
        expect((await gotA).map((e) => e.seq)).toEqual([1, 2]);
        expect((await take(b, 1)).map((e) => e.seq)).toEqual([2]);
        const ended = a.next();
        await journal.close();
        expect((await ended).done).toBe(true);
      });
    });

    it("refuses bad input with invalid_input", async () => {
      await withJournal(async ({ journal }) => {
        await expect(journal.append("../escape", { type: "x.y", payload: null })).rejects.toSatisfy((e) => isOgbError(e, "invalid_input"));
        await expect(journal.append("s1", { type: "", payload: null })).rejects.toSatisfy((e) => isOgbError(e, "invalid_input"));
        await expect(journal.append("s1", { type: "x.y", payload: undefined as never })).rejects.toSatisfy((e) => isOgbError(e, "invalid_input"));
        await expect(journal.read("a/b")).rejects.toSatisfy((e) => isOgbError(e, "invalid_input"));
      });
    });

    it("on a failed write stores nothing, does not use up a sequence number and keeps working", async () => {
      await withJournal(async ({ journal, failNextAppend }) => {
        await journal.append("s1", { type: "x.y", payload: 1 });
        failNextAppend();
        await expect(journal.append("s1", { type: "x.y", payload: 2 })).rejects.toSatisfy((e) => isOgbError(e, "unavailable"));
        expect(await journal.lastSeq("s1")).toBe(1);
        const next = await journal.append("s1", { type: "x.y", payload: 3 });
        expect(next.seq).toBe(2);
        expect((await journal.read("s1")).map((e) => e.payload)).toEqual([1, 3]);
      });
    });

    it("refuses appends after close", async () => {
      await withJournal(async ({ journal }) => {
        await journal.close();
        await expect(journal.append("s1", { type: "x.y", payload: null })).rejects.toSatisfy((e) => isOgbError(e, "unavailable"));
      });
    });
  });
}
