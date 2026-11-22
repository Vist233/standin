import { request } from "node:http";
import type { Socket } from "node:net";
import { OgbError } from "@standin/contracts";
import { afterEach, describe, expect, it } from "vitest";
import { ensureWorkspace, type GatewayRig, type RigOptions, startRig } from "./rig.ts";

const rigs: GatewayRig[] = [];
async function rig(options: RigOptions = {}) {
  const made = await startRig(options);
  rigs.push(made);
  return made;
}
afterEach(async () => {
  for (const r of rigs.splice(0)) await r.cleanup();
});

/** Opens a WebSocket handshake by hand. Resolves with the status and, on 101, the raw socket. */
function upgrade(port: number, path: string, headers: Record<string, string> = {}): Promise<{ status: number; socket?: Socket; body: string }> {
  return new Promise((resolve) => {
    const req = request({
      host: "127.0.0.1",
      port,
      path,
      headers: {
        connection: "Upgrade",
        upgrade: "websocket",
        "sec-websocket-key": "dGhlIHNhbXBsZSBub25jZQ==",
        "sec-websocket-version": "13",
        origin: `http://127.0.0.1:${port}`,
        ...headers,
      },
    });
    req.on("upgrade", (res, socket) => resolve({ status: res.statusCode ?? 0, socket, body: "" }));
    req.on("response", (res) => {
      let body = "";
      res.on("data", (d) => (body += d));
      res.on("end", () => resolve({ status: res.statusCode ?? 0, body }));
    });
    req.on("error", () => resolve({ status: 0, body: "" }));
    req.end();
  });
}

function exchange(socket: Socket, text: string): Promise<string> {
  return new Promise((resolve) => {
    socket.once("data", (d) => resolve(d.toString()));
    socket.write(text);
  });
}

async function setup(options: RigOptions = {}) {
  const r = await rig(options);
  r.runtime.add("s_a");
  await ensureWorkspace(r, "s_a");
  return r;
}
const viewUrl = async (r: GatewayRig, session = "s_a") => (await r.probe.call("POST", `/api/sessions/${session}/live-view`, { body: {} })).json.url as string;
const takeoverUrl = async (r: GatewayRig, session = "s_a") => (await r.probe.call("POST", `/api/sessions/${session}/takeover`)).json.url as string;

