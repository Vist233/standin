import { OgbError } from "@standin/contracts";
import { afterEach, describe, expect, it } from "vitest";
import { type GatewayRig, type RigOptions, startRig } from "./rig.ts";

const rigs: GatewayRig[] = [];
async function rig(options: RigOptions = {}) {
  const made = await startRig(options);
  rigs.push(made);
  return made;
}
afterEach(async () => {
  for (const r of rigs.splice(0)) await r.cleanup();
});

describe("health and options", () => {
  it("reports health and readiness", async () => {
    let ready = false;
    const r = await rig({ ready: () => ready });
    expect((await r.probe.call("GET", "/api/health")).json).toEqual({ ok: true, api: 2, ready: false });
    ready = true;
    expect((await r.probe.call("GET", "/api/health")).json.ready).toBe(true);
  });

  it("offers the names for the new-session form and says which features exist", async () => {
    const r = await rig();
    expect((await r.probe.call("GET", "/api/options")).json).toEqual({
      profiles: ["general"],
      defaultProfile: "general",
      models: ["main"],
      takeover: true,
      liveView: true,
      startup: [],
      files: true,
      limits: { fileBytes: 25 * 1024 * 1024, files: 20 },
    });
    const lines = await rig({ startup: () => [{ level: "warn", text: "model key is not set" }] });
    expect((await lines.probe.call("GET", "/api/options")).json.startup).toEqual([{ level: "warn", text: "model key is not set" }]);
    const bare = await rig({ catalog: undefined, workspaces: undefined });
    expect((await bare.probe.call("GET", "/api/options")).json).toMatchObject({ profiles: [], models: [], takeover: false, liveView: false });
  });
});

describe("sessions", () => {
  it("creates a session from the page's request, unchanged, and lists it", async () => {
    const r = await rig();
    const created = await r.probe.call("POST", "/api/sessions", { body: { title: "Taxes", profile: "general", model: "main" } });
    expect(created.status).toBe(201);
    expect(created.json.session).toMatchObject({ title: "Taxes", status: "active" });
    expect(r.runtime.calls[0]).toBe('createSession:{"title":"Taxes","profile":"general","model":"main"}');
    const list = await r.probe.call("GET", "/api/sessions");
    expect(list.json.sessions).toEqual([
      expect.objectContaining({
        title: "Taxes",
        state: { run: "idle", held: false, queued: 0, pending: 0, lastRunEnd: null },
        takeover: false,
        pending: 0,
        lastRunEnd: null,
      }),
    ]);
  });

  it("passes the runtime's refusal of a request that touches the safety floor through as 403 with its kind", async () => {
    const r = await rig();
    r.runtime.failNext("createSession", new OgbError("denied", "'disableReview' cannot be set from the page"));
    const reply = await r.probe.call("POST", "/api/sessions", { body: { disableReview: true } });
    expect(reply.status).toBe(403);
    expect(reply.json.error).toEqual({ kind: "denied", message: "'disableReview' cannot be set from the page" });
  });

  it("an empty create body is a request with defaults", async () => {
    const r = await rig();
    expect((await r.probe.call("POST", "/api/sessions")).status).toBe(201);
    expect(r.runtime.calls[0]).toBe("createSession:{}");
  });

  it("describes one session with its state, approvals and take-over flag", async () => {
    const r = await rig();
    r.runtime.add("s_a", "Alpha");
    r.runtime.setStatus("s_a", { held: true, queued: 3 });
    r.runtime.setApprovals("s_a", [{ id: "ap_1", tool: "mail", args: { to: "x" } }]);
    const reply = await r.probe.call("GET", "/api/sessions/s_a");
    expect(reply.json).toEqual({
      session: expect.objectContaining({ id: "s_a", title: "Alpha" }),
      state: { run: "idle", held: true, queued: 3, pending: 0, lastRunEnd: null },
      approvals: [{ id: "ap_1", tool: "mail", args: { to: "x" } }],
      takeover: null,
      pending: 0,
      lastRunEnd: null,
    });
  });

  it("answers 404 for an unknown session on every session route, and for ids that are not ids", async () => {
    const r = await rig();
    const routes: [string, string, object?][] = [
      ["GET", "/api/sessions/s_x"],
      ["POST", "/api/sessions/s_x/resume"],
      ["POST", "/api/sessions/s_x/messages", { text: "hi" }],
      ["POST", "/api/sessions/s_x/stop"],
      ["GET", "/api/sessions/s_x/approvals"],
      ["POST", "/api/sessions/s_x/approvals/ap_1", { approved: true }],
      ["GET", "/api/sessions/s_x/history"],
      ["GET", "/api/sessions/s_x/events"],
      ["POST", "/api/sessions/s_x/live-view", {}],
      ["POST", "/api/sessions/s_x/takeover"],
      ["POST", "/api/sessions/s_x/handback"],
    ];
    for (const [method, path, body] of routes) {
      const reply = await r.probe.call(method, path, body ? { body } : {});
      expect(reply.status, `${method} ${path}`).toBe(404);
      expect(reply.json.error.kind).toBe("not_found");
    }
    for (const bad of ["..", "a%2Fb", "a.b", "x".repeat(65)]) expect((await r.probe.call("GET", `/api/sessions/${bad}`)).status).toBe(404);
  });

  it("resumes (reopens) a stored session", async () => {
    const r = await rig();
    r.runtime.add("s_a");
    const reply = await r.probe.call("POST", "/api/sessions/s_a/resume");
    expect(reply.json.session.id).toBe("s_a");
    expect(r.runtime.calls).toContain("openSession:s_a");
  });
});

