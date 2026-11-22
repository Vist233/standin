import type { SessionEvent } from "@standin/contracts";
import { afterEach, describe, expect, it, vi } from "vitest";
import { handbackTimedOut, questionTimedOut } from "../src/takeover.ts";
import { createRig, type Rig } from "../src/testing/index.ts";
import { dueWaits } from "../src/waits.ts";

const MIN = 60_000;
const at = (seq: number, time: number, type: string, payload: unknown): SessionEvent => ({
  v: 1,
  seq,
  at: time,
  sessionId: "s",
  type,
  payload: payload as never,
});

describe("dueWaits", () => {
  const events = [at(1, 0, "human.question", { id: "q1" }), at(2, 10 * MIN, "human.question", { id: "q2" }), at(3, 11 * MIN, "human.answered", { id: "q2" })];

  it("waits for ever when no limit is set", () => {
    expect(dueWaits(events, {}, 10_000 * MIN)).toEqual({ expired: [], nextAt: undefined });
  });

  it("finds the question that ran out, and when the next one will; answered and expired ones do not count", () => {
    expect(dueWaits(events, { humanWaitMinutes: 30 }, 29 * MIN)).toEqual({ expired: [], nextAt: 30 * MIN });
    expect(dueWaits(events, { humanWaitMinutes: 30 }, 30 * MIN).expired).toEqual([{ kind: "question", id: "q1", minutes: 30 }]);
    const given = [...events, at(4, 31 * MIN, "human.expired", { id: "q1", afterMinutes: 30 })];
    expect(dueWaits(given, { humanWaitMinutes: 30 }, 99 * MIN).expired).toEqual([]);
  });

  it("finds a take-over that stayed open too long, and not one that was closed", () => {
    const open = [at(1, 0, "takeover.opened", { since: 1000, workspaceId: "w" })];
    expect(dueWaits(open, { takeoverMaxMinutes: 60 }, 1000 + 60 * MIN).expired).toEqual([{ kind: "takeover", minutes: 60 }]);
    expect(dueWaits([...open, at(2, 5, "takeover.closed", { viewed: false })], { takeoverMaxMinutes: 60 }, 1e12).expired).toEqual([]);
  });
});

