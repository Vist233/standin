import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Channel, Outgoing } from "@vesper/contracts";
import { createFileSessionStore } from "@vesper/session-store";
import { afterEach, describe, expect, it } from "vitest";
import { editPerson, PERSON_MAX } from "../src/person.ts";
import { createScheduler, parseWhen, type ScheduledJob } from "../src/scheduler.ts";
import { createRig, type Rig } from "../src/testing/index.ts";

const dirs: string[] = [];
const rigs: Rig[] = [];
afterEach(async () => {
  for (const r of rigs.splice(0)) await r.cleanup();
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});
const T0 = Date.parse("2026-11-15T08:00:00");

describe("when a scheduled job is due", () => {
  it("reads in, every, daily and ISO times, and refuses the rest", () => {
    expect(parseWhen("in 30m", T0)).toEqual({ next: T0 + 30 * 60_000 });
    expect(parseWhen("every 2h", T0)).toEqual({ next: T0 + 7_200_000, everyMs: 7_200_000 });
    expect(parseWhen("daily 7:30", T0)).toMatchObject({ daily: "07:30", next: Date.parse("2026-11-16T07:30:00") }); // already past today
    expect(parseWhen("daily 09:15", T0)).toMatchObject({ next: Date.parse("2026-11-15T09:15:00") });
    expect(parseWhen("2026-12-01T09:00", T0)).toEqual({ next: Date.parse("2026-12-01T09:00") });
    for (const bad of ["every 1m", "tomorrow", "in 5s", "2020-01-01T00:00"]) expect(() => parseWhen(bad, T0), bad).toThrow();
  });

  it("delivers a due job once, moves a repeating one to its next time, removes a one-shot, and says when it is late", async () => {
    const root = mkdtempSync(join(tmpdir(), "ogb-sched-"));
    dirs.push(root);
    const store = createFileSessionStore({ root });
    const bot = await store.create({ title: "Scout", profile: {} });
    let now = T0;
    const delivered: { job: ScheduledJob; late: boolean }[] = [];
    const scheduler = createScheduler({ store, now: () => now, log: () => {}, deliver: async (_id, job, late) => void delivered.push({ job, late }) });
    await scheduler.add(bot.id, "in 10m", "check the price");
    await scheduler.add(bot.id, "every 30m", "look at the inbox");
    now = T0 + 11 * 60_000;
    await scheduler.tick();
    expect(delivered.map((d) => d.job.prompt)).toEqual(["check the price"]);
    expect((await scheduler.list(bot.id)).map((j) => j.prompt)).toEqual(["look at the inbox"]);
    now = T0 + 60 * 60_000; // the repeating one was due at +30 min: half an hour late
    await scheduler.tick();
    expect(delivered.at(-1)).toMatchObject({ job: { prompt: "look at the inbox" }, late: true });
    expect((await scheduler.list(bot.id))[0]?.next).toBe(now + 30 * 60_000);
    await scheduler.tick();
    expect(delivered).toHaveLength(2); // nothing due twice
    expect(await scheduler.cancel(bot.id, (await scheduler.list(bot.id))[0]?.id as string)).toBe(true);
    expect(await scheduler.list(bot.id)).toEqual([]);
  });

  it("pauses and resumes a job, and runs one now: a one-shot is used up, a repeating one keeps its time", async () => {
    const root = mkdtempSync(join(tmpdir(), "ogb-sched-"));
    dirs.push(root);
    const store = createFileSessionStore({ root });
    const bot = await store.create({ title: "Scout", profile: {} });
    let now = T0;
    const delivered: string[] = [];
    const scheduler = createScheduler({ store, now: () => now, log: () => {}, deliver: async (_id, job) => void delivered.push(job.prompt) });
    const daily = await scheduler.add(bot.id, "every 1h", "digest");
    const once = await scheduler.add(bot.id, "in 10m", "remind");
    expect((await scheduler.setPaused(bot.id, daily.id, true))?.paused).toBe(true);
    now = T0 + 2 * 3_600_000;
    await scheduler.tick();
    expect(delivered).toEqual(["remind"]); // the paused one stayed quiet
    const resumed = await scheduler.setPaused(bot.id, daily.id, false);
    expect(resumed).toMatchObject({ next: now + 3_600_000 });
    expect(resumed?.paused).toBeUndefined();
    expect(await scheduler.setPaused(bot.id, "j_none", true)).toBeNull();
    await scheduler.runNow(bot.id, daily.id);
    expect(delivered).toEqual(["remind", "digest"]);
    expect((await scheduler.list(bot.id)).map((j) => j.id)).toEqual([daily.id]); // kept, with its time
    expect(once.id).not.toBe(daily.id);
    expect(await scheduler.runNow(bot.id, "j_none")).toBeNull();
  });
});