describe("what the session list says about each session", () => {
  const draft = (type: string, payload: unknown) => ({ type, payload: payload as never });

  it("passes on what the runtime counts (waiting things, how the last run ended) in the list and the description", async () => {
    const r = await rig();
    r.runtime.add("s_a");
    r.runtime.setStatus("s_a", { pending: 2, lastRunEnd: "error" });
    expect((await r.probe.call("GET", "/api/sessions")).json.sessions[0]).toMatchObject({ pending: 2, lastRunEnd: "error" });
    expect((await r.probe.call("GET", "/api/sessions/s_a")).json).toMatchObject({ pending: 2, lastRunEnd: "error" });
    expect(r.runtime.calls.filter((c) => c.startsWith("read:"))).toEqual([]); // the gateway no longer reads journals for it
  });

  it("survives junk payloads", async () => {
    const r = await rig();
    r.runtime.add("s_a");
    for (const payload of [null, 3, "x", [], { id: 5 }])
      for (const type of ["approval.requested", "human.question", "message.user", "run.finished"]) await r.runtime.emit("s_a", draft(type, payload));
    expect((await r.probe.call("GET", "/api/sessions")).status).toBe(200);
  });

  it("a take-over shows in the list and in the description, from the runtime", async () => {
    const r = await rig();
    r.runtime.add("s_a");
    r.runtime.takeovers.set("s_a", { since: 5, viewed: false });
    expect((await r.probe.call("GET", "/api/sessions")).json.sessions[0].takeover).toBe(true);
    expect((await r.probe.call("GET", "/api/sessions/s_a")).json.takeover).toEqual({ since: 5, viewed: false });
  });
});

describe("deleting a session", () => {
  it("removes it through the runtime; a repeat is harmless", async () => {
    const r = await rig();
    r.runtime.add("s_a");
    expect((await r.probe.call("DELETE", "/api/sessions/s_a")).json).toEqual({ ok: true });
    expect((await r.probe.call("DELETE", "/api/sessions/s_a")).status).toBe(200);
    expect((await r.probe.call("GET", "/api/sessions")).json.sessions).toEqual([]);
    expect(r.runtime.calls.filter((c) => c.startsWith("deleteSession"))).toHaveLength(2);
  });

  it("needs the token and the right Origin like any write", async () => {
    const r = await rig({ token: "t" });
    r.runtime.add("s_a");
    expect((await r.probe.call("DELETE", "/api/sessions/s_a")).status).toBe(401);
    const bad = await r.probe.call("DELETE", "/api/sessions/s_a", { headers: { authorization: "Bearer t", origin: "http://evil.example" } });
    expect(bad.status).toBe(403);
    expect(r.runtime.calls.some((c) => c.startsWith("deleteSession"))).toBe(false);
  });
});

