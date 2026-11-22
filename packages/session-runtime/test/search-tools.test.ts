import { reviewPlugin } from "sakura-agent";
import { createFauxClient } from "sakura-agent/testing";
import { afterEach, describe, expect, it } from "vitest";
import { rankTools } from "../src/search-tools.ts";
import { createRig, loadPlugins, type Rig, lastMessage } from "../src/testing/index.ts";
import { callCount, gatedPlugin, installGate, resetCalls } from "./helpers.ts";

const rigs: Rig[] = [];
afterEach(async () => {
  for (const r of rigs.splice(0)) await r.cleanup();
});

const ALLOW = '{"risk_level":"low","user_authorization":"high","outcome":"allow","rationale":"ok"}';
const DENY = '{"risk_level":"critical","user_authorization":"unknown","outcome":"deny","rationale":"not allowed by the test reviewer"}';

function rigWithReviewer(options: {
  reviewer: (request: { messages: { content: { type: string; text?: string }[] }[] }) => string;
  approval?: Record<string, string>;
  script: Parameters<typeof createRig>[0] extends infer O ? (O extends { script?: infer S } ? S : never) : never;
}) {
  installGate().open();
  resetCalls();
  const reviewer = createFauxClient((request) => ({ text: options.reviewer(request as never) }));
  const made = createRig({
    plugins: loadPlugins(gatedPlugin(undefined, "demo", options.approval)),
    profiles: { default: "p", profiles: { p: { plugins: ["demo"] } } },
    script: options.script,
    runtime: { safetyPlugins: (_floor, llm) => [reviewPlugin({ llm: reviewer ?? llm })] },
  });
  rigs.push(made);
  return { ...made, reviewer };
}

const toolResults = (request: { messages: { role: string; content: unknown }[] }) =>
  request.messages.filter((m) => m.role === "tool").map((m) => JSON.stringify(m.content));

describe("search wiring: only the original tools plus tool_search and tool_call are declared", () => {
  it("declares exactly those, finds plugin and core tools by words, and runs them through tool_call", async () => {
    const { runtime, faux } = rigWithReviewer({
      reviewer: () => ALLOW,
      script: (_request, index) =>
        [
          { toolCalls: [{ name: "tool_search", args: { query: "ask the person a question" } }] },
          { toolCalls: [{ name: "tool_call", args: { name: "ask_human", args: { question: "Which account?", kind: "choice" } } }] },
          { toolCalls: [{ name: "tool_call", args: { name: "workspace_info", args: {} } }] },
          { toolCalls: [{ name: "tool_call", args: { name: "send_to_user", args: { text: "All done" } } }] },
          { text: "finished" },
        ][index] ?? { text: "finished" },
    });
    const { id } = await runtime.createSession();
    await runtime.send(id, "go");
    await runtime.whenIdle(id);
    // the original tools, search, and the framework's three sub-agent tools (the runtime turns sub-agents on)
    expect(faux.requests[0]?.tools.map((t) => t.name)).toEqual([
      "read",
      "write",
      "edit",
      "bash",
      "tool_search",
      "tool_call",
      "delegate",
      "agent_view",
      "agent_stop",
    ]);
    expect(toolResults(faux.requests[1] as never)[0]).toContain("ask_human");
    const events = await runtime.read(id);
    expect(events.find((e) => e.type === "human.question")?.payload).toMatchObject({
      question: "Which account?",
      kind: "choice",
      id: expect.stringMatching(/^q_/),
    });
    expect(events.find((e) => e.type === "agent.message")?.payload).toEqual({ text: "All done" });
    expect(toolResults(faux.requests[3] as never).at(-1)).toContain("hasDisplay");
  });

  it("finds a plugin's tool and refuses a name that is not in the catalog", async () => {
    const { runtime, faux } = rigWithReviewer({
      reviewer: () => ALLOW,
      script: (_request, index) =>
        [
          { toolCalls: [{ name: "tool_search", args: { query: "gated" } }] },
          { toolCalls: [{ name: "tool_call", args: { name: "not_there" } }] },
          { toolCalls: [{ name: "tool_call", args: { name: "gated", args: {} } }] },
          { text: "ok" },
        ][index] ?? { text: "ok" },
    });
    const { id } = await runtime.createSession();
    await runtime.send(id, "go");
    await runtime.whenIdle(id);
    expect(toolResults(faux.requests[1] as never)[0]).toContain("gated: waits for the test");
    expect(toolResults(faux.requests[2] as never).at(-1)).toContain("There is no tool named 'not_there'");
    expect(callCount()).toBe(1);
  });

  it("reviews the INNER call under its own name, once, and a refusal stops it from running", async () => {
    const seen: string[] = [];
    const { runtime, faux, reviewer } = rigWithReviewer({
      reviewer: (request) => {
        const text = JSON.stringify(lastMessage(request as never));
        seen.push(text);
        return text.includes("tool: gated") ? DENY : ALLOW;
      },
      script: (_request, index) =>
        [{ toolCalls: [{ name: "tool_call", args: { name: "gated", args: { why: "test" } } }] }, { text: "understood" }][index] ?? { text: "understood" },
    });
    const { id } = await runtime.createSession();
    await runtime.send(id, "do the gated thing");
    await runtime.whenIdle(id);
    expect(callCount()).toBe(0); // the inner tool never ran
    expect(reviewer.requests).toHaveLength(1); // one review, not one for tool_call and another for gated
    expect(seen[0]).toContain("tool: gated");
    expect(seen[0]).toContain('{\\"why\\":\\"test\\"}');
    expect(seen[0]).not.toContain("tool: tool_call");
    expect(toolResults(faux.requests[1] as never)[0]).toContain("not allowed by the test reviewer");
  });

  it("lets an allowed inner call run, and records the review under the inner tool's name", async () => {
    const { runtime } = rigWithReviewer({
      reviewer: () => ALLOW,
      script: (_request, index) => [{ toolCalls: [{ name: "tool_call", args: { name: "gated", args: {} } }] }, { text: "done" }][index] ?? { text: "done" },
    });
    const { id } = await runtime.createSession();
    await runtime.send(id, "go");
    await runtime.whenIdle(id);
    expect(callCount()).toBe(1);
  });
});

