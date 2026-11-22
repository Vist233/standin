// The handoff plugin installed from a marketplace entry into the cache, loaded by the plugin host, and used by two sessions of
// one runtime that share one store: the whole path from catalogue to a tool result, with the framework's real agent loop.
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { installFromMarketplace, makeWritable, parseMarketplace } from "@standin/plugin-host";
import { createRig, type Rig } from "@standin/session-runtime/testing";
import { afterEach, describe, expect, it } from "vitest";

const repoRoot = resolve(import.meta.dirname, "..", "..");
const cleanups: (() => void | Promise<void>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

const texts = (request: { messages: { role: string; content: { type: string; text?: string }[] }[] }, role: string) =>
  request.messages.filter((m) => m.role === role).map((m) => m.content.map((c) => (c.type === "text" ? (c.text ?? "") : "")).join(""));

function installHandoff() {
  const cache = mkdtempSync(join(tmpdir(), "ogb-plugin-cache-"));
  cleanups.push(() => {
    makeWritable(cache);
    rmSync(cache, { recursive: true, force: true });
  });
  const marketplace = parseMarketplace({ name: "mine", plugins: [{ name: "handoff", source: { type: "local", path: "./plugins/handoff" } }] });
  const result = installFromMarketplace({ marketplace, baseDir: repoRoot, cacheDir: cache });
  expect(result.skipped).toEqual([]);
  return result.installed;
}

const PACKAGE = {
  "handoff.json": {
    id: "dataset/prices",
    version: "1.0.0",
    description: "Daily prices, checked for gaps.",
    tags: ["finance"],
    verify: { cmd: ["node", "check.js"], cwd: "." },
  },
  "data.csv": "day,price\n1,10\n",
  "check.js": 'process.exit(require("fs").readFileSync("data.csv", "utf8").includes("price") ? 0 : 1);',
};

describe("handoff plugin: from marketplace to two agents sharing a store", () => {
  it("one session publishes through tool_call, another finds, pulls and verifies it", async () => {
    const installed = installHandoff();
    expect(installed[0]?.identity).toBe("handoff@mine@0.1.0");
    const rig: Rig = createRig({
      plugins: installed,
      profiles: { default: "p", profiles: { p: { plugins: ["handoff"] } } },
      script: (request) => {
        const goal = texts(request, "user").find((t) => t === "publish the prices" || t === "reuse the prices");
        const toolTurns = request.messages.filter((m) => m.role === "tool").length;
        if (goal === "publish the prices") {
          return toolTurns === 0
            ? { toolCalls: [{ name: "tool_call", args: { name: "handoff", args: { action: "publish", source: PACKAGE } } }] }
            : { text: "published" };
        }
        if (toolTurns === 0) return { toolCalls: [{ name: "tool_call", args: { name: "handoff", args: { action: "search", query: "prices" } } }] };
        if (toolTurns === 1)
          return { toolCalls: [{ name: "tool_call", args: { name: "handoff", args: { action: "pull", id: "dataset/prices", verify: true } } }] };
        return { text: "reused" };
      },
    });
    cleanups.push(() => rig.cleanup());

    const a = await rig.runtime.createSession({ title: "Publisher" });
    const b = await rig.runtime.createSession({ title: "Consumer" });
    for (const id of [a.id, b.id]) {
      const agentsMd = readFileSync(join(rig.root, "workspaces", id, "files", "AGENTS.md"), "utf8");
      expect(agentsMd).toContain("## Sharing work with other agents");
      expect(agentsMd).toContain("You share **results that were checked**");
    }

    await rig.runtime.send(a.id, "publish the prices");
    await rig.runtime.whenIdle(a.id);
    const publishResult = (await rig.runtime.read(a.id)).find((e) => e.type === "tool.result" && JSON.stringify(e.payload).includes("accepted"));
    expect(publishResult).toBeDefined();

    await rig.runtime.send(b.id, "reuse the prices");
    await rig.runtime.whenIdle(b.id);
    const results = (await rig.runtime.read(b.id)).filter((e) => e.type === "tool.result").map((e) => JSON.stringify(e.payload));
    expect(results[0]).toContain("dataset/prices");
    expect(results[1]).toContain('verified\\":true');

    const consumerFiles = join(rig.root, "workspaces", b.id, "files", ".exchange");
    expect(existsSync(consumerFiles)).toBe(true);
    expect(existsSync(join(rig.root, "shared", "handoff"))).toBe(true); // the one store of the box
  });

  it("the tool is found by search and not declared up front", async () => {
    const rig = createRig({ plugins: installHandoff(), profiles: { default: "p", profiles: { p: { plugins: ["handoff"] } } }, script: [{ text: "hi" }] });
    cleanups.push(() => rig.cleanup());
    const { id } = await rig.runtime.createSession();
    await rig.runtime.send(id, "hello");
    await rig.runtime.whenIdle(id);
    expect(rig.faux.requests[0]?.tools.map((t) => t.name)).not.toContain("handoff");
  });
});