describe("messages, stop, approvals", () => {
  it("sends the person's text with an optional id for safe retries", async () => {
    const r = await rig();
    r.runtime.add("s_a");
    expect((await r.probe.call("POST", "/api/sessions/s_a/messages", { body: { text: "hello", id: "m-1" } })).status).toBe(202);
    expect((await r.probe.call("POST", "/api/sessions/s_a/messages", { body: { text: "no id" } })).status).toBe(202);
    expect(r.runtime.calls.filter((c) => c.startsWith("send"))).toEqual(["send:s_a:hello:m-1", "send:s_a:no id"]);
  });

  it.each([
    [{}, "text"],
    [{ text: "" }, "text"],
    [{ text: "   " }, "text"],
    [{ text: 5 }, "text"],
    [{ text: "x".repeat(100_001) }, "text"],
    [{ text: "ok", id: "" }, "id"],
    [{ text: "ok", id: 7 }, "id"],
  ])("refuses a bad message body %j", async (body, field) => {
    const r = await rig();
    r.runtime.add("s_a");
    const reply = await r.probe.call("POST", "/api/sessions/s_a/messages", { body: body as object, ...(JSON.stringify(body).length > 60_000 ? {} : {}) });
    expect([400, 413]).toContain(reply.status);
    if (reply.status === 400) expect(reply.json.error.message).toContain(field);
    expect(r.runtime.calls.some((c) => c.startsWith("send"))).toBe(false);
  });

  it("stops a session, and a held session then shows the held flag", async () => {
    const r = await rig();
    r.runtime.add("s_a");
    expect((await r.probe.call("POST", "/api/sessions/s_a/stop")).status).toBe(202);
    expect((await r.probe.call("GET", "/api/sessions/s_a")).json.state.held).toBe(true);
  });

  it("lists pending approvals and takes a decision; a repeat is harmless", async () => {
    const r = await rig();
    r.runtime.add("s_a");
    r.runtime.setApprovals("s_a", [{ id: "ap_1", tool: "send_mail", args: {} }]);
    expect((await r.probe.call("GET", "/api/sessions/s_a/approvals")).json.approvals).toHaveLength(1);
    expect((await r.probe.call("POST", "/api/sessions/s_a/approvals/ap_1", { body: { approved: false } })).status).toBe(200);
    expect((await r.probe.call("POST", "/api/sessions/s_a/approvals/ap_1", { body: { approved: false } })).status).toBe(200);
    expect(r.runtime.calls.filter((c) => c.startsWith("decide"))).toEqual(["decideApproval:s_a:ap_1:false", "decideApproval:s_a:ap_1:false"]);
    for (const body of [{}, { approved: "yes" }, { approved: 1 }])
      expect((await r.probe.call("POST", "/api/sessions/s_a/approvals/ap_1", { body })).status).toBe(400);
  });

  it("returns the history after a sequence number", async () => {
    const r = await rig();
    r.runtime.add("s_a");
    for (let i = 0; i < 5; i++) await r.runtime.emit("s_a", { type: "message.user", payload: { i } });
    const all = (await r.probe.call("GET", "/api/sessions/s_a/history")).json.events;
    expect(all.map((e: { seq: number }) => e.seq)).toEqual([1, 2, 3, 4, 5]);
    expect((await r.probe.call("GET", "/api/sessions/s_a/history?after=3")).json.events.map((e: { seq: number }) => e.seq)).toEqual([4, 5]);
    for (const bad of ["-1", "x", "1.5", "99999999999999999999"])
      expect((await r.probe.call("GET", `/api/sessions/s_a/history?after=${bad}`)).status).toBe(400);
  });
});

describe("a bot's name and star", () => {
  it("PATCH renames and changes the star through the runtime; an empty name is refused before it", async () => {
    const r = await rig();
    r.runtime.add("s_a");
    const renamed = await r.probe.call("PATCH", "/api/sessions/s_a", { body: { title: "Scout", star: "dawn" } });
    expect(renamed.status).toBe(200);
    expect(renamed.json.session).toMatchObject({ title: "Scout", star: "dawn" });
    expect((await r.probe.call("PATCH", "/api/sessions/s_a", { body: { title: "" } })).status).toBe(400);
  });

  it("PATCH switches yolo with true or false only", async () => {
    const r = await rig();
    r.runtime.add("s_a");
    const on = await r.probe.call("PATCH", "/api/sessions/s_a", { body: { yolo: true } });
    expect(on.status).toBe(200);
    expect(on.json.session).toMatchObject({ yolo: true });
    expect((await r.probe.call("PATCH", "/api/sessions/s_a", { body: { yolo: "on" } })).status).toBe(400);
  });
});

