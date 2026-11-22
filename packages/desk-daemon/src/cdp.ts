import { request } from "node:http";
import { OgbError } from "@standin/contracts";

// The two DevTools calls the daemon makes into a workspace's browser: an HTTP GET of its JSON endpoints and one WebSocket
// session. Errors say what failed, never what was sent (a typed password, a cookie value).

const CALL_TIMEOUT_MS = 5000;

export function getJson(port: number, path: string): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const fail = () => reject(new OgbError("unavailable", "the workspace's browser did not answer on its DevTools port"));
    const req = request({ host: "127.0.0.1", port, path, timeout: CALL_TIMEOUT_MS }, (res) => {
      let data = "";
      res.setEncoding("utf8");
      res.on("data", (chunk: string) => {
        data += chunk;
      });
      res.on("end", () => {
        try {
          resolve(JSON.parse(data));
        } catch {
          fail();
        }
      });
    });
    req.on("timeout", () => {
      req.destroy();
      fail();
    });
    req.on("error", fail);
    req.end();
  });
}

export interface Session {
  send(method: string, params: Record<string, unknown>): Promise<unknown>;
  close(): void;
}

/** One DevTools WebSocket; errors say what failed, never what was sent. */
export function openSession(url: string): Promise<Session> {
  return new Promise((resolve, reject) => {
    const unavailable = (what: string) => new OgbError("unavailable", `the browser ${what}`);
    const socket = new WebSocket(url);
    let nextId = 0;
    const waiting = new Map<number, { resolve(value: unknown): void; reject(error: unknown): void }>();
    const opening = setTimeout(() => {
      socket.close();
      reject(unavailable("did not accept a DevTools connection"));
    }, CALL_TIMEOUT_MS);
    const failAll = (what: string) => {
      for (const entry of waiting.values()) entry.reject(unavailable(what));
      waiting.clear();
    };
    socket.onerror = () => {
      clearTimeout(opening);
      reject(unavailable("did not accept a DevTools connection"));
      failAll("lost the DevTools connection");
    };
    socket.onclose = () => failAll("closed the DevTools connection");
    socket.onmessage = (event) => {
      try {
        const message = JSON.parse(String(event.data)) as { id?: number; result?: unknown; error?: unknown };
        const entry = message.id === undefined ? undefined : waiting.get(message.id);
        if (!entry || message.id === undefined) return;
        waiting.delete(message.id);
        if (message.error) entry.reject(unavailable("refused the request"));
        else entry.resolve(message.result);
      } catch {
        // not a response to us
      }
    };
    socket.onopen = () => {
      clearTimeout(opening);
      resolve({
        send: (method, params) =>
          new Promise((done, failed) => {
            nextId += 1;
            const id = nextId;
            const timer = setTimeout(() => {
              waiting.delete(id);
              failed(unavailable("did not answer in time"));
            }, CALL_TIMEOUT_MS);
            waiting.set(id, {
              resolve: (value) => {
                clearTimeout(timer);
                done(value);
              },
              reject: (error) => {
                clearTimeout(timer);
                failed(error);
              },
            });
            socket.send(JSON.stringify({ id, method, params }));
          }),
        close: () => socket.close(),
      });
    };
  });
}
