import { existsSync } from "node:fs";
import { join } from "node:path";
import { isOgbError, type SessionEvent } from "@standin/contracts";
import { ProviderError } from "sakura-agent";
import { afterEach, describe, expect, it } from "vitest";
import { describeRunError, errorKindOf, JournalMapper, outcomeOf, retryableRun, toolRefOf } from "../src/events.ts";
import { repairAfterRestart } from "../src/repair.ts";
import { waitingFrom } from "../src/waiting.ts";
import { HANDBACK_NOT_VIEWED, HANDBACK_VIEWED } from "../src/takeover.ts";
import { createRig, type Rig } from "../src/testing/index.ts";
import { installGate, types } from "./helpers.ts";

const rigs: Rig[] = [];
function rig(options: Parameters<typeof createRig>[0] = {}) {
  const made = createRig({ profiles: PROFILES, ...options });
  rigs.push(made);
  return made;
}
afterEach(async () => {
  for (const r of rigs.splice(0)) await r.cleanup();
});
const PROFILES = { default: "p", profiles: { p: { plugins: [], alwaysDeclaredTools: ["ask_human", "send_to_user"] } } };
const payloads = (events: SessionEvent[], type: string) => events.filter((e) => e.type === type).map((e) => e.payload as Record<string, unknown>);
const ask = (args: Record<string, unknown>) => ({ toolCalls: [{ name: "ask_human", args }] });

describe("what a tool call looks like in the journal", () => {
  it("unwraps tool_call to the inner tool, with its action and target", () => {
    expect(toolRefOf({ name: "tool_call", args: { name: "browser", args: { action: "open", url: "https://a.test/x" } } })).toEqual({
      name: "browser",
      action: "open",
      target: "https://a.test/x",
    });
    expect(toolRefOf({ name: "read", args: { path: "/files/a.txt" } })).toEqual({ name: "read", target: "/files/a.txt" });
    expect(toolRefOf({ name: "bash", args: "not an object" })).toEqual({ name: "bash" });
  });

  it("gives the review of an inner call its parent, closes a call that was refused before it started, and closes open ones as interrupted", () => {
    const mapper = new JournalMapper();
    const inner = { id: "c1/inner", name: "browser", args: { action: "open" } };
    expect(mapper.map({ type: "tool_start", call: inner })[0]?.payload).toMatchObject({ parentCallId: "c1" });
    const refused = mapper.map({
      type: "tool_end",
      call: { id: "c2", name: "bash", args: {} },
      result: { content: [{ type: "text", text: "Not allowed: no" }], isError: true },
    });
    expect(refused.map((d) => d.type)).toEqual(["tool.call", "tool.result"]);
    expect(refused[1]?.payload).toMatchObject({ outcome: "refused" });
    expect(mapper.openCalls).toBe(1);
    expect(mapper.interrupt()[0]?.payload).toMatchObject({ outcome: "interrupted" });
    expect(mapper.openCalls).toBe(0);
  });

  it("tells ok, error, refused and needs_approval apart", () => {
    const text = (value: string, extra = {}) => ({ content: [{ type: "text", text: value }], ...extra });
    expect(outcomeOf(text("fine"))).toBe("ok");
    expect(outcomeOf(text("bad", { isError: true }))).toBe("error");
    expect(outcomeOf(text("x", { isError: true, details: { outcome: "needs_approval" } }))).toBe("needs_approval");
  });

  it("names the cause of a failed run without a credential in it", () => {
    expect(errorKindOf("401 Unauthorized", undefined)).toBe("auth");
    expect(errorKindOf("fetch failed: ECONNRESET", undefined)).toBe("network");
    expect(errorKindOf(undefined, "quota")).toBe("quota");
    expect(errorKindOf("something odd", undefined)).toBe("other");
    expect(describeRunError("request failed with Bearer abcdefgh12345678\nstack...")).toBe("request failed with Bearer [redacted]");
    expect(describeRunError(undefined)).toMatch(/no reason/);
    const body = '400 {"error":{"message":"Model \\"x\\" is not supported on this endpoint.","type":"invalid_request_error"}}';
    expect(describeRunError(body)).toBe('400 Model "x" is not supported on this endpoint.');
    expect(retryableRun("model", body)).toBe(false); // the same request would fail again
    expect(retryableRun("model", "503 overloaded")).toBe(true);
    expect(retryableRun("auth", "401")).toBe(false);
  });
});