describe("the person's profile", () => {
  it("adds, replaces and removes one line, and refuses to grow past the limit", () => {
    let profile = "";
    for (const line of ["Name: Mei", "Answers in Chinese", "Time zone: Asia/Singapore"]) profile = (editPerson(profile, "add", line) as { text: string }).text;
    expect(profile).toBe("- Name: Mei\n- Answers in Chinese\n- Time zone: Asia/Singapore");
    profile = (editPerson(profile, "replace", "Short answers in Chinese", "Answers in") as { text: string }).text;
    profile = (editPerson(profile, "remove", "Time zone") as { text: string }).text;
    expect(profile).toBe("- Name: Mei\n- Short answers in Chinese");
    expect(editPerson(profile, "add", "x".repeat(PERSON_MAX))).toMatchObject({ refused: expect.stringContaining("Merge or remove") });
    expect(editPerson(profile, "remove", "nothing like this")).toMatchObject({ refused: expect.stringContaining("No line") });
  });
});

describe("a bot that schedules itself and knows the person", () => {
  it("adds a job with the tool, is woken by it in the same conversation, and every run sees the shared profile", async () => {
    let clock = T0;
    const notices: Outgoing[] = [];
    const mail: Channel = { name: "mail", deliver: async (message) => void notices.push(message) };
    const r = createRig({
      runtime: { now: () => clock, scheduleIntervalMs: 30, channels: [mail] },
      profiles: { default: "general", profiles: { general: { plugins: [], alwaysDeclaredTools: ["schedule", "remember_person"] } } },
      script: (request, index) => {
        if (index === 0) return { toolCalls: [{ name: "schedule", args: { action: "add", when: "in 5m", prompt: "Tell the person the price." } }] };
        if (index === 1) return { toolCalls: [{ name: "remember_person", args: { action: "add", line: "Prefers short answers" } }] };
        if (index === 2) return { text: "Scheduled." };
        const seen = [
          request.system.includes("Prefers short answers") ? "profile seen" : "",
          request.system.includes("- publish-blog: Publish a post") ? "skill seen" : "",
        ];
        return { text: `price: 42 (${seen.filter(Boolean).join(", ")})` };
      },
    });
    rigs.push(r);
    const bot = await r.runtime.createSession({ title: "Scout" });
    await r.runtime.resumeAll(); // starts the clock
    // A skill another bot downloaded: every run lists the shared skills folder (name and description only).
    mkdirSync(join(r.root, "shared", "skills", "publish-blog"), { recursive: true });
    writeFileSync(join(r.root, "shared", "skills", "publish-blog", "SKILL.md"), "---\nname: publish-blog\ndescription: Publish a post on a blog\n---\n");
    await r.runtime.send(bot.id, "watch the price and tell me in 5 minutes");
    await r.runtime.whenIdle(bot.id);
    expect(readFileSync(join(r.root, "shared", "person", "USER.md"), "utf8")).toContain("Prefers short answers");
    expect((await r.runtime.list()).find((s) => s.id === bot.id)?.next).toBe("in 5m"); // the rail shows the next job
    clock = T0 + 6 * 60_000;
    const wokeUp = async () =>
      (await r.runtime.read(bot.id)).some((e) => e.type === "message.user" && JSON.stringify(e.payload).includes("Tell the person the price"));
    await expect.poll(wokeUp, { timeout: 5000 }).toBe(true);
    await r.runtime.whenIdle(bot.id);
    const events = await r.runtime.read(bot.id);
    const woke = events.find((e) => e.type === "message.user" && JSON.stringify(e.payload).includes("Tell the person the price"));
    expect(woke).toBeDefined();
    expect(JSON.stringify(events.filter((e) => e.type === "message.assistant").at(-1)?.payload)).toContain("profile seen, skill seen");
    expect((await r.runtime.list()).find((s) => s.id === bot.id)?.next).toBeUndefined(); // the one-shot job is gone
    // The scheduled run's reply is a notice for the person: on the page (the bot's info) and on their other channels.
    await expect.poll(async () => (await r.runtime.list()).find((s) => s.id === bot.id)?.notice?.text).toContain("price: 42");
    await expect.poll(() => notices.filter((n) => n.kind === "notice").length).toBe(1);
    expect(notices.filter((n) => n.kind === "notice")).toEqual([
      { sessionId: bot.id, from: "Scout", kind: "notice", at: expect.any(Number), text: expect.stringContaining("price: 42") },
    ]);
  });
});
