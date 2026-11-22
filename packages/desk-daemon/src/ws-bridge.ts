import { createHash, timingSafeEqual } from "node:crypto";
import { createServer, type IncomingMessage, type Server } from "node:http";
import { connect, type Socket } from "node:net";
import type { Duplex } from "node:stream";
import type { StreamMode } from "@standin/contracts";
import { RfbViewFilter } from "./rfb-filter.ts";
import { encodeFrame, FrameParser } from "./ws-frame.ts";

const GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11"; // RFC 6455 section 1.3
const CLOSE_GOING_AWAY = 1001;
const CLOSE_POLICY = 1008;
const CLOSE_PROTOCOL = 1002;

export interface BridgeOptions {
  readonly port: number;
  /** The VNC server (x11vnc) this bridge connects each WebSocket to, on 127.0.0.1. */
  readonly targetPort: number;
  /** Decides what a token opens now: its mode, or null for a token that is wrong, revoked or expired. */
  readonly authorize: (token: string) => StreamMode | null;
  /** At most this many `control` connections; a newer one replaces the older (default 1). */
  readonly maxControl?: number;
  /** At most this many `view` connections; one more is refused with 503 (default 2). */
  readonly maxView?: number;
  /** Ping a silent client this often (default 20 s) and drop it after `idleMs` without any byte from it (default 60 s). */
  readonly pingMs?: number;
  readonly idleMs?: number;
  /** Drop a connection whose unsent output stays above `stalledBytes` (default 8 MiB) for `stalledMs` (default 10 s). */
  readonly stalledBytes?: number;
  readonly stalledMs?: number;
  /** How often the timers above are looked at (default 1 s). */
  readonly tickMs?: number;
  /** `false`: view connections are raw pipes like control (default `true`). */
  readonly filterView?: boolean;
  /** A view client broke the rules; `detail` names the message type, never its content. */
  readonly onViolation?: (detail: string) => void;
  /** The number of open connections changed. */
  readonly onChange?: () => void;
}

export interface BridgeConnections {
  readonly control: number;
  readonly view: number;
}

export interface Bridge {
  /** Closes the listener and every open connection. */
  close(): Promise<void>;
  /** Closes every connection of one mode (its token was revoked); returns how many. */
  drop(mode: StreamMode): number;
  connections(): BridgeConnections;
}

interface Connection {
  readonly mode: StreamMode;
  end(code?: number): void;
}

/**
 * A WebSocket-to-TCP bridge (what websockify does) with rules added: a connection needs a token in the query string
 * of the upgrade request, and the token decides the mode. `control` is a raw pipe. `view` is filtered by
 * `RfbViewFilter`, so a viewer cannot press a key or move the pointer, whatever its client does (docs/11 D2).
 * Output is paced to the slowest side (TCP and WebSocket both pause on a full buffer), a silent client is pinged and
 * dropped, and the number of connections per mode is capped. Listens on 127.0.0.1 only. Written here instead of
 * using `websockify` so the token check, the filter and the lifetime of the bridge are ours and testable without a
 * Python process; the cost is a small amount of RFC 6455 code (decision D-T3-6).
 */
export async function startBridge(options: BridgeOptions): Promise<Bridge> {
  const open = new Set<Connection>();
  const count = (mode: StreamMode): number => [...open].filter((c) => c.mode === mode).length;
  const server: Server = createServer((_req, res) => {
    res.writeHead(426, { "content-type": "text/plain" }).end("upgrade required\n");
  });
  const changed = () => options.onChange?.();
  server.on("upgrade", (req, socket) => handleUpgrade(req, socket, options, open, changed));
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(options.port, "127.0.0.1", () => resolve());
  });
  return {
    close: () =>
      new Promise<void>((resolve) => {
        for (const connection of [...open]) connection.end();
        server.close(() => resolve());
      }),
    drop(mode) {
      const doomed = [...open].filter((c) => c.mode === mode);
      for (const connection of doomed) connection.end(CLOSE_GOING_AWAY);
      return doomed.length;
    },
    connections: () => ({ control: count("control"), view: count("view") }),
  };
}

