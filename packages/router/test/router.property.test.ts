import type { SignalSource } from "@standin/contracts";
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { priorityOf } from "../src/index.ts";
import { SimulatedRuntime } from "../src/testing/index.ts";

const SOURCES: SignalSource[] = ["user", "plugin:mail", "plugin:calendar", "external:web", "system"];

type Op =
  | { t: "signal"; session: number; source: number }
  | { t: "repeat"; pick: number } // a producer retries an earlier signal with the same id
  | { t: "advance"; ms: number }
  | { t: "start"; session: number }
  | { t: "consume"; session: number }
  | { t: "finish"; session: number }
  | { t: "fail"; session: number }
  | { t: "stop"; session: number; again: boolean };

const session = fc.integer({ min: 0, max: 1 });
const opArbitrary: fc.Arbitrary<Op> = fc.oneof(
  { weight: 6, arbitrary: fc.record({ t: fc.constant("signal" as const), session, source: fc.integer({ min: 0, max: SOURCES.length - 1 }) }) },
  { weight: 2, arbitrary: fc.record({ t: fc.constant("repeat" as const), pick: fc.nat(1000) }) },
  { weight: 3, arbitrary: fc.record({ t: fc.constant("advance" as const), ms: fc.integer({ min: 0, max: 300 }) }) },
  { weight: 3, arbitrary: fc.record({ t: fc.constant("start" as const), session }) },
  { weight: 3, arbitrary: fc.record({ t: fc.constant("consume" as const), session }) },
  { weight: 2, arbitrary: fc.record({ t: fc.constant("finish" as const), session }) },
  { weight: 1, arbitrary: fc.record({ t: fc.constant("fail" as const), session }) },
  { weight: 1, arbitrary: fc.record({ t: fc.constant("stop" as const), session, again: fc.boolean() }) },
);

const optionsArbitrary = fc.record({ mergeWindowMs: fc.constantFrom(0, 50), retryDelayMs: fc.constantFrom(0, 100) });

interface Submitted {
  id: string;
  sessionId: string;
  source: SignalSource;
}

/** Plays random operations against the router and the simulated runtime, then lets everything finish. */
function play(ops: Op[], options: { mergeWindowMs: number; retryDelayMs: number }) {
  const runtime = new SimulatedRuntime(options);
  const submitted: Submitted[] = [];
  const stopIds: string[] = [];
  let counter = 0;
  for (const op of ops) {
    const sessionId = "session" in op ? `s${op.session}` : "s0";
    switch (op.t) {
      case "signal": {
        const source = SOURCES[op.source] as SignalSource;
        const id = `m${counter++}`;
        submitted.push({ id, sessionId, source });
        runtime.signal(sessionId, { id, source, text: id });
        break;
      }
      case "repeat": {
        const earlier = submitted[op.pick % Math.max(submitted.length, 1)];
        if (earlier) runtime.signal(earlier.sessionId, { id: earlier.id, source: earlier.source, text: earlier.id });
        break;
      }
      case "advance":
        runtime.advance(op.ms);
        break;
      case "start":
        runtime.completeStart(sessionId);
        break;
      case "consume":
        runtime.consumeSteers(sessionId);
        break;
      case "finish":
        runtime.finishRun(sessionId);
        break;
      case "fail":
        runtime.failPending(sessionId);
        break;
      case "stop": {
        const id = `stop${stopIds.length}`;
        stopIds.push(id);
        runtime.stop(sessionId, id);
        if (op.again) runtime.stop(sessionId, id); // a retried Stop
        break;
      }
    }
  }
  // Stop leaves signals waiting by design; the user writing again releases them, so the end state can be checked.
  const release = { id: "release", sessionId: "s0", source: "user" as SignalSource };
  const release1 = { ...release, id: "release1", sessionId: "s1" };
  for (const r of [release, release1]) {
    submitted.push(r);
    runtime.signal(r.sessionId, { id: r.id, source: r.source, text: r.id });
  }
  const settled = runtime.drain();
  return { runtime, submitted, stopIds, settled };
}