describe("the journal events a real run writes", () => {
  it("writes a call with its target, a result with its outcome, and run.finished in the page's words", async () => {
    const { runtime } = rig({
      script: (_request, index) => (index === 0 ? { toolCalls: [{ name: "read", args: { path: "missing.txt" } }] } : { text: "done" }),
    });
    const { id } = await runtime.createSession();
    await runtime.send(id, "go");
    await runtime.whenIdle(id);
    const events = await runtime.read(id);
    expect(payloads(events, "tool.call")[0]).toMatchObject({ name: "read", tool: { name: "read", target: "missing.txt" } });
    expect(payloads(events, "tool.result")[0]).toMatchObject({ outcome: "error" });
    expect(payloads(events, "run.finished")).toEqual([{ reason: "end" }]);
  });

  it("writes session.error with a kind and a one-line cause when the model fails", async () => {
    const { runtime } = rig({ script: () => ({ error: new ProviderError("auth", "401 Unauthorized", 401) }) });
    const { id } = await runtime.createSession();
    await runtime.send(id, "hi");
    await runtime.whenIdle(id);
    const events = await runtime.read(id);
    expect(payloads(events, "session.error")[0]).toMatchObject({ kind: "auth", retryable: false });
    expect(payloads(events, "run.finished")[0]).toMatchObject({ reason: "error" });
  });

  it("stops a run that goes on too long and says why: the allowance is per run, not per session", async () => {
    const { runtime, faux } = rig({
      runtime: { limits: { turnsPerRun: 3 } },
      script: () => ({ toolCalls: [{ name: "workspace_info", args: {} }] }),
    });
    const { id } = await runtime.createSession();
    await runtime.send(id, "loop");
    await runtime.whenIdle(id);
    expect(faux.requests.length).toBeLessThanOrEqual(4);
    expect(payloads(await runtime.read(id), "run.finished")[0]).toMatchObject({ reason: "pause", pause: { reason: "budget" } });
    const before = faux.requests.length;
    await runtime.send(id, "again"); // a new run gets a new allowance
    await runtime.whenIdle(id);
    expect(faux.requests.length).toBeGreaterThan(before);
  });
});

describe("ask_human for a login", () => {
  it("ends the turn, holds the session against signals, and is answered by the person's next message", async () => {
    const { runtime, faux } = rig({
      script: (_request, index) => (index === 0 ? ask({ question: "Sign in please", kind: "login", where: "https://x.test/login" }) : { text: "thanks" }),
    });
    const { id } = await runtime.createSession();
    await runtime.send(id, "check my account");
    await runtime.whenIdle(id);
    expect(faux.requests).toHaveLength(1); // no second model turn after the question
    let events = await runtime.read(id);
    expect(payloads(events, "human.question")[0]).toMatchObject({ kind: "login", where: "https://x.test/login" });
    expect(payloads(events, "run.finished")[0]).toMatchObject({ reason: "pause", pause: { reason: "input" } });
    expect(JSON.stringify(payloads(events, "tool.result")[0])).toContain("Stop now; do not touch the browser until the person answers");
    expect(await runtime.status(id)).toMatchObject({ held: true, pending: 1, lastRunEnd: "pause" }); // one thing waits for the person

    await runtime.signal(id, { id: "n1", source: "plugin:mail-sim", text: "new mail" });
    await runtime.whenIdle(id);
    expect(faux.requests).toHaveLength(1); // the signal did not start a run

    await runtime.send(id, "I signed in");
    await runtime.whenIdle(id);
    events = await runtime.read(id);
    expect(payloads(events, "human.answered")).toEqual([{ id: payloads(events, "human.question")[0]?.id, by: "person" }]);
    expect(faux.requests.length).toBeGreaterThan(1);
  });

  it("pauses for a long question in Chinese too, and keeps its text and `where` whole for the pinned card", async () => {
    const question = `请在浏览器里登录哔哩哔哩，登录完成后告诉我。${"页面需要扫码或者输入验证码。".repeat(40)}`;
    const where = "https://passport.bilibili.com/login?gourl=https%3A%2F%2Fspace.bilibili.com%2F";
    const { runtime, faux } = rig({ script: (_r, index) => (index === 0 ? ask({ question, kind: "login", where }) : { text: "好的" }) });
    const { id } = await runtime.createSession();
    await runtime.send(id, "查看我的播放量");
    await runtime.whenIdle(id);
    expect(faux.requests).toHaveLength(1);
    const events = await runtime.read(id);
    expect(payloads(events, "human.question")[0]).toMatchObject({ question, kind: "login", where });
    expect(payloads(events, "run.finished")[0]).toMatchObject({ pause: { reason: "input" } });
    expect((await runtime.status(id)).held).toBe(true);
  });

  it("does not end the turn for a question that is only a choice", async () => {
    const { runtime, faux } = rig({ script: (_r, index) => (index === 0 ? ask({ question: "Which one?", kind: "choice" }) : { text: "ok" }) });
    const { id } = await runtime.createSession();
    await runtime.send(id, "go");
    await runtime.whenIdle(id);
    expect(faux.requests).toHaveLength(2);
  });
});

