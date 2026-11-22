// The heartbeat (docs/26 3.3): a repeating look at a checklist that costs a model call only when there is something to look at.
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { beat, inQuiet, parseQuiet, readChecklist } from "../src/heartbeat.ts";
import { createRig, type Rig } from "../src/testing/index.ts";

const rigs: Rig[] = [];
afterEach(async () => {
  for (const rig of rigs.splice(0)) await rig.cleanup();
});
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const local = (h: number, m: number) => new Date(2026, 10, 17, h, m).getTime();

describe("the heartbeat's decision", () => {
  it("quiet hours, also across midnight; refused when malformed", () => {
    expect(inQuiet("23:00-08:00", local(23, 30))).toBe(true);
    expect(inQuiet("23:00-08:00", local(7, 59))).toBe(true);
    expect(inQuiet("23:00-08:00", local(8, 0))).toBe(false);
    expect(inQuiet("12:00-13:00", local(12, 30))).toBe(true);
    expect(inQuiet(undefined, local(3, 0))).toBe(false);
    expect(parseQuiet("")).toBeUndefined();
    expect(() => parseQuiet("night")).toThrow(/HH:MM-HH:MM/);
  });

  it("skips without a model call when quiet, stopped, waiting for the person, or with nothing to check; otherwise asks for [SILENT] when nothing is due", () => {
    const base = { every: "every 30m", now: local(10, 0), checklist: "- look at the inbox", status: { pending: 0, held: false } };
    expect(beat({ ...base, quiet: "09:00-11:00" })).toEqual({ skip: "quiet" });
    expect(beat({ ...base, status: { pending: 0, held: true } })).toEqual({ skip: "stopped" });
    expect(beat({ ...base, status: { pending: 1, held: false } })).toEqual({ skip: "waiting" });
    expect(beat({ ...base, checklist: "" })).toEqual({ skip: "empty" });
    const prompt = (beat(base) as { prompt: string }).prompt;
    expect(prompt).toContain("[SILENT]");
    expect(prompt).toContain("- look at the inbox");
  });
});

describe("the heartbeat in a running box", () => {
  it("set by the bot with the schedule tool; an empty checklist costs nothing; a checklist wakes it; a [SILENT] reply gives no notice", async () => {
    let now = Date.now();
    const rig = createRig({
      runtime: { now: () => now, scheduleIntervalMs: 15 },
      profiles: { default: "general", profiles: { general: { plugins: [], alwaysDeclaredTools: ["schedule"] } } },
      script: [
        { toolCalls: [{ name: "schedule", args: { action: "heartbeat", when: "every 30m", quiet: "02:00-02:01" } }] },
        { text: "Heartbeat set." },
        { text: "[SILENT]" },
      ],
    });
    rigs.push(rig);
    const bot = await rig.runtime.createSession({ title: "Keeper" });
    await rig.runtime.resumeAll();
    await rig.runtime.send(bot.id, "check things every half hour");
    await rig.runtime.whenIdle(bot.id);
    const afterSetup = rig.faux.requests.length;

    now += 31 * 60_000; // a beat is due, but there is no checklist
    await sleep(80);
    await rig.runtime.whenIdle(bot.id);
    expect(rig.faux.requests.length).toBe(afterSetup);

    const filesDir = join(rig.root, "workspaces", bot.id, "files");
    writeFileSync(join(filesDir, "HEARTBEAT.md"), "- is the build green?\n");
    now += 31 * 60_000;
    await sleep(80);
    await rig.runtime.whenIdle(bot.id);
    expect(rig.faux.requests.length).toBe(afterSetup + 1);
    expect(JSON.stringify(rig.faux.requests.at(-1))).toContain("is the build green?");
    expect((await rig.deps.store.get(bot.id)).notice).toBeUndefined(); // [SILENT]: the person is not disturbed
    expect(await readChecklist(filesDir)).toBe("- is the build green?");
  });
});
