import { rmSync } from "node:fs";
import { createServer, type Server, type Socket } from "node:net";
import { dispatch, encodeLine, LineReader, errorResponse, parseRequest, requestIdOf, type WorkspaceHost, type WorkspaceRequest } from "@standin/contracts";

export interface TestSocketServer {
  /** Closes every open connection (a daemon restart as the client sees it). */
  dropConnections(): void;
  /** Stops listening and drops connections. */
  stop(): Promise<void>;
  /** Starts listening again on the same path. */
  start(): Promise<void>;
  /** Do not answer requests for this method (to test the client's timeout). */
  silence(method: string | undefined): void;
  /** Answer with these raw lines instead of the next real response (to test a bad daemon). */
  replaceNextResponse(raw: string): void;
  readonly requests: WorkspaceRequest[];
}

/** Serves any WorkspaceHost on a Unix socket in the wire format of the contract; for testing the client and anything that uses it. */
export async function serveWorkspaceHost(host: WorkspaceHost, socketPath: string): Promise<TestSocketServer> {
  const sockets = new Set<Socket>();
  const requests: WorkspaceRequest[] = [];
  let silenced: string | undefined;
  let replacement: string | undefined;
  let server: Server | undefined;

  function listen(): Promise<void> {
    rmSync(socketPath, { force: true });
    const next = createServer((socket) => {
      sockets.add(socket);
      socket.setEncoding("utf8");
      socket.on("close", () => sockets.delete(socket));
      socket.on("error", () => {});
      const lines = new LineReader();
      socket.on("data", (chunk: string) => {
        try {
          for (const line of lines.push(chunk)) void answer(socket, line);
        } catch {
          socket.destroy();
        }
      });
    });
    server = next;
    return new Promise((resolve, reject) => {
      next.once("error", reject);
      next.listen(socketPath, () => resolve());
    });
  }

  async function answer(socket: Socket, line: string): Promise<void> {
    let message: string;
    try {
      const request = parseRequest(line);
      requests.push(request);
      if (silenced === request.method) return;
      message = encodeLine(await dispatch(host, request));
    } catch (error) {
      message = encodeLine(errorResponse(requestIdOf(line), error));
    }
    if (replacement !== undefined) {
      message = replacement;
      replacement = undefined;
    }
    if (!socket.destroyed) socket.write(message);
  }

  await listen();
  const closeAll = () => {
    for (const socket of sockets) socket.destroy();
  };
  return {
    requests,
    dropConnections: closeAll,
    silence: (method) => {
      silenced = method;
    },
    replaceNextResponse: (raw) => {
      replacement = raw;
    },
    async stop() {
      closeAll();
      const closing = server;
      server = undefined;
      if (closing) await new Promise<void>((resolve) => closing.close(() => resolve()));
      rmSync(socketPath, { force: true });
    },
    start: listen,
  };
}
