import { connect as netConnect, createServer, type Server, type Socket } from "node:net";
import type { StreamMode } from "@standin/contracts";
import { afterEach, describe, expect, it } from "vitest";
import { type Bridge, type BridgeOptions, startBridge } from "../src/ws-bridge.ts";

const PORT = 41000 + (process.pid % 2000);
let cleanup: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  for (const fn of cleanup.reverse()) await fn();
  cleanup = [];
});

async function setup(authorize: (t: string) => StreamMode | null = (t) => (t === "good" ? "control" : null), extra: Partial<BridgeOptions> = {}) {
  const target: Server = createServer((s) => {
    s.write("RFB 003.008\n");
    s.on("data", (c) => s.write(c));
    s.on("error", () => {});
  });
  await new Promise<void>((r) => target.listen(PORT + 1, "127.0.0.1", () => r()));
  const bridge: Bridge = await startBridge({ port: PORT, targetPort: PORT + 1, authorize, ...extra });
  cleanup.push(
    () => bridge.close(),
    () => new Promise<void>((r) => target.close(() => r())),
  );
  return { bridge };
}

function connectWs(token: string): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${PORT}/?token=${token}`, "binary");
    ws.binaryType = "arraybuffer";
    ws.onopen = () => resolve(ws);
    ws.onerror = () => reject(new Error("refused"));
    cleanup.push(() => ws.close());
  });
}

function nextMessage(ws: WebSocket): Promise<Buffer> {
  return new Promise((resolve) => {
    ws.onmessage = (event) => resolve(Buffer.from(event.data as ArrayBuffer));
  });
}

describe("token-gated WebSocket bridge", () => {
  it("forwards the VNC server's greeting and echoes binary data both ways", async () => {
    await setup();
    const ws = await connectWs("good");
    expect(ws.protocol).toBe("binary");
    const greeting = await nextMessage(ws);
    expect(greeting.toString()).toBe("RFB 003.008\n");
    const echo = nextMessage(ws);
    ws.send(new Uint8Array([1, 2, 3, 4]));
    expect([...(await echo)]).toEqual([1, 2, 3, 4]);
  });

  it("carries large messages across frame length encodings", async () => {
    await setup();
    const ws = await connectWs("good");
    await nextMessage(ws);
    const received: Buffer[] = [];
    const size = 300_000;
    const done = new Promise<void>((resolve) => {
      ws.onmessage = (event) => {
        received.push(Buffer.from(event.data as ArrayBuffer));
        if (received.reduce((n, b) => n + b.length, 0) >= size) resolve();
      };
    });
    const payload = new Uint8Array(size).map((_, i) => i % 251);
    ws.send(payload);
    await done;
    expect(Buffer.concat(received).equals(Buffer.from(payload))).toBe(true);
  });

  it("refuses a wrong or missing token before any data flows", async () => {
    await setup();
    await expect(connectWs("bad")).rejects.toThrow();
    await expect(connectWs("")).rejects.toThrow();
  });

  it("asks the token check at connection time, so an expired token stops working", async () => {
    let valid = true;
    await setup(() => (valid ? "control" : null));
    await connectWs("x");
    valid = false;
    await expect(connectWs("x")).rejects.toThrow();
  });

  it("answers a plain HTTP request with 426", async () => {
    await setup();
    const response = await fetch(`http://127.0.0.1:${PORT}/?token=good`);
    expect(response.status).toBe(426);
  });

  it("close() drops open connections", async () => {
    const { bridge } = await setup();
    const ws = await connectWs("good");
    await nextMessage(ws);
    const closed = new Promise<void>((resolve) => {
      ws.onclose = () => resolve();
    });
    await bridge.close();
    await closed;
  });

  it("reports 502 when the VNC server is not there", async () => {
    const bridge = await startBridge({ port: PORT + 2, targetPort: PORT + 3, authorize: () => "control" });
    cleanup.push(() => bridge.close());
    await expect(
      new Promise((resolve, reject) => {
        const ws = new WebSocket(`ws://127.0.0.1:${PORT + 2}/?token=x`);
        ws.onopen = resolve;
        ws.onerror = () => reject(new Error("refused"));
      }),
    ).rejects.toThrow();
  });
});

