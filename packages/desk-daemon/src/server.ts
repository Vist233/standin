import { chmodSync, existsSync, rmSync } from "node:fs";
import { connect, createServer, type Socket } from "node:net";
import {
  dispatch,
  encodeLine,
  errorResponse,
  LineReader,
  OgbError,
  parseRequest,
  requestIdOf,
  type WorkspaceHost,
  type WorkspaceResponse,
} from "@standin/contracts";

export async function respond(host: WorkspaceHost, line: string): Promise<WorkspaceResponse> {
  try {
    return await dispatch(host, parseRequest(line));
  } catch (error) {
    return errorResponse(requestIdOf(line), error); // the line did not parse; the id is recovered when there is one
  }
}

export interface ServeOptions {
  readonly socketPath: string;
}

/** Serves the protocol on a Unix socket (mode 0600). A stale socket file from a dead daemon is replaced; a live one is a `conflict`. */
export async function serveWorkspaceHost(host: WorkspaceHost, options: ServeOptions): Promise<{ close(): Promise<void> }> {
  if (existsSync(options.socketPath)) {
    if (await isListening(options.socketPath)) throw new OgbError("conflict", "another daemon is serving this socket");
    rmSync(options.socketPath, { force: true });
  }
  const open = new Set<Socket>();
  const server = createServer((socket) => {
    open.add(socket);
    socket.once("close", () => open.delete(socket));
    serveConnection(host, socket);
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(options.socketPath, () => resolve());
  });
  chmodSync(options.socketPath, 0o600);
  return {
    // Stops listening and ends every connection, so a client of a stopped daemon never keeps talking to it.
    close: () =>
      new Promise((resolve) => {
        for (const socket of open) socket.destroy();
        server.close(() => resolve());
      }),
  };
}

function serveConnection(host: WorkspaceHost, socket: Socket): void {
  const lines = new LineReader();
  socket.setEncoding("utf8");
  socket.on("error", () => socket.destroy());
  socket.on("data", (chunk: string) => {
    try {
      for (const line of lines.push(chunk)) {
        if (line.trim() !== "") void respond(host, line).then((response) => socket.writable && socket.write(encodeLine(response)));
      }
    } catch (error) {
      socket.end(encodeLine(errorResponse("", error)));
    }
  });
}

function isListening(path: string): Promise<boolean> {
  return new Promise((resolve) => {
    const probe = connect(path);
    probe.once("connect", () => {
      probe.destroy();
      resolve(true);
    });
    probe.once("error", () => resolve(false));
  });
}