describe("router properties (random interleavings of signals and run state)", () => {
  it("settles, and every signal reaches the model exactly once", () => {
    fc.assert(
      fc.property(fc.array(opArbitrary, { maxLength: 80 }), optionsArbitrary, (ops, options) => {
        const { runtime, submitted, settled } = play(ops, options);
        expect(settled).toBe(true);
        for (const sessionId of ["s0", "s1"]) {
          const wanted = submitted.filter((s) => s.sessionId === sessionId).map((s) => s.id);
          const got = runtime.consumed.filter((c) => c.sessionId === sessionId).map((c) => c.signalId);
          expect([...got].sort()).toEqual([...wanted].sort()); // none lost (also when idle), none twice (also after retries and failures)
        }
      }),
      { numRuns: 400 },
    );
  });

  it("keeps arrival order within the user's messages and within everything else", () => {
    fc.assert(
      fc.property(fc.array(opArbitrary, { maxLength: 80 }), optionsArbitrary, (ops, options) => {
        const { runtime, submitted } = play(ops, options);
        for (const sessionId of ["s0", "s1"]) {
          for (const priority of ["user", "normal"] as const) {
            const arrival = submitted.filter((s) => s.sessionId === sessionId && priorityOf(s.source) === priority).map((s) => s.id);
            const delivered = runtime.consumed
              .filter((c) => c.sessionId === sessionId)
              .map((c) => c.signalId)
              .filter((id) => arrival.includes(id));
            expect(delivered).toEqual(arrival);
          }
        }
      }),
      { numRuns: 400 },
    );
  });

  it("never lets a Stop become a message and never runs two turns at once (the simulation throws if the router breaks a rule)", () => {
    fc.assert(
      fc.property(fc.array(opArbitrary, { maxLength: 80 }), optionsArbitrary, (ops, options) => {
        const { runtime, stopIds } = play(ops, options);
        const consumedIds = new Set(runtime.consumed.map((c) => c.signalId));
        for (const id of stopIds) expect(consumedIds.has(id)).toBe(false);
      }),
      { numRuns: 400 },
    );
  });

  it("is deterministic: the same operations give the same deliveries", () => {
    fc.assert(
      fc.property(fc.array(opArbitrary, { maxLength: 60 }), optionsArbitrary, (ops, options) => {
        const first = play(ops, options).runtime.outputs;
        const second = play(ops, options).runtime.outputs;
        expect(second).toEqual(first);
      }),
      { numRuns: 100 },
    );
  });
});

describe("router properties: held after Stop", () => {
  it("while held no run starts (the simulation throws otherwise), and nothing waiting is lost or reordered once the user writes", () => {
    fc.assert(
      fc.property(fc.array(opArbitrary, { maxLength: 80 }), optionsArbitrary, fc.nat(60), (ops, options, stopAt) => {
        // Force a Stop in the middle of the random run, then more random operations.
        const withStop: Op[] = [...ops.slice(0, stopAt), { t: "stop", session: 0, again: true }, { t: "stop", session: 1, again: false }, ...ops.slice(stopAt)];
        const { runtime, submitted, settled } = play(withStop, options);
        expect(settled).toBe(true);
        for (const sessionId of ["s0", "s1"]) {
          const wanted = submitted.filter((s) => s.sessionId === sessionId).map((s) => s.id);
          const got = runtime.consumed.filter((c) => c.sessionId === sessionId).map((c) => c.signalId);
          expect([...got].sort()).toEqual([...wanted].sort());
        }
      }),
      { numRuns: 300 },
    );
  });
});

describe("router scenarios with the simulated runtime", () => {
  it("delivers a burst that arrives while idle, in order, as one start then steers", () => {
    const runtime = new SimulatedRuntime();
    for (const id of ["a", "b", "c"]) runtime.signal("s1", { id, source: "plugin:mail", text: id });
    expect(runtime.drain()).toBe(true);
    expect(runtime.consumed.map((c) => `${c.signalId}:${c.how}`)).toEqual(["a:start-input", "b:steer", "c:steer"]);
  });

  it("a steer that the run never read is not lost when the run ends, and is not delivered twice", () => {
    const runtime = new SimulatedRuntime();
    runtime.signal("s1", { id: "a", source: "plugin:mail", text: "a" });
    runtime.completeStart("s1");
    runtime.signal("s1", { id: "b", source: "plugin:mail", text: "b" }); // steered, not read yet
    runtime.finishRun("s1"); // the run ends first; the framework drops the steer
    runtime.signal("s1", { id: "b", source: "plugin:mail", text: "b" }); // the producer retries
    expect(runtime.drain()).toBe(true);
    expect(runtime.consumed.map((c) => c.signalId)).toEqual(["a", "b"]);
    expect(runtime.consumed[1]?.how).toBe("start-input");
  });
});
