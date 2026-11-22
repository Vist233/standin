// The browser and computer plugins installed from a marketplace, loaded by the plugin host and used by a session of the runtime with the
// framework's real agent loop, sub-agents and review. The tools are real: their runners start through the workspace's `spawn` (the computer's
// Python runner needs no display for these steps; the browser drives a real headless Chrome and is skipped without one). Only the model is scripted.
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { installFromMarketplace, makeWritable, parseMarketplace } from "@vesper/plugin-host";
import { createRig, lastMessage } from "@vesper/session-runtime/testing";
import { reviewPlugin } from "sakura-agent";
import { findChrome, launchChrome } from "sakura-agent-tools/browser";
import { createFauxClient } from "sakura-agent/testing";
import { afterEach, beforeAll, describe, expect, it } from "vitest";

const repoRoot = resolve(import.meta.dirname, "..", "..");
const cleanups: (() => void | Promise<void>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});
beforeAll(() => {
  process.env.OGB_APP_ROOT = repoRoot; // the plugins find the runners at <app root>/vendor/agent-tools, as in the image
});

type Request = { tools: { name: string }[]; messages: { role: string; content: { type: string; text?: string }[] }[] };
const toolNames = (request: Request) => request.tools.map((t) => t.name);
const toolResultTexts = (request: Request) => request.messages.filter((m) => m.role === "tool").map((m) => JSON.stringify(m.content));
const ALLOW = '{"risk_level":"low","user_authorization":"high","outcome":"allow","rationale":"ok"}';
const runners = () =>
  execFileSync("ps", ["-eo", "args"])
    .toString()
    .split("\n")
    .filter((line) => line.includes("vendor/agent-tools") && line.includes("runner"));

function install(...names: string[]) {
  const cache = mkdtempSync(join(tmpdir(), "ogb-plugin-cache-"));
  cleanups.push(() => {
    makeWritable(cache);
    rmSync(cache, { recursive: true, force: true });
  });
  const marketplace = parseMarketplace({ name: "mine", plugins: names.map((name) => ({ name, source: { type: "local", path: `./plugins/${name}` } })) });
  const result = installFromMarketplace({ marketplace, baseDir: repoRoot, cacheDir: cache });
  expect(result.skipped).toEqual([]);
  return result.installed;
}

describe("computer plugin", () => {
  it("runs the agent's Python through the workspace, every call reviewed; a sub-agent has the tool and its own names; the runners end with the session", async () => {
    const reviewed: string[] = [];
    const reviewer = createFauxClient((request) => {
      reviewed.push(/tool: (\w+)/.exec(JSON.stringify(lastMessage(request as never)))?.[1] ?? "?");
      return { text: ALLOW };
    });
    const rig = createRig({
      plugins: install("computer"),
      profiles: { default: "p", profiles: { p: { plugins: ["computer"], alwaysDeclaredTools: ["computer"] } } },
      workspace: { display: ":99" },
      runtime: { safetyPlugins: () => [reviewPlugin({ llm: reviewer })] },
      script: (request) => {
        const results = toolResultTexts(request as never);
        if (!request.tools.some((t) => t.name === "delegate"))
          return results.length === 0 ? { toolCalls: [{ name: "computer", args: { code: "'mine' in globals()" } }] } : { text: "helper done" };
        return (
          [
            {
              toolCalls: [
                { name: "computer", args: { code: "import os\nmine = 1\n(os.getcwd(), os.environ.get('DISPLAY'), 'COMMANDCODE_API_KEY' in os.environ)" } },
              ],
            },
            { toolCalls: [{ name: "delegate", args: { message: "Check the desktop session." } }] },
          ][results.length] ?? { text: "done" }
        );
      },
    });
    cleanups.push(() => rig.cleanup());
    const { id } = await rig.runtime.createSession();
    await rig.runtime.send(id, "look at the desktop");
    await rig.runtime.whenIdle(id);

    expect(toolNames(rig.faux.requests[0] as never)).toContain("computer");
    const results = (await rig.runtime.read(id)).filter((e) => e.type === "tool.result").map((e) => JSON.stringify(e.payload));
    expect(results[0]).toMatch(/files\\",\s*\\":99\\",\s*false/); // in the files directory, on the workspace's display, no key
    const child = rig.faux.requests.find((r) => !r.tools.some((t) => t.name === "delegate"));
    expect(child?.tools.map((t) => t.name)).toContain("computer");
    expect(JSON.stringify(rig.faux.requests.filter((r) => !r.tools.some((t) => t.name === "delegate")).at(-1)?.messages)).toContain("false"); // its own names
    expect(reviewed.filter((name) => name === "computer").length).toBeGreaterThanOrEqual(2);
    expect(runners().length).toBeGreaterThan(0);
    await rig.runtime.closeSession(id);
    expect(runners()).toEqual([]);
  });

  it("is not offered without a display", async () => {
    const rig = createRig({
      plugins: install("computer"),
      profiles: { default: "p", profiles: { p: { plugins: ["computer"] } } },
      script: () => ({ text: "none" }),
    });
    cleanups.push(() => rig.cleanup());
    const { id } = await rig.runtime.createSession();
    await rig.runtime.send(id, "anything");
    await rig.runtime.whenIdle(id);
    expect(JSON.stringify(rig.faux.requests[0]?.tools)).not.toContain('"computer"');
  });
});

describe("browser plugin", { skip: !findChrome() }, () => {
  it("runs Playwright code against the workspace's browser; a sub-agent works in a tab of its own", async () => {
    const chrome = await launchChrome();
    const server = createServer((_request, response) => {
      response.setHeader("content-type", "text/html");
      response.end("<title>Prices</title><p id=p>10 euros</p>");
    });
    await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
    const site = `http://127.0.0.1:${(server.address() as { port: number }).port}/`;
    cleanups.push(async () => {
      server.close();
      await chrome.close();
    });
    const call = (code: string) => ({ toolCalls: [{ name: "tool_call", args: { name: "browser", args: { code } } }] });
    const rig = createRig({
      plugins: install("browser"),
      profiles: { default: "p", profiles: { p: { plugins: ["browser"] } } },
      workspace: { cdpUrl: chrome.cdpUrl },
      script: (request) => {
        const results = toolResultTexts(request as never);
        if (!request.tools.some((t) => t.name === "delegate")) return results.length === 0 ? call("return page.url()") : { text: "helper done" };
        return (
          [
            call(`await page.goto(${JSON.stringify(site)}); return await page.locator('#p').innerText()`),
            { toolCalls: [{ name: "delegate", args: { message: "Where is your tab?" } }] },
          ][results.length] ?? { text: "done" }
        );
      },
    });
    cleanups.push(() => rig.cleanup());
    const { id } = await rig.runtime.createSession();
    await rig.runtime.send(id, "what does it cost?");
    await rig.runtime.whenIdle(id);
    const results = (await rig.runtime.read(id)).filter((e) => e.type === "tool.result").map((e) => JSON.stringify(e.payload));
    expect(results[0]).toContain("10 euros");
    expect(results[0]).toContain("Prices");
    const childResults = rig.faux.requests.filter((r) => !r.tools.some((t) => t.name === "delegate")).flatMap((r) => toolResultTexts(r as never));
    expect(childResults.join("")).toContain("about:blank"); // the helper's own tab, not the parent's page
  });
});