describe("request handling", () => {
  it("caps the body: by declared length and by what actually arrives", async () => {
    const r = await rig({ limits: { maxBodyBytes: 100 } });
    r.runtime.add("s_a");
    const big = await r.probe.call("POST", "/api/sessions/s_a/messages", { body: { text: "x".repeat(200) } });
    expect(big.status).toBe(413);
    expect(r.runtime.calls.some((c) => c.startsWith("send"))).toBe(false);
    // a client that lies about the length (chunked, no content-length)
    const { request } = await import("node:http");
    const status = await new Promise<number>((resolve) => {
      const req = request(
        {
          host: "127.0.0.1",
          port: r.port,
          method: "POST",
          path: "/api/sessions/s_a/messages",
          headers: { "content-type": "application/json", "transfer-encoding": "chunked" },
        },
        (res) => {
          res.resume();
          resolve(res.statusCode ?? 0);
        },
      );
      req.on("error", () => resolve(0));
      req.write(`{"text":"${"y".repeat(500)}"}`);
      req.end();
    });
    expect(status).toBe(413);
  });

  it("wants application/json, valid JSON and an object", async () => {
    const r = await rig();
    r.runtime.add("s_a");
    const text = (headers: Record<string, string>, body: string) => r.probe.call("POST", "/api/sessions/s_a/messages", { headers, body });
    expect((await text({ "content-type": "text/plain" }, '{"text":"a"}')).status).toBe(415);
    expect((await text({ "content-type": "application/x-www-form-urlencoded" }, "text=a")).status).toBe(415);
    expect((await text({ "content-type": "application/json" }, "{nope")).status).toBe(400);
    expect((await text({ "content-type": "application/json" }, "[1]")).status).toBe(400);
    expect((await text({ "content-type": "application/json" }, "null")).status).toBe(400);
    expect((await text({ "content-type": "application/json; charset=utf-8" }, '{"text":"a"}')).status).toBe(202);
  });

  it("answers 404 for unknown paths and 405 for the wrong method", async () => {
    const r = await rig();
    r.runtime.add("s_a");
    expect((await r.probe.call("GET", "/api/nothing")).status).toBe(404);
    expect((await r.probe.call("PUT", "/api/sessions/s_a")).status).toBe(405);
    expect((await r.probe.call("GET", "/api/sessions/s_a/messages")).status).toBe(405);
    expect((await r.probe.call("PUT", "/index.html")).status).toBe(405);
  });

  it("maps each error kind to a status, and never shows the text of a bug", async () => {
    const r = await rig();
    const cases: [OgbError | Error, number][] = [
      [new OgbError("invalid_input", "bad"), 400],
      [new OgbError("not_found", "gone"), 404],
      [new OgbError("conflict", "busy"), 409],
      [new OgbError("unavailable", "disk"), 503],
      [new OgbError("denied", "no"), 403],
      [new OgbError("internal", "secret path /home/x"), 500],
      [new OgbError("corrupt", "file /home/x broken"), 500],
      [new Error("TypeError at /srv/private/file.ts"), 500],
    ];
    for (const [error, status] of cases) {
      r.runtime.failNext("list", error);
      const reply = await r.probe.call("GET", "/api/sessions");
      expect(reply.status).toBe(status);
      expect(reply.text).not.toContain("/home/x");
      expect(reply.text).not.toContain("/srv/private");
    }
    expect(r.logs.some((l) => String(l.error).includes("/srv/private"))).toBe(true); // the log has it
  });

  it("sets safety headers on API answers and the page, and a CSP on the page", async () => {
    const r = await rig();
    const api = await r.probe.call("GET", "/api/health");
    expect(api.headers["x-content-type-options"]).toBe("nosniff");
    expect(api.headers["cache-control"]).toBe("no-store");
    const page = await r.probe.call("GET", "/");
    expect(page.headers["content-security-policy"]).toContain("script-src 'self'");
    expect(page.headers["content-security-policy"]).toContain("default-src 'none'");
    expect(page.headers["x-frame-options"]).toBe("DENY");
  });
});