describe("the wait limits in a running session", () => {
  const rigs: Rig[] = [];
  afterEach(async () => {
    for (const r of rigs.splice(0)) await r.cleanup();
  });
  /** A clock and a scheduler the test drives: no real waiting. */
  function clocked(
    waits: { humanWaitMinutes?: number; takeoverMaxMinutes?: number },
    script: Parameters<typeof createRig>[0] extends infer O ? (NonNullable<O> extends { script?: infer S } ? S : never) : never,
  ) {
    let time = 1_800_000_000_000;
    const timers: { fn: () => void; ms: number; live: boolean }[] = [];
    const made = createRig({
      profiles: { default: "p", profiles: { p: { plugins: [], alwaysDeclaredTools: ["ask_human"] } } },
      script,
      runtime: {
        now: () => time,
        waits,
        schedule: (fn, ms) => {
          const timer = { fn, ms, live: true };
          timers.push(timer);
          return () => {
            timer.live = false;
          };
        },
      },
    });
    rigs.push(made);
    return {
      ...made,
      advance(minutes: number) {
        time += minutes * MIN;
      },
      /** Fires the timer that is set now, as the clock would. */
      async fire() {
        const timer = timers.filter((t) => t.live).at(-1);
        if (!timer) throw new Error("no timer is set");
        timer.live = false;
        timer.fn();
        await new Promise((resolve) => setTimeout(resolve, 30));
      },
      liveTimers: () => timers.filter((t) => t.live).length,
    };
  }
  const login = (_request: unknown, index: number) =>
    index === 0 ? { toolCalls: [{ name: "ask_human", args: { question: "Sign in", kind: "login" } }] } : { text: "carrying on" };
  const payloadsOf = async (rig: Rig, id: string, type: string) => (await rig.runtime.read(id)).filter((e) => e.type === type).map((e) => e.payload);

  it("sets no timer at all when no limit is configured", async () => {
    const rig = clocked({}, login as never);
    const { id } = await rig.runtime.createSession();
    await rig.runtime.send(id, "go");
    await rig.runtime.whenIdle(id);
    expect(rig.liveTimers()).toBe(0);
  });

  it("gives up a question that nobody answered: journals it, releases the hold and tells the agent", async () => {
    const rig = clocked({ humanWaitMinutes: 30 }, login as never);
    const { id } = await rig.runtime.createSession();
    await rig.runtime.send(id, "go");
    await rig.runtime.whenIdle(id);
    await vi.waitFor(() => expect(rig.liveTimers()).toBe(1));
    expect((await rig.runtime.status(id)).held).toBe(true);
    rig.advance(30);
    await rig.fire();
    await rig.runtime.whenIdle(id);
    const question = (await payloadsOf(rig, id, "human.question"))[0] as { id: string };
    expect(await payloadsOf(rig, id, "human.expired")).toEqual([{ id: question.id, afterMinutes: 30 }]);
    expect((await rig.runtime.status(id)).held).toBe(false);
    await vi.waitFor(() => expect(JSON.stringify(rig.faux.requests.at(-1)?.messages)).toContain(questionTimedOut(30)));
    expect(rig.liveTimers()).toBe(0);
  });

  it("does not give up a question that was answered in time", async () => {
    const rig = clocked({ humanWaitMinutes: 30 }, login as never);
    const { id } = await rig.runtime.createSession();
    await rig.runtime.send(id, "go");
    await rig.runtime.whenIdle(id);
    await rig.runtime.send(id, "signed in");
    await rig.runtime.whenIdle(id);
    rig.advance(31);
    const before = rig.faux.requests.length;
    await rig.runtime.status(id);
    expect(await payloadsOf(rig, id, "human.expired")).toEqual([]);
    expect(rig.faux.requests.length).toBe(before);
  });

  it("ends a take-over that stayed open too long like a hand-back, with the timeout text", async () => {
    const rig = clocked({ takeoverMaxMinutes: 60 }, login as never);
    const { id } = await rig.runtime.createSession();
    await rig.runtime.send(id, "go");
    await rig.runtime.whenIdle(id);
    await rig.runtime.openTakeover(id);
    await rig.runtime.reportTakeoverViewer(id);
    await vi.waitFor(() => expect(rig.liveTimers()).toBe(1));
    rig.advance(60);
    await rig.fire();
    await rig.runtime.whenIdle(id);
    expect(await payloadsOf(rig, id, "takeover.closed")).toEqual([{ note: "timeout", viewed: true }]);
    expect(await rig.runtime.takeoverState(id)).toBeNull();
    expect(JSON.stringify(rig.faux.requests.at(-1)?.messages)).toContain(handbackTimedOut(60));
  });

  it("delivers a message written during a take-over after the timeout hand-back (fake clock)", async () => {
    const rig = clocked({ takeoverMaxMinutes: 60 }, login as never);
    const { id } = await rig.runtime.createSession();
    await rig.runtime.send(id, "go");
    await rig.runtime.whenIdle(id);
    await rig.runtime.openTakeover(id);
    await vi.waitFor(() => expect(rig.liveTimers()).toBe(1));
    await rig.runtime.send(id, "and the second tab please");
    const before = rig.faux.requests.length;
    rig.advance(61);
    await rig.fire();
    await rig.runtime.whenIdle(id);
    expect(rig.faux.requests.length).toBeGreaterThan(before);
    const sent = JSON.stringify(rig.faux.requests.at(-1)?.messages);
    expect(sent.indexOf("and the second tab please")).toBeGreaterThan(sent.indexOf(handbackTimedOut(60)));
  });

  it("looks at the limits again when a session is opened after a restart", async () => {
    const first = clocked({ humanWaitMinutes: 10 }, login as never);
    const { id } = await first.runtime.createSession();
    await first.runtime.send(id, "go");
    await first.runtime.whenIdle(id);
    await first.runtime.close();
    const second = createRig({
      root: first.root,
      profiles: { default: "p", profiles: { p: { plugins: [], alwaysDeclaredTools: ["ask_human"] } } },
      runtime: { now: () => Date.now() + 365 * 24 * 60 * MIN, waits: { humanWaitMinutes: 10 }, schedule: (fn) => (fn(), () => {}) },
    });
    rigs.push(second);
    await second.runtime.openSession(id);
    await vi.waitFor(async () => expect(await payloadsOf(second, id, "human.expired")).toHaveLength(1));
  });
});