const VERSION = Buffer.from("RFB 003.008\n", "latin1");
const UPDATE_REQUEST = Buffer.from([3, 1, 0, 0, 0, 0, 5, 0, 3, 32]);
const KEY_EVENT = Buffer.from([4, 1, 0, 0, 0, 0, 0xff, 0x0d]);
const POINTER_EVENT = Buffer.from([5, 1, 0, 10, 0, 10]);

/** Collects what arrives until `length` bytes are there (the echo target answers with exactly what the bridge forwarded). */
function collect(ws: WebSocket, length: number): Promise<Buffer> {
  return new Promise((resolve) => {
    const parts: Buffer[] = [];
    ws.onmessage = (event) => {
      parts.push(Buffer.from(event.data as ArrayBuffer));
      if (parts.reduce((n, b) => n + b.length, 0) >= length) resolve(Buffer.concat(parts));
    };
  });
}

function closeCode(ws: WebSocket): Promise<number> {
  return new Promise((resolve) => {
    ws.onclose = (event) => resolve(event.code);
  });
}

/** An upgrade request by hand, to play a client that does not answer pings or does not read. */
async function rawClient(token: string): Promise<{ socket: Socket; head: Promise<Buffer> }> {
  const socket = netConnect(PORT, "127.0.0.1");
  cleanup.push(() => void socket.destroy());
  await new Promise<void>((resolve) => socket.once("connect", () => resolve()));
  socket.write(
    `GET /?token=${token} HTTP/1.1\r\nHost: x\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\nSec-WebSocket-Version: 13\r\n\r\n`,
  );
  const head = new Promise<Buffer>((resolve) => socket.once("data", (chunk: Buffer) => resolve(chunk)));
  return { socket, head };
}

const byToken = (t: string): StreamMode | null => (t === "good" ? "control" : t === "look" || t === "look2" || t === "look3" ? "view" : null);

describe("modes", () => {
  it("a view connection reaches the VNC server with its handshake and update requests, but no key, pointer or clipboard", async () => {
    await setup(byToken);
    const ws = await connectWs("look");
    const cutText = Buffer.concat([Buffer.from([6, 0, 0, 0, 0, 0, 0, 3]), Buffer.from("abc")]);
    const expected = Buffer.concat([VERSION, Buffer.from([1, 1]), UPDATE_REQUEST, UPDATE_REQUEST]);
    const greeting = nextMessage(ws);
    await greeting;
    const echoed = collect(ws, expected.length);
    ws.send(Buffer.concat([VERSION, Buffer.from([1, 0]), UPDATE_REQUEST, KEY_EVENT, POINTER_EVENT, cutText, UPDATE_REQUEST]));
    expect((await echoed).equals(expected)).toBe(true);
  });

  it("with the filter off a view connection is a raw pipe: nothing is dropped, nothing is closed", async () => {
    await setup(byToken, { filterView: false });
    const ws = await connectWs("look");
    await nextMessage(ws);
    const sent = Buffer.concat([KEY_EVENT, POINTER_EVENT, Buffer.from([7, 0, 0, 0])]);
    const echoed = collect(ws, sent.length);
    ws.send(sent);
    expect((await echoed).equals(sent)).toBe(true);
  });

  it("a control connection is a raw pipe: keys and pointer reach the VNC server", async () => {
    await setup(byToken);
    const ws = await connectWs("good");
    await nextMessage(ws);
    const sent = Buffer.concat([KEY_EVENT, POINTER_EVENT]);
    const echoed = collect(ws, sent.length);
    ws.send(sent);
    expect((await echoed).equals(sent)).toBe(true);
  });

  it("closes a view connection with 1008 on a message type it may not send, and reports the type", async () => {
    const reports: string[] = [];
    await setup(byToken, { onViolation: (detail) => void reports.push(detail) });
    const ws = await connectWs("look");
    await nextMessage(ws);
    const code = closeCode(ws);
    ws.send(Buffer.concat([VERSION, Buffer.from([1, 0]), Buffer.from([7, 0, 0, 0])]));
    expect(await code).toBe(1008);
    expect(reports).toEqual(["message type 7 is not allowed from a view-only client"]);
  });

  it("allows two view connections and refuses a third with 503; a view slot frees when one leaves", async () => {
    await setup(byToken);
    const first = await connectWs("look");
    await connectWs("look2");
    const refused = await rawClient("look3");
    expect((await refused.head).toString()).toMatch(/^HTTP\/1.1 503/);
    first.close();
    await new Promise((resolve) => setTimeout(resolve, 100));
    await connectWs("look3");
  });

  it("a new control connection replaces the old one", async () => {
    const { bridge } = await setup(byToken);
    const old = await connectWs("good");
    const oldClosed = closeCode(old);
    const fresh = await connectWs("good");
    const greeting = nextMessage(fresh); // listen at once: the greeting can come while the old connection is still closing
    expect(await oldClosed).toBe(1001);
    await greeting;
    expect(bridge.connections()).toEqual({ control: 1, view: 0 });
  });

  it("drop(mode) closes that mode's connections only and the change callback sees the counts", async () => {
    let changes = 0;
    const { bridge } = await setup(byToken, {
      onChange: () => {
        changes += 1;
      },
    });
    const watcher = await connectWs("look");
    const driver = await connectWs("good");
    await nextMessage(driver);
    const watcherClosed = closeCode(watcher);
    expect(bridge.drop("view")).toBe(1);
    expect(await watcherClosed).toBe(1001);
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(bridge.connections()).toEqual({ control: 1, view: 0 });
    expect(changes).toBeGreaterThanOrEqual(3);
  });
});