describe("live view", () => {
  it("hands out a ticket over the API and relays the desk-daemon's stream with a clean handshake and the daemon's own token", async () => {
    const r = await setup({ token: "tok", probeHeaders: { authorization: "Bearer tok" } });
    const reply = await r.probe.call("POST", "/api/sessions/s_a/live-view", { body: {} });
    expect(reply.status).toBe(200);
    expect(reply.json.url).toMatch(/^\/ws\/s_a\/view\?ticket=[A-Za-z0-9_-]{20,}$/);
    expect(reply.text).not.toContain("daemon-token");
    expect(r.hostCalls).toEqual(["view:s-a"]);

    // The browser cannot send an Authorization header on a WebSocket; the ticket is the credential.
    const ws = await upgrade(r.port, reply.json.url, { cookie: "session=secret", authorization: "Bearer tok", "sec-websocket-protocol": "binary" });
    expect(ws.status).toBe(101);
    expect(await exchange(ws.socket as Socket, "rfb")).toBe("echo:rfb");
    ws.socket?.destroy();

    const seen = r.bridge.handshakes[0];
    expect(seen?.url).toBe("/?token=daemon-token");
    expect(seen?.headers.origin).toBe(`http://127.0.0.1:${r.bridge.port}`);
    expect(seen?.headers.cookie).toBeUndefined();
    expect(seen?.headers.authorization).toBeUndefined();
    expect(seen?.headers["sec-websocket-protocol"]).toBe("binary");
    expect(seen?.headers["sec-websocket-key"]).toBe("dGhlIHNhbXBsZSBub25jZQ==");
  });

  it("watching is not taking over: no runtime call, no viewer report", async () => {
    const r = await setup();
    const ws = await upgrade(r.port, await viewUrl(r));
    expect(ws.status).toBe(101);
    ws.socket?.destroy();
    expect(r.runtime.calls.filter((c) => /Takeover/.test(c))).toEqual([]);
  });

  it("asks the daemon for a ticket for every page ticket", async () => {
    const r = await setup();
    const one = await viewUrl(r);
    const two = await viewUrl(r);
    expect(one).not.toBe(two);
    expect(r.hostCalls).toEqual(["view:s-a", "view:s-a"]);
  });

  it("is a 503 'unavailable' while the workspace does not exist, and without a workspace host", async () => {
    const r = await rig();
    r.runtime.add("s_a"); // a session whose workspace was never started
    const reply = await r.probe.call("POST", "/api/sessions/s_a/live-view", { body: {} });
    expect(reply.status).toBe(503);
    expect(reply.json.error.kind).toBe("unavailable");
    const bare = await setup({ workspaces: undefined });
    expect((await bare.probe.call("POST", "/api/sessions/s_a/live-view", { body: {} })).json.error.kind).toBe("unavailable");
  });

  it("a ticket works once and expires", async () => {
    const r = await setup({ limits: { ticketMs: 1000 } });
    const url = await viewUrl(r);
    const first = await upgrade(r.port, url);
    expect(first.status).toBe(101);
    first.socket?.destroy();
    expect((await upgrade(r.port, url)).status).toBe(401);
    const late = await viewUrl(r);
    r.clock.time += 1001;
    expect((await upgrade(r.port, late)).status).toBe(401);
  });

  it("a ticket is for one session and one kind of view", async () => {
    const r = await setup();
    r.runtime.add("s_b");
    const url = await viewUrl(r);
    const ticket = new URL(url, "http://x").searchParams.get("ticket");
    expect((await upgrade(r.port, `/ws/s_b/view?ticket=${ticket}`)).status).toBe(401);
    expect((await upgrade(r.port, url)).status).toBe(401); // burnt by the wrong use
    expect((await upgrade(r.port, (await viewUrl(r)).replace("/view", "/takeover"))).status).toBe(401);
    expect((await upgrade(r.port, (await takeoverUrl(r)).replace("/takeover", "/view"))).status).toBe(401);
  });

  it("refuses sockets without a ticket, with a bad one, on a wrong path, and with a wrong Host or Origin", async () => {
    const r = await setup();
    const url = await viewUrl(r);
    expect((await upgrade(r.port, "/ws/s_a/view")).status).toBe(401);
    expect((await upgrade(r.port, "/ws/s_a/view?ticket=guess")).status).toBe(401);
    expect((await upgrade(r.port, "/ws/s_a/browser?ticket=x")).status).toBe(404);
    expect((await upgrade(r.port, "/ws/../etc?ticket=x")).status).toBe(404);
    expect((await upgrade(r.port, url, { origin: "http://evil.example" })).status).toBe(403);
    expect((await upgrade(r.port, url, { origin: "null" })).status).toBe(403);
    expect((await upgrade(r.port, url, { host: "evil.example" })).status).toBe(403);
    const noOrigin = await new Promise<number>((resolve) => {
      const req = request({
        host: "127.0.0.1",
        port: r.port,
        path: url,
        headers: { connection: "Upgrade", upgrade: "websocket", "sec-websocket-key": "k", "sec-websocket-version": "13" },
      });
      req.on("upgrade", () => resolve(101));
      req.on("response", (res) => resolve(res.statusCode ?? 0));
      req.end();
    });
    expect(noOrigin).toBe(403); // browsers always send Origin on a WebSocket
    expect(r.bridge.handshakes).toEqual([]);
    expect((await upgrade(r.port, url)).status).toBe(101); // the good ticket still works
  });

  it("limits the number of open streams and frees a slot on disconnect", async () => {
    const r = await setup({ limits: { maxRelays: 2 } });
    const a = await upgrade(r.port, await viewUrl(r));
    const b = await upgrade(r.port, await viewUrl(r));
    expect([a.status, b.status]).toEqual([101, 101]);
    expect((await upgrade(r.port, await viewUrl(r))).status).toBe(503);
    a.socket?.destroy();
    await new Promise((resolve) => setTimeout(resolve, 50));
    const c = await upgrade(r.port, await viewUrl(r));
    expect(c.status).toBe(101);
    b.socket?.destroy();
    c.socket?.destroy();
  });

  it("closes the page's socket when the stream behind it goes away", async () => {
    const r = await setup();
    const ws = await upgrade(r.port, await viewUrl(r));
    const closed = new Promise<void>((resolve) => ws.socket?.on("close", () => resolve()));
    await r.bridge.stop();
    await closed;
  });

  it("is refused when the daemon refuses the token (the relay never invents one)", async () => {
    const r = await setup();
    const url = await viewUrl(r);
    r.bridge.handshakes.length = 0;
    const refused = await upgrade(r.port, url.replace(/ticket=.*/, "ticket=wrong"));
    expect(refused.status).toBe(401);
    expect(r.bridge.handshakes).toEqual([]);
  });
});

