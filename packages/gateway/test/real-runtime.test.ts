import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRig, lastUserText } from "@standin/session-runtime/testing";
import { afterEach, describe, expect, it } from "vitest";
import { createGateway } from "../src/index.ts";
import { startProbe } from "../src/testing/index.ts";

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

async function boot(root: string) {
  const rig = createRig({ root, script: (request) => ({ text: `echo: ${lastUserText(request)}` }) });
  const gateway = createGateway({ runtime: rig.runtime });
  const { port } = await gateway.listen();
  const probe = startProbe(port);
  return {
    rig,
    probe,
    async stop() {
      await gateway.close();
      await rig.runtime.close();
    },
  };
}

describe("the gateway over the real session runtime (scripted model, real files, real journal)", () => {
  it("creates a session, takes a message, streams the whole run, and refuses a request that touches the safety floor", async () => {
    const root = mkdtempSync(join(tmpdir(), "ogb-gw-real-"));
    cleanups.push(async () => rmSync(root, { recursive: true, force: true }));
    const app = await boot(root);
    cleanups.push(app.stop);

    const created = await app.probe.call("POST", "/api/sessions", { body: { title: "Taxes" } });
    expect(created.status).toBe(201);
    const id = created.json.session.id as string;

    const stream = app.probe.stream(`/api/sessions/${id}/events`);
    expect((await app.probe.call("POST", `/api/sessions/${id}/messages`, { body: { text: "hello", id: "m1" } })).status).toBe(202);
    for (let i = 0; i < 500 && !stream.frames.some((f) => f.event.type === "run.finished"); i++) await new Promise((r) => setTimeout(r, 20));
    const types = stream.frames.map((f) => f.event.type);
    expect(types).toEqual(expect.arrayContaining(["run.started", "message.user", "message.assistant", "run.finished"]));
    expect(stream.frames.map((f) => f.id)).toEqual(stream.frames.map((_, i) => i + 1)); // gap-free
    expect(stream.frames.find((f) => f.event.type === "message.assistant")?.event.payload).toMatchObject({ content: [{ text: "echo: hello" }] });
    stream.close();

    // the same message id again does not run twice
    await app.probe.call("POST", `/api/sessions/${id}/messages`, { body: { text: "hello", id: "m1" } });
    await app.rig.runtime.whenIdle(id);
    const history = (await app.probe.call("GET", `/api/sessions/${id}/history`)).json.events as { type: string }[];
    expect(history.filter((e) => e.type === "message.assistant")).toHaveLength(1);

    const refused = await app.probe.call("POST", "/api/sessions", { body: { title: "x", disableReview: true } });
    expect(refused.status).toBe(403);
    expect((await app.probe.call("POST", "/api/sessions", { body: { title: "x", wat: 1 } })).status).toBe(400);
    expect((await app.probe.call("POST", "/api/sessions", { body: { profile: "nope" } })).status).toBe(404);
    expect((await app.probe.call("GET", `/api/sessions/${id}`)).json.state).toMatchObject({ run: "idle", held: false, queued: 0 });
  });

  it("stop holds the session and the next message releases it", async () => {
    const root = mkdtempSync(join(tmpdir(), "ogb-gw-real-"));
    cleanups.push(async () => rmSync(root, { recursive: true, force: true }));
    const app = await boot(root);
    cleanups.push(app.stop);
    const id = (await app.probe.call("POST", "/api/sessions", { body: {} })).json.session.id as string;
    expect((await app.probe.call("POST", `/api/sessions/${id}/stop`)).status).toBe(202);
    expect((await app.probe.call("GET", `/api/sessions/${id}`)).json.state.held).toBe(true);
    await app.probe.call("POST", `/api/sessions/${id}/messages`, { body: { text: "go on" } });
    await app.rig.runtime.whenIdle(id);
    expect((await app.probe.call("GET", `/api/sessions/${id}`)).json.state.held).toBe(false);
  });

  it("survives a restart of the whole box: the page reconnects with its last id and the numbering goes on", async () => {
    const root = mkdtempSync(join(tmpdir(), "ogb-gw-real-"));
    cleanups.push(async () => rmSync(root, { recursive: true, force: true }));
    const first = await boot(root);
    const id = (await first.probe.call("POST", "/api/sessions", { body: { title: "Long" } })).json.session.id as string;
    await first.probe.call("POST", `/api/sessions/${id}/messages`, { body: { text: "one" } });
    await first.rig.runtime.whenIdle(id);
    const seen = (await first.probe.call("GET", `/api/sessions/${id}/history`)).json.events as { seq: number }[];
    const last = seen.at(-1)?.seq ?? 0;
    await first.stop();

    const second = await boot(root); // same files, new processes
    cleanups.push(second.stop);
    expect((await second.probe.call("GET", "/api/sessions")).json.sessions).toHaveLength(1);
    const stream = second.probe.stream(`/api/sessions/${id}/events`, { "last-event-id": String(last) });
    await second.probe.call("POST", `/api/sessions/${id}/messages`, { body: { text: "two" } });
    for (let i = 0; i < 500 && !stream.frames.some((f) => f.event.type === "run.finished"); i++) await new Promise((r) => setTimeout(r, 20));
    expect(stream.frames[0]?.id).toBe(last + 1);
    expect(stream.frames.map((f) => f.id)).toEqual(stream.frames.map((_, i) => last + 1 + i));
    expect(JSON.stringify(stream.frames.map((f) => f.event.payload))).toContain("echo: two");
    stream.close();
  });
});
