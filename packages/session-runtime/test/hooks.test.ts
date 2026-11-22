// Webhooks in the runtime (docs/26 3.4): the registry keeps only hashes; the hook tool shows the token once; a delivery wakes the bot
// as untrusted outside text, once per delivery id.
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createHookRegistry, hookSignal, MAX_HOOKS_PER_BOT } from "../src/hooks.ts";
import { createRig, type Rig } from "../src/testing/index.ts";

const rigs: Rig[] = [];
const dirs: string[] = [];
afterEach(async () => {
  for (const rig of rigs.splice(0)) await rig.cleanup();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("the hook registry", () => {
  it("keeps only a hash of each token, opens a hook only with its own token, refuses doubles, bad names and too many", async () => {
    const dir = mkdtempSync(join(tmpdir(), "ogb-hooks-"));
    dirs.push(dir);
    const file = join(dir, "hooks", "hooks.json");
    const hooks = createHookRegistry(file);
    const token = await hooks.create("s_a", "github");
    expect(readFileSync(file, "utf8")).not.toContain(token);
    expect(await hooks.verify("s_a", "github", token)).toBe(true);
    expect(await hooks.verify("s_a", "github", `${token}x`)).toBe(false);
    expect(await hooks.verify("s_b", "github", token)).toBe(false);
    await expect(hooks.create("s_a", "github")).rejects.toThrow(/already has a hook/);
    await expect(hooks.create("s_a", "Git Hub")).rejects.toThrow(/lower-case/);
    for (let i = 1; i < MAX_HOOKS_PER_BOT; i += 1) await hooks.create("s_a", `h${i}`);
    await expect(hooks.create("s_a", "one-more")).rejects.toThrow(/at most/);
    expect(await hooks.remove("s_a", "github")).toBe(true);
    expect(await hooks.verify("s_a", "github", token)).toBe(false);
    expect((await hooks.list("s_a")).length).toBe(MAX_HOOKS_PER_BOT - 1);
  });

  it("a delivery's signal is outside text with a stable id: the sender's delivery id, or the body's hash", () => {
    expect(hookSignal("github", "{}", "d-1")).toMatchObject({ id: "hook-github-d-1", source: "external:github" });
    expect(hookSignal("github", "{}", undefined).id).toBe(hookSignal("github", "{}", "bad id with spaces").id);
  });
});

describe("hooks in a running box", () => {
  it("the bot makes a hook; a delivery with its token wakes it, once per delivery id; a wrong token does nothing", async () => {
    const rig = createRig({
      profiles: { default: "general", profiles: { general: { plugins: [], alwaysDeclaredTools: ["hook"] } } },
      script: [{ toolCalls: [{ name: "hook", args: { action: "create", name: "github" } }] }, { text: "Made." }, { text: "A pull request was opened." }],
    });
    rigs.push(rig);
    const bot = await rig.runtime.createSession({ title: "Watcher" });
    await rig.runtime.resumeAll();
    await rig.runtime.send(bot.id, "make a webhook for github");
    await rig.runtime.whenIdle(bot.id);
    const token = /token=([A-Za-z0-9_-]+)/.exec(JSON.stringify(rig.faux.requests.at(-1)))?.[1] as string;
    expect(token).toBeTruthy();

    expect(await rig.runtime.receiveHook(bot.id, "github", "wrong", "{}", "d-0")).toBe(false);
    expect(await rig.runtime.receiveHook(bot.id, "github", token, '{"action":"opened"}', "d-1")).toBe(true);
    expect(await rig.runtime.receiveHook(bot.id, "github", token, '{"action":"opened"}', "d-1")).toBe(true); // the sender retried
    await rig.runtime.whenIdle(bot.id);
    const runs = (await rig.runtime.read(bot.id)).filter((e) => e.type === "run.finished");
    expect(runs).toHaveLength(2); // the setup and one delivery
    expect(JSON.stringify(rig.faux.requests.at(-1))).toContain('{\\"action\\":\\"opened\\"}');
  });
});