describe("take-over", () => {
  const login = (index: number) => (index === 0 ? ask({ question: "Sign in", kind: "login" }) : { text: "welcome back" });

  it("opens, counts a viewer, and hands back the true text, answering the login question only when the desktop was seen", async () => {
    const { runtime, faux } = rig({ script: (_r, index) => login(index) });
    const { id } = await runtime.createSession();
    await runtime.send(id, "go");
    await runtime.whenIdle(id);

    const opened = await runtime.openTakeover(id);
    expect(opened.workspaceId).toBe(id);
    expect(await runtime.takeoverState(id)).toEqual({ since: opened.since, viewed: false });
    await runtime.reportTakeoverViewer(id);
    await runtime.reportTakeoverViewer(id); // once per take-over
    expect(await runtime.takeoverState(id)).toMatchObject({ viewed: true });

    await runtime.closeTakeover(id, "signed in");
    await runtime.whenIdle(id);
    expect(await runtime.takeoverState(id)).toBeNull();
    const events = await runtime.read(id);
    expect(types(events).filter((t) => t.startsWith("takeover.") || t === "human.answered")).toEqual([
      "takeover.opened",
      "takeover.viewer_connected",
      "takeover.closed",
      "human.answered",
    ]);
    expect(payloads(events, "takeover.closed")).toEqual([{ note: "signed in", viewed: true }]);
    expect(payloads(events, "human.answered")[0]).toMatchObject({ by: "takeover" });
    const told = JSON.stringify(faux.requests.at(-1)?.messages);
    expect(told).toContain(HANDBACK_VIEWED);
    expect(told).toContain("signed in");
  });

  it("says nothing changed when nobody ever looked, and leaves the question open", async () => {
    const { runtime, faux } = rig({ script: (_r, index) => login(index) });
    const { id } = await runtime.createSession();
    await runtime.send(id, "go");
    await runtime.whenIdle(id);
    await runtime.openTakeover(id);
    await runtime.closeTakeover(id);
    await runtime.whenIdle(id);
    const events = await runtime.read(id);
    expect(payloads(events, "takeover.closed")).toEqual([{ viewed: false }]);
    expect(types(events)).not.toContain("human.answered");
    expect(JSON.stringify(faux.requests.at(-1)?.messages)).toContain(HANDBACK_NOT_VIEWED);
    expect(waitingFrom(events).questions).toHaveLength(1);
  });

  it("holds the session while open, and lets a running tool call finish first", async () => {
    const gate = installGate();
    const { gatedPlugin } = await import("./helpers.ts");
    const { loadPlugins } = await import("../src/testing/index.ts");
    const { runtime } = rig({
      plugins: loadPlugins(gatedPlugin()),
      profiles: { default: "p", profiles: { p: { plugins: ["demo"], alwaysDeclaredTools: ["gated"] } } },
      script: (_r, index) => (index === 0 ? { toolCalls: [{ name: "gated", args: {} }] } : { text: "after" }),
    });
    const { id } = await runtime.createSession();
    await runtime.send(id, "go");
    await gate.started;
    await new Promise((resolve) => setTimeout(resolve, 50)); // the actor learns of the call from the event stream, a moment after the tool starts
    const opening = runtime.openTakeover(id);
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(await runtime.takeoverState(id)).toBeNull(); // still waiting for the call
    gate.open();
    await opening;
    await runtime.whenIdle(id);
    const events = await runtime.read(id);
    const result = payloads(events, "tool.result")[0];
    expect(result).toMatchObject({ outcome: "ok" }); // the call finished, it was not cut
    expect((await runtime.status(id)).held).toBe(true);
    await runtime.signal(id, { id: "n", source: "plugin:x", text: "mail" });
    expect(types(await runtime.read(id)).filter((t) => t === "run.started")).toHaveLength(1);
  });

  it("queues what the person writes during a take-over: no run starts, it is journalled, and it arrives after the hand-back", async () => {
    const { runtime, faux } = rig({ script: (_r, index) => login(index) });
    const { id } = await runtime.createSession();
    await runtime.send(id, "go");
    await runtime.whenIdle(id);
    await runtime.openTakeover(id);
    const before = faux.requests.length;
    await runtime.send(id, "also check the second tab", "m_fixed");
    await runtime.send(id, "also check the second tab", "m_fixed"); // a retry is queued once
    await runtime.whenIdle(id);
    expect(faux.requests).toHaveLength(before);
    expect((await runtime.status(id)).held).toBe(true);
    expect(payloads(await runtime.read(id), "message.queued")).toEqual([{ id: "m_fixed", text: "also check the second tab" }]);

    await runtime.closeTakeover(id);
    await runtime.whenIdle(id);
    const sent = JSON.stringify(faux.requests.map((r) => r.messages));
    expect(sent.indexOf(HANDBACK_NOT_VIEWED)).toBeGreaterThan(-1);
    expect(sent.indexOf("also check the second tab")).toBeGreaterThan(sent.indexOf(HANDBACK_NOT_VIEWED)); // after the hand-back
    expect(waitingFrom(await runtime.read(id)).queued).toEqual([]); // delivered
  });

  it("closing with nothing open does nothing", async () => {
    const { runtime } = rig();
    const { id } = await runtime.createSession();
    await runtime.closeTakeover(id, "x");
    expect(types(await runtime.read(id))).not.toContain("takeover.closed");
  });
});