function handleUpgrade(req: IncomingMessage, socket: Duplex, options: BridgeOptions, open: Set<Connection>, changed: () => void): void {
  const refuse = (status: string) => {
    socket.end(`HTTP/1.1 ${status}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
  };
  socket.on("error", () => {});
  const key = req.headers["sec-websocket-key"];
  if (req.headers.upgrade?.toLowerCase() !== "websocket" || typeof key !== "string") {
    refuse("400 Bad Request");
    return;
  }
  const token = new URL(req.url ?? "/", "http://127.0.0.1").searchParams.get("token");
  const mode = token === null ? null : options.authorize(token);
  if (mode === null) {
    refuse("403 Forbidden");
    return;
  }
  const same = [...open].filter((c) => c.mode === mode);
  if (mode === "view" && same.length >= (options.maxView ?? 2)) {
    refuse("503 Service Unavailable");
    return;
  }
  // A new control connection replaces the oldest ones: the person who reloads the page must not be locked out by the dead tab.
  if (mode === "control") for (const old of same.slice(0, Math.max(0, same.length - (options.maxControl ?? 1) + 1))) old.end(CLOSE_GOING_AWAY);

  const target = connect({ host: "127.0.0.1", port: options.targetPort });
  const connection: Connection = { mode, end: (code) => finish(code) };
  open.add(connection); // counted from now on, so two quick upgrades cannot both pass the cap
  let finished = false;
  let cleanup = () => {};
  function finish(code?: number): void {
    if (finished) return;
    finished = true;
    cleanup();
    open.delete(connection);
    target.destroy();
    if (code === undefined || socket.destroyed) socket.destroy();
    else {
      socket.end(encodeFrame(0x8, Buffer.from([code >> 8, code & 0xff])));
      setTimeout(() => socket.destroy(), 2000).unref();
    }
    changed();
  }
  changed();
  target.once("error", () => {
    if (!socket.destroyed && !socket.writableEnded && !finished) refuse("502 Bad Gateway");
    finish();
  });
  socket.once("close", () => finish());
  target.once("connect", () => {
    target.removeAllListeners("error");
    target.on("error", () => finish());
    const accept = createHash("sha1")
      .update(key + GUID)
      .digest("base64");
    const wantsBinary = String(req.headers["sec-websocket-protocol"] ?? "")
      .split(",")
      .some((p) => p.trim() === "binary");
    socket.write(
      `HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n${wantsBinary ? "Sec-WebSocket-Protocol: binary\r\n" : ""}\r\n`,
    );
    cleanup = pipe(socket, target, mode, options, finish);
  });
}

/** Connects the two sides; returns the function that stops the timers. */
function pipe(ws: Duplex, tcp: Socket, mode: StreamMode, options: BridgeOptions, finish: (code?: number) => void): () => void {
  const filter = mode === "view" && options.filterView !== false ? new RfbViewFilter() : null;
  let lastHeard = Date.now();
  let lastPing = lastHeard;
  let stalledSince: number | null = null;

  const parser = new FrameParser({
    binary: (payload) => {
      let bytes = payload;
      if (filter) {
        const result = filter.push(payload);
        if (result.violation !== undefined) {
          options.onViolation?.(result.violation);
          if (result.forward.length > 0) tcp.write(result.forward);
          finish(CLOSE_POLICY);
          return;
        }
        bytes = result.forward;
      }
      if (bytes.length > 0 && !tcp.write(bytes)) {
        ws.pause(); // the VNC server is slower than the client: stop reading until it has caught up
        tcp.once("drain", () => ws.resume());
      }
    },
    ping: (payload) => ws.write(encodeFrame(0xa, payload)),
    close: () => {
      ws.write(encodeFrame(0x8, Buffer.alloc(0)));
      finish();
    },
    protocolError: () => finish(CLOSE_PROTOCOL),
  });
  ws.on("data", (chunk: Buffer) => {
    lastHeard = Date.now();
    parser.push(chunk);
  });
  tcp.on("data", (chunk: Buffer) => {
    let full = false;
    for (let offset = 0; offset < chunk.length; offset += 65536) {
      if (!ws.write(encodeFrame(0x2, chunk.subarray(offset, offset + 65536)))) full = true;
    }
    if (full) {
      tcp.pause(); // the client is slower than the desktop: stop reading until it has caught up
      ws.once("drain", () => tcp.resume());
    }
  });
  ws.on("error", () => finish());
  tcp.on("close", () => finish());

  const idleMs = options.idleMs ?? 60_000;
  const pingMs = options.pingMs ?? 20_000;
  const stalledBytes = options.stalledBytes ?? 8 * 1024 * 1024;
  const stalledMs = options.stalledMs ?? 10_000;
  const timer = setInterval(() => {
    const now = Date.now();
    if (now - lastHeard > idleMs) return finish();
    if (now - lastPing >= pingMs) {
      lastPing = now;
      ws.write(encodeFrame(0x9, Buffer.alloc(0)));
    }
    if (ws.writableLength > stalledBytes) {
      stalledSince ??= now;
      if (now - stalledSince >= stalledMs) finish();
    } else stalledSince = null;
  }, options.tickMs ?? 1000);
  timer.unref();
  return () => clearInterval(timer);
}

export function tokensEqual(a: string, b: string): boolean {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  return left.length === right.length && timingSafeEqual(left, right);
}