describe("keeping connections healthy", () => {
  it("pings a silent client and drops it after the idle time", async () => {
    const { bridge } = await setup(byToken, { pingMs: 40, idleMs: 200, tickMs: 10 });
    const client = await rawClient("good");
    const received: Buffer[] = [];
    client.socket.on("data", (chunk: Buffer) => received.push(chunk));
    await client.head;
    const closed = new Promise<void>((resolve) => client.socket.once("close", () => resolve()));
    await closed;
    const bytes = Buffer.concat(received);
    expect(bytes.includes(Buffer.from([0x89, 0x00]))).toBe(true); // a ping frame
    expect(bridge.connections()).toEqual({ control: 0, view: 0 });
  });

  it("keeps a client that answers: any frame from it counts as life", async () => {
    await setup(byToken, { pingMs: 40, idleMs: 200, tickMs: 10 });
    const ws = await connectWs("good"); // the WebSocket implementation answers pings by itself
    await nextMessage(ws);
    await new Promise((resolve) => setTimeout(resolve, 500));
    expect(ws.readyState).toBe(WebSocket.OPEN);
  });

  it("stops reading the desktop while the client does not read, and drops a client that stays blocked", async () => {
    let written = 0;
    let targetClosed: () => void = () => {};
    const gone = new Promise<void>((resolve) => {
      targetClosed = resolve;
    });
    const flood: Server = createServer((s) => {
      const chunk = Buffer.alloc(1024 * 1024, 1);
      const pump = () => {
        while (!s.destroyed && s.write(chunk)) written += chunk.length;
        written += chunk.length;
      };
      s.on("drain", pump);
      s.on("close", () => targetClosed());
      s.on("error", () => {});
      pump();
    });
    await new Promise<void>((r) => flood.listen(PORT + 1, "127.0.0.1", () => r()));
    const bridge = await startBridge({ port: PORT, targetPort: PORT + 1, authorize: byToken, stalledBytes: 1000, stalledMs: 200, tickMs: 10 });
    cleanup.push(
      () => bridge.close(),
      () => new Promise<void>((r) => flood.close(() => r())),
    );
    const client = await rawClient("good");
    await client.head;
    client.socket.pause(); // a client that stopped reading
    await new Promise((resolve) => setTimeout(resolve, 100));
    const early = written;
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(written).toBeLessThan(256 * 1024 * 1024); // the flood did not run away into memory
    expect(written - early).toBeLessThan(64 * 1024 * 1024);
    await gone; // the bridge gave up on the blocked client and closed its side to the desktop
  });
});
