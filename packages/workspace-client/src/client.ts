import { connect, type Socket } from "node:net";
import {
  type DestroyResult,
  checkFileBytes,
  encodeLine,
  type FileEntry,
  fromBase64,
  LineReader,
  OgbError,
  parseResponse,
  toBase64,
  type InsertTextResult,
  type TakeoverCloseResult,
  type TakeoverTicket,
  unwrapResponse,
  WORKSPACE_PROTOCOL_VERSION,
  type WorkspaceHealth,
  type WorkspaceHost,
  type WorkspaceInfo,
  type WorkspaceMethod,
  type WorkspaceSpec,
} from "@standin/contracts";
import type { JsonValue } from "@standin/contracts";

export interface WorkspaceClientOptions {
  socketPath: string;
  /** How long one request may take (default 30000: `ensure` may start a browser). */
  requestTimeoutMs?: number;
  /** How many times a call is repeated after the connection failed or the daemon did not answer (default 5). Safe because every call is idempotent. */
  retries?: number;
  /** First pause before a repeat; doubles each time (default 200 ms). */
  backoffMs?: number;
  sleep?: (ms: number) => Promise<void>;
}

/** The connection broke or the daemon did not answer. Distinguished from an error the daemon sent, which is final. */
class TransportError extends Error {}

interface Pending {
  resolve(value: JsonValue): void;
  reject(error: unknown): void;
  timer: ReturnType<typeof setTimeout>;
}

/**
 * The runtime's view of the desk-daemon. One socket, opened on first use and opened again after it breaks (the daemon
 * restarts independently of the runtime; its desktops survive). A call that failed for transport reasons is repeated
 * with a growing pause, because every call of the protocol is idempotent; an answer from the daemon, success or
 * error, is never repeated.
 */
export function createWorkspaceClient(options: WorkspaceClientOptions): WorkspaceHost & { close(): void } {
  const timeoutMs = options.requestTimeoutMs ?? 30_000;
  const retries = options.retries ?? 5;
  const backoff = options.backoffMs ?? 200;
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const pending = new Map<string, Pending>();
  let socket: Promise<Socket> | undefined;
  let counter = 0;
  let closed = false;

  function failAll(reason: string): void {
    for (const [id, entry] of pending) {
      clearTimeout(entry.timer);
      entry.reject(new TransportError(reason));
      pending.delete(id);
    }
  }

  function open(): Promise<Socket> {
    if (socket) return socket;
    const attempt = new Promise<Socket>((resolve, reject) => {
      const connection = connect(options.socketPath);
      const reader = new LineReader();
      connection.setEncoding("utf8");
      connection.once("connect", () => resolve(connection));
      connection.on("data", (chunk: string) => {
        try {
          for (const line of reader.push(chunk)) deliver(line, connection);
        } catch {
          connection.destroy(new Error("line too long"));
        }
      });
      const lost = (error?: Error) => {
        if (socket === attempt) socket = undefined;
        failAll(error ? `connection to the desk-daemon failed (${error.message})` : "connection to the desk-daemon closed");
        reject(
          new TransportError(
            error ? `cannot reach the desk-daemon (${(error as NodeJS.ErrnoException).code ?? error.message})` : "the desk-daemon closed the connection",
          ),
        );
      };
      connection.once("error", lost);
      connection.once("close", () => lost());
    });
    socket = attempt;
    attempt.catch(() => {
      if (socket === attempt) socket = undefined;
    });
    return attempt;
  }

  function deliver(line: string, connection: Socket): void {
    let response: ReturnType<typeof parseResponse>;
    try {
      response = parseResponse(line);
    } catch {
      connection.destroy(new Error("unreadable response")); // a daemon that talks nonsense is not trusted further
      return;
    }
    const entry = pending.get(response.id);
    if (!entry) return; // a late answer to a request that already timed out
    pending.delete(response.id);
    clearTimeout(entry.timer);
    try {
      entry.resolve(unwrapResponse(response));
    } catch (error) {
      entry.reject(error);
    }
  }

  async function once(method: WorkspaceMethod, params: JsonValue): Promise<JsonValue> {
    const connection = await open();
    const id = `c${++counter}`;
    return new Promise<JsonValue>((resolve, reject) => {
      const timer = setTimeout(() => {
        pending.delete(id);
        reject(new TransportError(`the desk-daemon did not answer '${method}' within ${timeoutMs} ms`));
      }, timeoutMs);
      pending.set(id, { resolve, reject, timer });
      connection.write(encodeLine({ v: WORKSPACE_PROTOCOL_VERSION, id, method, params }), (error) => {
        if (error && pending.delete(id)) {
          clearTimeout(timer);
          reject(new TransportError(`cannot write to the desk-daemon (${error.message})`));
        }
      });
    });
  }

  async function call(method: WorkspaceMethod, params: JsonValue, repeatable = true): Promise<JsonValue> {
    for (let attempt = 0; ; attempt += 1) {
      if (closed) throw new OgbError("unavailable", "the workspace client is closed");
      try {
        return await once(method, params);
      } catch (error) {
        if (!(error instanceof TransportError)) throw error; // the daemon answered: that answer is final
        // A repeated insertText would type the text twice; the caller learns that the outcome is unknown.
        if (!repeatable) throw new OgbError("unavailable", `${error.message}; not repeated because the outcome is unknown`);
        if (attempt >= retries) throw new OgbError("unavailable", `${error.message}; gave up after ${attempt + 1} tries`);
        await sleep(backoff * 2 ** attempt);
      }
    }
  }

  const ofId = (workspaceId: string): JsonValue => ({ workspaceId });
  return {
    ensure: async (spec: WorkspaceSpec) => (await call("ensure", spec as unknown as JsonValue)) as unknown as WorkspaceInfo,
    destroy: async (workspaceId: string) => (await call("destroy", ofId(workspaceId))) as unknown as DestroyResult,
    health: async (workspaceId: string) => (await call("health", ofId(workspaceId))) as unknown as WorkspaceHealth,
    takeover: {
      open: async (workspaceId: string) => (await call("takeover.open", ofId(workspaceId))) as unknown as TakeoverTicket,
      close: async (workspaceId: string) => (await call("takeover.close", ofId(workspaceId))) as unknown as TakeoverCloseResult,
    },
    view: {
      open: async (workspaceId: string) => (await call("view.open", ofId(workspaceId))) as unknown as TakeoverTicket,
    },
    files: {
      // A repeated put would store the file twice (under a second name); the caller learns that the outcome is unknown.
      put: async (workspaceId: string, name: string, bytes: Uint8Array) =>
        (await call("files.put", { workspaceId, name, data: toBase64(checkFileBytes(bytes)) }, false)) as unknown as FileEntry,
      list: async (workspaceId: string) => (await call("files.list", ofId(workspaceId))) as unknown as FileEntry[],
      get: async (workspaceId: string, name: string) => fromBase64(((await call("files.get", { workspaceId, name })) as { data?: unknown }).data),
    },
    input: {
      insertText: async (workspaceId: string, text: string) => (await call("input.insertText", { workspaceId, text }, false)) as unknown as InsertTextResult,
    },
    close() {
      closed = true;
      failAll("the workspace client was closed");
      void socket?.then((s) => s.destroy()).catch(() => {});
      socket = undefined;
    },
  };
}
