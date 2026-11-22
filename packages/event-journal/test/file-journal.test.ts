import { appendFileSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { isOgbError } from "@standin/contracts";
import { afterEach, describe, expect, it } from "vitest";
import { createFileJournal } from "../src/index.ts";
import { journalContract } from "../src/testing/index.ts";

const directories: string[] = [];
function tempDirectory(): string {
  const directory = mkdtempSync(join(tmpdir(), "ogb-journal-"));
  directories.push(directory);
  return directory;
}
afterEach(() => {
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

journalContract("file journal", async () => {
  const directory = tempDirectory();
  let failNext = false;
  const journal = createFileJournal({
    directory,
    writeLine: async (handle, line) => {
      if (failNext) {
        failNext = false;
        await handle.write(line.slice(0, line.length / 2)); // half a line reaches the disk, then the disk is full
        throw new Error("ENOSPC (simulated)");
      }
      await handle.write(line);
    },
  });
  return { journal, failNextAppend: () => (failNext = true), cleanup: async () => {} };
});

describe("file journal: durability and recovery", () => {
  it("survives a restart: sequence numbers continue and old events are read back", async () => {
    const directory = tempDirectory();
    const first = createFileJournal({ directory, now: () => 5 });
    await first.append("s1", { type: "x.y", payload: "a" });
    await first.append("s1", { type: "x.y", payload: "b" });
    await first.close();

    const second = createFileJournal({ directory });
    expect(await second.lastSeq("s1")).toBe(2);
    expect((await second.append("s1", { type: "x.y", payload: "c" })).seq).toBe(3);
    expect((await second.read("s1")).map((e) => [e.seq, e.payload, e.at])).toEqual([
      [1, "a", 5],
      [2, "b", 5],
      [3, "c", expect.any(Number)],
    ]);
    await second.close();
  });

  it("replays after a torn last line: drops the fragment, repairs the file, and carries on", async () => {
    const directory = tempDirectory();
    const first = createFileJournal({ directory });
    await first.append("s1", { type: "x.y", payload: 1 });
    await first.append("s1", { type: "x.y", payload: 2 });
    await first.close();
    appendFileSync(join(directory, "s1.jsonl"), '{"v":1,"seq":3,"at":1,"sessionId":"s1","type":"x.y","payl'); // power cut mid-write

    const second = createFileJournal({ directory });
    expect((await second.read("s1")).map((e) => e.seq)).toEqual([1, 2]);
    const next = await second.append("s1", { type: "x.y", payload: 3 });
    expect(next.seq).toBe(3);
    await second.close();
    const lines = readFileSync(join(directory, "s1.jsonl"), "utf8").trim().split("\n");
    expect(lines).toHaveLength(3);
    for (const line of lines) JSON.parse(line); // every line of the repaired file is whole
  });

  it("treats a last line that is complete JSON but has no newline as torn too", async () => {
    const directory = tempDirectory();
    writeFileSync(join(directory, "s1.jsonl"), '{"v":1,"seq":1,"at":1,"sessionId":"s1","type":"x.y","payload":1}');
    const journal = createFileJournal({ directory });
    expect(await journal.read("s1")).toEqual([]);
    expect((await journal.append("s1", { type: "x.y", payload: 2 })).seq).toBe(1);
    await journal.close();
  });

  it("after a write that failed half way, the log is valid and the sequence number is reused", async () => {
    const directory = tempDirectory();
    let fail = false;
    const journal = createFileJournal({
      directory,
      writeLine: async (handle, line) => {
        if (fail) {
          await handle.write(line.slice(0, 10));
          throw new Error("disk full");
        }
        await handle.write(line);
      },
    });
    await journal.append("s1", { type: "x.y", payload: 1 });
    fail = true;
    await expect(journal.append("s1", { type: "x.y", payload: 2 })).rejects.toSatisfy((e) => isOgbError(e, "unavailable"));
    fail = false;
    await journal.append("s1", { type: "x.y", payload: 3 });
    await journal.close();
    const reopened = createFileJournal({ directory });
    expect((await reopened.read("s1")).map((e) => [e.seq, e.payload])).toEqual([
      [1, 1],
      [2, 3],
    ]);
    await reopened.close();
  });

  it("reports damage inside the file as corrupt instead of guessing", async () => {
    const directory = tempDirectory();
    const good = '{"v":1,"seq":1,"at":1,"sessionId":"s1","type":"x.y","payload":1}\n';
    const cases: Record<string, string> = {
      "not json": `${good}garbage\n`,
      "not an event": `${good}{"hello":1}\n`,
      "wrong sequence": `${good}${good}`,
      "other session": '{"v":1,"seq":1,"at":1,"sessionId":"zzz","type":"x.y","payload":1}\n',
    };
    for (const [name, content] of Object.entries(cases)) {
      writeFileSync(join(directory, "s1.jsonl"), content);
      const journal = createFileJournal({ directory });
      await expect(journal.read("s1"), name).rejects.toSatisfy((e) => isOgbError(e, "corrupt"));
      await journal.close();
    }
  });

  it("refuses data written by a newer schema version", async () => {
    const directory = tempDirectory();
    writeFileSync(join(directory, "s1.jsonl"), '{"v":99,"seq":1,"at":1,"sessionId":"s1","type":"x.y","payload":1}\n');
    const journal = createFileJournal({ directory });
    await expect(journal.read("s1")).rejects.toSatisfy((e) => isOgbError(e, "unsupported_version"));
    await journal.close();
  });

  it("creates the directory on first append and does not create files for reads", async () => {
    const directory = join(tempDirectory(), "nested", "journal");
    const journal = createFileJournal({ directory });
    expect(await journal.read("s1")).toEqual([]);
    expect(existsSync(directory)).toBe(false);
    await journal.append("s1", { type: "x.y", payload: null });
    expect(existsSync(join(directory, "s1.jsonl"))).toBe(true);
    await journal.close();
  });
});