describe("take-over", () => {
  it("holds the session through the runtime first, then asks the daemon for a control ticket", async () => {
    const r = await setup();
    const reply = await r.probe.call("POST", "/api/sessions/s_a/takeover");
    expect(reply.status).toBe(200);
    expect(reply.json.url).toMatch(/^\/ws\/s_a\/takeover\?ticket=/);
    expect(reply.json.since).toEqual(expect.any(Number));
    expect(reply.text).not.toContain("daemon-token");
    expect(r.runtime.calls.indexOf("openTakeover:s_a")).toBeGreaterThan(-1);
    expect(r.hostCalls).toEqual(["open:s-a"]);
    expect(r.runtime.takeovers.get("s_a")).toBeDefined(); // the state lives in the runtime
    expect((await r.probe.call("GET", "/api/sessions/s_a")).json.takeover).toMatchObject({ since: reply.json.since, viewed: false });
    expect((await r.probe.call("GET", "/api/sessions")).json.sessions[0].takeover).toBe(true);
  });

  it("reports a viewer to the runtime when the stream is reached, once per connection, and relays bytes with the daemon's token", async () => {
    const r = await setup();
    const ws = await upgrade(r.port, await takeoverUrl(r));
    expect(ws.status).toBe(101);
    expect(await exchange(ws.socket as Socket, "rfb")).toBe("echo:rfb");
    ws.socket?.destroy();
    expect(r.bridge.handshakes[0]?.url).toBe("/?token=daemon-token");
    expect(r.runtime.calls.filter((c) => c.startsWith("reportTakeoverViewer"))).toEqual(["reportTakeoverViewer:s_a"]);
    expect(r.runtime.takeovers.get("s_a")?.viewed).toBe(true);
  });

  it("a page that reloads in the middle gets a fresh ticket without opening a second take-over", async () => {
    const r = await setup();
    const one = (await r.probe.call("POST", "/api/sessions/s_a/takeover")).json;
    const two = (await r.probe.call("POST", "/api/sessions/s_a/takeover")).json;
    expect(two.since).toBe(one.since);
    expect(two.url).not.toBe(one.url);
    expect(r.runtime.calls.filter((c) => c.startsWith("openTakeover"))).toHaveLength(1);
  });

  it("keeps no state of its own: a take-over the runtime already has (after a gateway restart) is joined, not repeated", async () => {
    const r = await setup();
    r.runtime.takeovers.set("s_a", { since: 42, viewed: true });
    const reply = (await r.probe.call("POST", "/api/sessions/s_a/takeover")).json;
    expect(reply.since).toBe(42);
    expect(r.runtime.calls.some((c) => c.startsWith("openTakeover"))).toBe(false);
  });

  it("hands back through the runtime with the note, then closes the desktop stream", async () => {
    const r = await setup();
    await r.probe.call("POST", "/api/sessions/s_a/takeover");
    const reply = await r.probe.call("POST", "/api/sessions/s_a/handback", { body: { note: "signed in" } });
    expect(reply.json).toEqual({ ok: true, wasOpen: true });
    expect(r.runtime.calls).toContain("closeTakeover:s_a:signed in");
    expect(r.hostCalls).toEqual(["open:s-a", "close:s-a"]);
    expect((await r.probe.call("GET", "/api/sessions/s_a")).json.takeover).toBeNull();
  });

  it("a repeated hand-back says wasOpen false", async () => {
    const r = await setup();
    expect((await r.probe.call("POST", "/api/sessions/s_a/handback")).json).toEqual({ ok: true, wasOpen: false });
    await r.probe.call("POST", "/api/sessions/s_a/takeover");
    await r.probe.call("POST", "/api/sessions/s_a/handback");
    expect((await r.probe.call("POST", "/api/sessions/s_a/handback")).json.wasOpen).toBe(false);
  });

  it("still hands back when the daemon cannot be told to close (the runtime is the truth)", async () => {
    const r = await setup();
    await r.probe.call("POST", "/api/sessions/s_a/takeover");
    r.host.takeover.close = async () => {
      throw new Error("daemon away");
    };
    const reply = await r.probe.call("POST", "/api/sessions/s_a/handback");
    expect(reply.status).toBe(200);
    expect(r.runtime.takeovers.size).toBe(0);
  });

  it("if the daemon gives no ticket, the hold it just made is released again; a take-over that was already open stays", async () => {
    const r = await setup();
    const real = r.host.takeover.open;
    r.host.takeover.open = async () => {
      throw new Error("daemon away");
    };
    expect((await r.probe.call("POST", "/api/sessions/s_a/takeover")).status).toBe(500);
    expect(r.runtime.calls).toContain("closeTakeover:s_a");
    expect(r.runtime.takeovers.size).toBe(0);
    r.host.takeover.open = real;
    await r.probe.call("POST", "/api/sessions/s_a/takeover");
    r.host.takeover.open = async () => {
      throw new Error("daemon away");
    };
    await r.probe.call("POST", "/api/sessions/s_a/takeover");
    expect(r.runtime.takeovers.size).toBe(1);
  });

  it("a runtime that cannot open the take-over stops everything before the daemon is asked", async () => {
    const r = await setup();
    r.runtime.failNext("openTakeover", new Error("not built"));
    expect((await r.probe.call("POST", "/api/sessions/s_a/takeover")).status).toBe(500);
    expect(r.hostCalls).toEqual([]);
  });

  it("is unavailable without a workspace host", async () => {
    const r = await setup({ workspaces: undefined });
    expect((await r.probe.call("POST", "/api/sessions/s_a/takeover")).json.error.kind).toBe("unavailable");
    expect((await r.probe.call("POST", "/api/sessions/s_a/handback")).json.error.kind).toBe("unavailable");
  });

  it("needs the bearer token to ask for any ticket", async () => {
    const r = await setup({ token: "t" });
    expect((await r.probe.call("POST", "/api/sessions/s_a/takeover")).status).toBe(401);
    expect((await r.probe.call("POST", "/api/sessions/s_a/live-view", { body: {} })).status).toBe(401);
  });
});

