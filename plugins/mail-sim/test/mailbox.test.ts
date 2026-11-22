import { mkdirSync, mkdtempSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { providerContract } from "@standin/connectors/testing";
import { afterEach, describe, expect, it } from "vitest";
import { createFileMailbox } from "../src/mailbox.ts";

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});
const tempDir = () => {
  const dir = mkdtempSync(join(tmpdir(), "ogb-mailsim-"));
  dirs.push(dir);
  return dir;
};

/** Drops a message as an outside party would: a file appears in `inbox/`. */
function drop(directory: string, name: string, mail: Record<string, unknown>) {
  const path = join(directory, "inbox", `${name}.json`);
  writeFileSync(`${path}.part`, JSON.stringify(mail));
  renameSync(`${path}.part`, path);
}

// The same suite every real provider must pass.
providerContract("mail-sim (file mailbox)", async () => {
  const directory = tempDir();
  let counter = 0;
  let clock = 1_000_000;
  const provider = createFileMailbox({
    directory,
    address: "agent@sim.test",
    pollMs: 10,
    now: () => {
      clock += 1000;
      return clock;
    },
  });
  return {
    provider,
    address: "agent@sim.test",
    async deliver(mail) {
      counter += 1;
      clock += 1000;
      drop(directory, `d${counter}`, { ...mail, date: clock });
    },
    async addExternalEvent(event) {
      counter += 1;
      writeFileSync(join(directory, "calendar", `x${counter}.json`), JSON.stringify(event));
    },
    settle: () => new Promise((resolve) => setTimeout(resolve, 60)),
    cleanup: async () => {},
  };
});

describe("the file mailbox itself", () => {
  it("makes mail arrive from a dropped file whose id is the file name, with the date from the file or its modification time", async () => {
    const directory = tempDir();
    const mailbox = createFileMailbox({ directory, address: "a@sim.test" });
    drop(directory, "invoice-1", { from: "ann@a.test", subject: "Invoice", body: "pay" });
    const [summary] = (await mailbox.mail?.reader?.list({})) ?? [];
    expect(summary).toMatchObject({ id: "invoice-1", folder: "inbox", from: "ann@a.test", unread: true });
    expect(summary?.date).toBeGreaterThan(1_000_000_000_000);
    expect((await mailbox.mail?.reader?.read("invoice-1"))?.to).toEqual(["a@sim.test"]);
  });

  it("ignores files that are not mail, half-written files and unsafe ids, and remembers what was read across instances", async () => {
    const directory = tempDir();
    const mailbox = createFileMailbox({ directory, address: "a@sim.test" });
    writeFileSync(join(directory, "inbox", "broken.json"), "{not json");
    writeFileSync(join(directory, "inbox", "wrong.json"), JSON.stringify({ hello: 1 }));
    writeFileSync(join(directory, "inbox", "notes.txt"), "x");
    drop(directory, "ok", { from: "a@a.test", subject: "ok", body: "b" });
    const reader = mailbox.mail?.reader;
    expect((await reader?.list({}))?.map((m) => m.id)).toEqual(["ok"]);
    await expect(reader?.read("../../etc/passwd")).rejects.toThrow(/no message/);
    await reader?.read("ok");
    const again = createFileMailbox({ directory, address: "a@sim.test" });
    expect((await again.mail?.reader?.list({ unreadOnly: true })) ?? []).toEqual([]);
  });

  it("writes sent mail as a file in sent/ and events as files in calendar/, and marks the agent's own events", async () => {
    const directory = tempDir();
    const mailbox = createFileMailbox({ directory, address: "a@sim.test", now: () => 5000 });
    const sent = await mailbox.mail?.sender?.send({ to: ["b@b.test"], subject: "Hi", body: "Body" });
    expect(readdirSync(join(directory, "sent"))).toEqual([`${sent?.id}.json`]);
    expect(JSON.parse(readFileSync(join(directory, "sent", `${sent?.id}.json`), "utf8"))).toMatchObject({
      from: "a@sim.test",
      to: ["b@b.test"],
      subject: "Hi",
    });
    const event = await mailbox.calendar?.create({ title: "T", start: 1, end: 2, attendees: [] });
    expect(event?.id.startsWith("self-")).toBe(true);
    expect(readdirSync(join(directory, "calendar"))).toEqual([`${event?.id}.json`]);
  });

  it("does not report the agent's own events, but does report one dropped from outside", async () => {
    const directory = tempDir();
    const mailbox = createFileMailbox({ directory, address: "a@sim.test", pollMs: 10 });
    const seen: string[] = [];
    const stop = mailbox.calendar?.watch((e) => void seen.push(e.title));
    await mailbox.calendar?.create({ title: "Mine", start: 1, end: 2, attendees: [] });
    mkdirSync(join(directory, "calendar"), { recursive: true });
    writeFileSync(join(directory, "calendar", "invite.json"), JSON.stringify({ title: "Theirs", start: 5, end: 6, attendees: [] }));
    await new Promise((r) => setTimeout(r, 80));
    stop?.();
    expect(seen).toEqual(["Theirs"]);
  });

  it("refuses an invalid event id", async () => {
    const mailbox = createFileMailbox({ directory: tempDir(), address: "a@sim.test" });
    await expect(mailbox.calendar?.read("../x")).rejects.toThrow(/invalid event id/);
  });
});
