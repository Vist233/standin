import type { IncomingMessage, ServerResponse } from "node:http";
import type { SessionEvent } from "@standin/contracts";
import { SECURITY_HEADERS } from "./http.ts";

export interface StreamOptions {
  heartbeatMs: number;
  slowClientMs: number;
  log: (entry: Record<string, unknown>) => void;
}

/** One server-sent event. `id` is the journal's sequence number, which is what a reconnecting page sends back as Last-Event-ID. */
export function frameOf(event: SessionEvent): string {
  return `id: ${event.seq}\ndata: ${JSON.stringify(event)}\n\n`;
}

/**
 * Sends `events` (replay, then live) to one client until it leaves. The order of work is the whole design:
 * the source is already a gap-free, repeat-free sequence after `Last-Event-ID`, so this function only has to
 * never drop what it was given. It writes one event at a time and waits for the socket to drain, which gives
 * backpressure all the way back to the journal; a client that does not drain for `slowClientMs` is dropped and
 * simply reconnects from its last id, losing nothing.
 */
export async function pump(source: AsyncIterable<SessionEvent>, req: IncomingMessage, res: ServerResponse, options: StreamOptions): Promise<void> {
  res.writeHead(200, {
    ...SECURITY_HEADERS,
    "content-type": "text/event-stream; charset=utf-8",
    "cache-control": "no-store",
    connection: "keep-alive",
    "x-accel-buffering": "no",
  });
  res.write("retry: 2000\n\n");

  let gone = false;
  let wakeGone: () => void = () => {};
  const goneSignal = new Promise<"gone">((resolve) => {
    wakeGone = () => resolve("gone");
  });
  const leave = () => {
    gone = true;
    wakeGone();
  };
  res.on("close", leave);
  req.on("close", () => {
    if (!res.writable) leave();
  });

  const writeWhole = async (chunk: string): Promise<boolean> => {
    if (res.write(chunk)) return true;
    return new Promise<boolean>((resolve) => {
      const timer = setTimeout(() => finish(false), options.slowClientMs);
      const finish = (ok: boolean) => {
        clearTimeout(timer);
        res.off("drain", onDrain);
        res.off("close", onClose);
        resolve(ok);
      };
      const onDrain = () => finish(true);
      const onClose = () => finish(false);
      res.once("drain", onDrain);
      res.once("close", onClose);
    });
  };

  const heartbeat = setInterval(() => {
    // A comment line; skipped when the socket is already backed up, since real data is waiting on it.
    if (!gone && res.writableLength === 0) res.write(": ping\n\n");
  }, options.heartbeatMs);
  heartbeat.unref();

  const iterator = source[Symbol.asyncIterator]();
  try {
    while (!gone) {
      const pending = iterator.next();
      pending.catch(() => {}); // if we leave first, a late failure of this call is not news
      const step = await Promise.race([pending, goneSignal]);
      if (step === "gone" || step.done) break;
      if (!(await writeWhole(frameOf(step.value)))) {
        options.log({ level: "warn", message: "event stream dropped: client too slow or gone", slowClientMs: options.slowClientMs });
        res.destroy(); // `end` would wait for a socket that nobody drains
        break;
      }
    }
  } catch (error) {
    options.log({ level: "error", message: "event stream failed", error: String(error) });
  } finally {
    clearInterval(heartbeat);
    // Not awaited: an idle follower only notices on its next event, and nobody should wait for that.
    void Promise.resolve(iterator.return?.()).catch(() => {});
    if (!res.writableEnded) res.end();
  }
}