describe("approval modes from the plugin's manifest", () => {
  it("`ask`: refused once, shown to the person, and after they approve the same call runs once", async () => {
    const { runtime, faux } = rigWithReviewer({
      reviewer: () => ALLOW,
      approval: { gated: "ask" },
      script: (request, index) => {
        const text = JSON.stringify(lastMessage(request as never));
        if (index === 0 || text.includes("approved request") || text.includes("Repeat exactly"))
          return { toolCalls: [{ name: "tool_call", args: { name: "gated", args: { n: 1 } } }] };
        return { text: "waiting for the person" };
      },
    });
    const { id } = await runtime.createSession();
    await runtime.send(id, "do it");
    await runtime.whenIdle(id);
    expect(callCount()).toBe(0);
    const pending = await runtime.pendingApprovals(id);
    expect(pending).toMatchObject([{ id: expect.stringMatching(/^ap_/), tool: "gated", args: { n: 1 } }]);
    expect((await runtime.read(id)).find((e) => e.type === "approval.requested")?.payload).toMatchObject({ tool: "gated" });
    expect(toolResults(faux.requests[1] as never)[0]).toContain("needs the person's approval");

    await runtime.decideApproval(id, pending[0]?.id as string, true);
    await runtime.whenIdle(id);
    await runtime.whenIdle(id);
    expect(callCount()).toBe(1); // exactly one run after the approval
    await runtime.decideApproval(id, pending[0]?.id as string, true); // a repeated decision changes nothing
    await runtime.whenIdle(id);
    expect(callCount()).toBe(1);
    expect(await runtime.pendingApprovals(id)).toEqual([]);
  });

  it("`ask`: a refusal by the person tells the agent not to do it", async () => {
    const { runtime, faux } = rigWithReviewer({
      reviewer: () => ALLOW,
      approval: { gated: "ask" },
      script: (request, index) =>
        index === 0
          ? { toolCalls: [{ name: "tool_call", args: { name: "gated", args: {} } }] }
          : { text: `last: ${JSON.stringify(lastMessage(request as never)?.content).slice(0, 60)}` },
    });
    const { id } = await runtime.createSession();
    await runtime.send(id, "do it");
    await runtime.whenIdle(id);
    const [request] = await runtime.pendingApprovals(id);
    await runtime.decideApproval(id, request?.id as string, false);
    await runtime.whenIdle(id);
    await runtime.whenIdle(id);
    expect(callCount()).toBe(0);
    expect(JSON.stringify(faux.requests.at(-1)?.messages)).toContain("refused request");
  });

  it("`never`: the tool is not allowed at all", async () => {
    const { runtime, faux } = rigWithReviewer({
      reviewer: () => ALLOW,
      approval: { gated: "never" },
      script: (_r, index) => (index === 0 ? { toolCalls: [{ name: "tool_call", args: { name: "gated", args: {} } }] } : { text: "ok" }),
    });
    const { id } = await runtime.createSession();
    await runtime.send(id, "go");
    await runtime.whenIdle(id);
    expect(callCount()).toBe(0);
    expect(toolResults(faux.requests[1] as never)[0]).toContain("is not allowed here");
    expect(await runtime.pendingApprovals(id)).toEqual([]);
  });
});

describe("rankTools", () => {
  const tool = (name: string, description: string) => ({ name, description, parameters: {}, effect: "read" as const, execute: async () => ({ content: [] }) });
  const catalog = [
    tool("mail_send", "Send an e-mail message"),
    tool("mail_list", "List mail in the inbox"),
    tool("browser", "Drive the web browser"),
    tool("ask_human", "Ask the person a question"),
  ];

  it("ranks name matches above description matches and drops tools that match nothing", () => {
    expect(rankTools(catalog, "send mail").map((t) => t.name)).toEqual(["mail_send", "mail_list"]);
    expect(rankTools(catalog, "web").map((t) => t.name)).toEqual(["browser"]);
    expect(rankTools(catalog, "zzz")).toEqual([]);
    expect(rankTools(catalog, "").length).toBe(0);
  });
});
