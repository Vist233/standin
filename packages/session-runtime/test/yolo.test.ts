import { reviewPlugin } from "sakura-agent";
import { createFauxClient } from "sakura-agent/testing";
import { afterEach, describe, expect, it } from "vitest";
import { createRig, loadPlugins, type Rig } from "../src/testing/index.ts";
import { callCount, gatedPlugin, installGate, resetCalls } from "./helpers.ts";

const rigs: Rig[] = [];
afterEach(async () => {
  for (const r of rigs.splice(0)) await r.cleanup();
});

const DENY = '{"risk_level":"critical","user_authorization":"unknown","outcome":"deny","rationale":"not allowed by the test reviewer"}';

/** A bot whose one plugin tool needs approval (`ask`) and whose reviewer denies everything. */
function strictBot() {
  installGate().open();
  resetCalls();
  let reviews = 0;
  const reviewer = createFauxClient(() => {
    reviews += 1;
    return { text: DENY };
  });
  const rig = createRig({
    plugins: loadPlugins(gatedPlugin(undefined, "demo", { gated: "ask" })),
    profiles: { default: "p", profiles: { p: { plugins: ["demo"] } } },
    script: (_request, index) => (index % 2 === 0 ? { toolCalls: [{ name: "tool_call", args: { name: "gated", args: { n: index } } }] } : { text: "done" }),
    runtime: { safetyPlugins: () => [reviewPlugin({ llm: reviewer })] },
  });
  rigs.push(rig);
  return { ...rig, reviews: () => reviews };
}

describe("yolo: the person switches a bot's approvals and review off and on while it runs", () => {
  it("is off by default: the reviewer is asked and denies, nothing runs", async () => {
    const { runtime, reviews } = strictBot();
    const { id } = await runtime.createSession();
    await runtime.send(id, "go");
    await runtime.whenIdle(id);
    expect(callCount()).toBe(0);
    expect(reviews()).toBeGreaterThan(0);
  });

  it("on: an `ask` tool runs without approval and without review; off again: both are back, from the next call", async () => {
    const { runtime, reviews } = strictBot();
    const { id } = await runtime.createSession();
    await runtime.openSession(id);
    expect((await runtime.updateSession(id, { yolo: true })).yolo).toBe(true);

    await runtime.send(id, "go");
    await runtime.whenIdle(id);
    expect(callCount()).toBe(1);
    expect(reviews()).toBe(0);
    expect(await runtime.pendingApprovals(id)).toEqual([]);

    expect((await runtime.updateSession(id, { yolo: false })).yolo).toBeUndefined();
    await runtime.send(id, "again");
    await runtime.whenIdle(id);
    expect(callCount()).toBe(1);
    expect(reviews()).toBeGreaterThan(0);

    const switches = (await runtime.read(id)).filter((e) => e.type === "safety.yolo").map((e) => e.payload);
    expect(switches).toEqual([{ on: true }, { on: false }]);
  });

  it("is kept with the bot: a bot opened later starts with the switch as the person left it", async () => {
    const { runtime } = strictBot();
    const { id } = await runtime.createSession();
    await runtime.updateSession(id, { yolo: true }); // not open yet: only the record changes
    await runtime.send(id, "go");
    await runtime.whenIdle(id);
    expect(callCount()).toBe(1);
  });

  it("refuses anything but true or false", async () => {
    const { runtime } = strictBot();
    const { id } = await runtime.createSession();
    await expect(runtime.updateSession(id, { yolo: "yes" as unknown as boolean })).rejects.toThrow("true or false");
  });
});
