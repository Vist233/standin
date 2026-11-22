import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { Socket } from "node:net";
import { MAX_FILE_BYTES, OgbError } from "@standin/contracts";
import { Api } from "./api.ts";
import { Guard, isLoopbackAddress } from "./guard.ts";
import { describeFailure, readRawBody, HttpFailure, sendJson } from "./http.ts";
import { refuseUpgrade, relayUpgrade } from "./relay.ts";
import { serveStatic } from "./static.ts";
import { TicketBook } from "./tickets.ts";
import type { Gateway, GatewayLimits, GatewayOptions } from "./types.ts";

const DEFAULT_LIMITS: GatewayLimits = {
  maxBodyBytes: 64 * 1024,
  maxFileBytes: MAX_FILE_BYTES,
  maxFiles: 20,
  maxStreams: 200,
  slowClientMs: 30_000,
  heartbeatMs: 15_000,
  ticketMs: 30_000,
  maxRelays: 32,
};

const WS_PATH = /^\/ws\/([A-Za-z0-9_-]{1,64})\/(view|takeover)$/;
/** `/hooks/<bot>/<hook>`: a webhook of one bot (docs/26 3.4). */
const HOOK_PATH = /^\/hooks\/([A-Za-z0-9_-]{1,64})\/([a-z][a-z0-9-]{0,31})$/;
const MAX_HOOK_BODY = 64 * 1024;

export function createGateway(options: GatewayOptions): Gateway {
  const limits: GatewayLimits = { ...DEFAULT_LIMITS, ...options.limits };
  const now = options.now ?? Date.now;
  const log = (entry: Record<string, unknown>) => options.log?.({ module: "gateway", ...entry });
  const guard = new Guard({ extraHosts: options.extraHosts ?? [], token: options.token });
  const tickets = new TicketBook(limits.ticketMs, now);
  const api = new Api({ options, limits, tickets, now, log, streams: { count: 0 } });
  const relays = new Set<Socket>();
  let server: Server | undefined;

  async function onRequest(req: IncomingMessage, res: ServerResponse): Promise<void> {
    try {
      const url = new URL(req.url ?? "/", "http://placeholder");
      const method = req.method ?? "GET";
      const isRead = method === "GET" || method === "HEAD";
      guard.checkHostAndOrigin(req.headers, { originRequired: false });

      const hook = HOOK_PATH.exec(url.pathname);
      if (hook) {
        // A webhook (docs/26 3.4): outside the API's own token; the hook's token opens it. Every refusal looks the same.
        if (method !== "POST") throw new HttpFailure(405, "invalid_input", "webhooks are POST");
        const token = url.searchParams.get("token") ?? /^Bearer (.{1,200})$/.exec(req.headers.authorization ?? "")?.[1] ?? "";
        const body = (await readRawBody(req, MAX_HOOK_BODY)).toString("utf8");
        const header = (name: string) => {
          const value = req.headers[name];
          return typeof value === "string" ? value : undefined;
        };
        const delivery = header("x-github-delivery") ?? header("idempotency-key") ?? header("x-delivery-id");
        const accepted = await options.runtime.receiveHook(hook[1] as string, hook[2] as string, token, body, delivery);
        if (!accepted) throw new HttpFailure(404, "not_found", "no such hook");
        sendJson(res, 202, { accepted: true });
        return;
      }

      if (url.pathname.startsWith("/api/")) {
        if (url.pathname !== "/api/health") guard.checkBearer(req.headers);
        const outcome = await api.handle(req, res, url.pathname, url.searchParams);
        if (outcome === "no-route") throw new HttpFailure(404, "not_found", "no such endpoint");
        if (outcome === "wrong-method") {
          res.setHeader("allow", "GET, POST, DELETE");
          throw new HttpFailure(405, "invalid_input", `${method} is not allowed here`);
        }
        return;
      }
      if (!isRead) throw new HttpFailure(405, "invalid_input", `${method} is not allowed here`);
      if (options.staticDir && (await serveStatic(options.staticDir, req, res, url.pathname))) return;
      throw new HttpFailure(404, "not_found", "not found");
    } catch (error) {
      const failure = describeFailure(error);
      if (failure.status >= 500) log({ level: "error", message: "request failed", error: String(error), path: req.url?.split("?")[0] });
      if (res.headersSent) {
        res.destroy();
        return;
      }
      if (error instanceof HttpFailure && error.status === 413) res.setHeader("connection", "close");
      sendJson(res, failure.status, failure.body);
    }
  }

  async function onUpgrade(req: IncomingMessage, socket: Socket, head: Buffer): Promise<void> {
    try {
      const url = new URL(req.url ?? "/", "http://placeholder");
      guard.checkHostAndOrigin(req.headers, { originRequired: true });
      const match = WS_PATH.exec(url.pathname);
      if (!match) throw new HttpFailure(404, "not_found", "no such socket");
      const sessionId = match[1] as string;
      const kind = match[2] as "view" | "takeover";
      const ticket = tickets.redeem(url.searchParams.get("ticket") ?? "", { sessionId, kind });
      if (!ticket) throw new HttpFailure(401, "denied", "the ticket is missing, used, expired or for another view");
      if (relays.size >= limits.maxRelays) throw new HttpFailure(503, "unavailable", "too many open live views");

      // Frames flow as the desk-daemon's stream; for `view` the daemon's bridge itself drops everything but what is needed to see.
      const target = { port: ticket.upstream.port, path: `/?token=${encodeURIComponent(ticket.upstream.token)}` };
      relays.add(socket);
      relayUpgrade(req, socket, head, target, {
        onClose: () => relays.delete(socket),
        // A viewer reached the desktop: that is what makes "the person used it" true in the hand-back text.
        onConnected: () => {
          if (kind === "takeover")
            options.runtime
              .reportTakeoverViewer(sessionId)
              .catch((error) => log({ level: "warn", message: "viewer report failed", session: sessionId, error: String(error) }));
        },
      });
    } catch (error) {
      const failure = describeFailure(error);
      if (failure.status >= 500) log({ level: "error", message: "upgrade failed", error: String(error) });
      refuseUpgrade(socket, failure.status, failure.body.error.message);
    }
  }

  return {
    async listen({ port = 0, host = "127.0.0.1" } = {}) {
      if (server) throw new OgbError("conflict", "the gateway is already listening");
      if (!isLoopbackAddress(host) && !options.token && !options.openListen)
        throw new OgbError("invalid_input", "listening on a non-loopback address needs a bearer token: anyone who can reach the port could drive the agents");
      const created = createServer((req, res) => void onRequest(req, res));
      created.on("upgrade", (req, socket, head) => void onUpgrade(req, socket as Socket, head));
      created.requestTimeout = 60_000;
      created.headersTimeout = 15_000;
      created.keepAliveTimeout = 5_000;
      await new Promise<void>((resolve, reject) => {
        created.once("error", reject);
        created.listen(port, host, () => resolve());
      });
      server = created;
      const address = created.address();
      if (address === null || typeof address === "string") throw new OgbError("internal", "no address after listen");
      if (!isLoopbackAddress(host) && !options.token)
        log({
          level: "warn",
          message: "listening on a non-loopback address without a token (openListen); the port must be published to the host loopback only",
        });
      log({ level: "info", message: "listening", host, port: address.port });
      return { host, port: address.port };
    },

    async close() {
      const current = server;
      server = undefined;
      if (!current) return;
      for (const socket of relays) socket.destroy();
      current.closeAllConnections(); // event streams never end by themselves
      await new Promise<void>((resolve) => current.close(() => resolve()));
    },
  };
}