describe("typing text into the desktop (for what the keyboard path cannot carry)", () => {
  const post = (r: GatewayRig, body: unknown) => r.probe.call("POST", "/api/sessions/s_a/text", { body: body as object });

  it("types the text through the host while a take-over is open and says how many characters went in", async () => {
    const r = await setup();
    await r.probe.call("POST", "/api/sessions/s_a/takeover");
    const reply = await post(r, { text: "你好 😀 abc" });
    expect(reply.status).toBe(200);
    expect(reply.json).toEqual({ inserted: 8 });
    expect(r.typed).toEqual(["你好 😀 abc"]);
    expect(r.hostCalls).toContain("insertText:s-a:8");
  });

  it("is a 409 while no take-over is open, and the host is not asked", async () => {
    const r = await setup();
    const reply = await post(r, { text: "x" });
    expect(reply.status).toBe(409);
    expect(reply.json.error.kind).toBe("conflict");
    expect(r.typed).toEqual([]);
  });

  it("refuses empty, missing, non-text and too long text (2000 characters), without quoting it", async () => {
    const r = await setup();
    await r.probe.call("POST", "/api/sessions/s_a/takeover");
    for (const body of [{}, { text: "" }, { text: 5 }, { text: "a".repeat(2001) }, { text: "😀".repeat(2001) }]) {
      const reply = await post(r, body);
      expect(reply.status).toBe(400);
      expect(reply.text).not.toContain("aaaa");
    }
    expect((await post(r, { text: "😀".repeat(2000) })).json.inserted).toBe(2000);
  });

  it("never logs the text, and never puts it in an error answer", async () => {
    const r = await setup();
    await r.probe.call("POST", "/api/sessions/s_a/takeover");
    r.failInsert(new OgbError("denied", "no control stream for this workspace"));
    const reply = await post(r, { text: "hunter2-密码" });
    expect(reply.status).toBe(403);
    expect(reply.text).not.toContain("hunter2");
    expect(JSON.stringify(r.logs)).not.toContain("hunter2");
    expect(JSON.stringify(r.hostCalls)).not.toContain("hunter2");
  });

  it("passes the host's rate limit through as unavailable", async () => {
    const r = await setup();
    await r.probe.call("POST", "/api/sessions/s_a/takeover");
    r.failInsert(new OgbError("unavailable", "too many insertions"));
    expect((await post(r, { text: "x" })).status).toBe(503);
  });

  it("needs the bearer token, a workspace host and a known session", async () => {
    const guarded = await setup({ token: "t" });
    expect((await post(guarded, { text: "x" })).status).toBe(401);
    const bare = await setup({ workspaces: undefined });
    expect((await post(bare, { text: "x" })).json.error.kind).toBe("unavailable");
    const r = await setup();
    expect((await r.probe.call("POST", "/api/sessions/s_zz/text", { body: { text: "x" } })).status).toBe(404);
  });
});