describe("after a restart", () => {
  it("repairs a take-over, approvals without a decision, calls without a result and an unfinished run; the repair is pure", () => {
    const at = (seq: number, type: string, payload: unknown): SessionEvent => ({ v: 1, seq, at: seq, sessionId: "s", type, payload: payload as never });
    const events = [
      at(0, "run.started", null),
      at(1, "approval.requested", { id: "a1", tool: "t", args: {} }),
      at(2, "approval.requested", { id: "a2", tool: "t", args: {} }),
      at(3, "approval.decided", { id: "a2", approved: true }),
      at(4, "tool.call", { id: "c1", name: "x" }),
      at(5, "tool.call", { id: "c2", name: "y" }),
      at(6, "tool.result", { call: { id: "c2" }, result: {} }),
      at(7, "takeover.opened", { since: 7, workspaceId: "w" }),
      at(8, "takeover.viewer_connected", {}),
    ];
    const drafts = repairAfterRestart(events);
    expect(drafts.map((d) => d.type).sort()).toEqual(["approval.expired", "run.finished", "takeover.closed", "tool.result"]);
    expect(drafts.at(-1)).toEqual({ type: "run.finished", payload: { reason: "restart" } }); // last, after the calls it cut off
    expect(drafts.find((d) => d.type === "approval.expired")?.payload).toEqual({ id: "a1", reason: "restart" });
    expect(drafts.find((d) => d.type === "takeover.closed")?.payload).toMatchObject({ viewed: true });
    expect(drafts.find((d) => d.type === "tool.result")?.payload).toMatchObject({ outcome: "interrupted", call: { id: "c1" } });
    expect(repairAfterRestart([...events, ...drafts.map((d, i) => at(9 + i, d.type, d.payload))])).toEqual([]); // nothing left to repair
  });

  it("writes the repairs when the session is opened again, and refuses to decide an approval that is gone", async () => {
    const first = rig();
    const { id } = await first.runtime.createSession();
    await first.runtime.openTakeover(id);
    await first.runtime.close();
    const second = rig({ root: first.root });
    await second.runtime.openSession(id);
    const events = await second.runtime.read(id);
    expect(payloads(events, "takeover.closed")[0]).toMatchObject({ viewed: false });
    expect(await second.runtime.takeoverState(id)).toBeNull();
    await expect(second.runtime.decideApproval(id, "ap_gone", true)).rejects.toSatisfy((e) => isOgbError(e, "conflict"));
  });
});

describe("deleting a session", () => {
  it("removes the workspace and the session's files, including its journal", async () => {
    const { runtime, workspaces, root } = rig();
    const { id } = await runtime.createSession();
    await runtime.send(id, "hello");
    await runtime.whenIdle(id);
    await runtime.deleteSession(id);
    expect(workspaces.destroyed).toContain(id);
    expect(await runtime.list()).toEqual([]);
    expect(existsSync(join(root, "sessions", id))).toBe(false);
    await runtime.deleteSession(id); // harmless the second time
  });
});
