import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import type { SignalSink } from "@standin/contracts";
import type { MailWatchOptions, Provider } from "./types.ts";

/**
 * A watch position kept in a file, so a restart continues where the last run stopped (mail that came while the box was down still
 * wakes the bot). No file: the watch starts from now, as before.
 */
export function cursorIn(file: string | undefined): MailWatchOptions {
  if (!file) return {};
  let after: string | undefined;
  try {
    after = (JSON.parse(readFileSync(file, "utf8")) as { after?: unknown }).after as string | undefined;
  } catch {}
  return {
    ...(typeof after === "string" ? { after } : {}),
    onCursor(cursor) {
      if (cursor === after) return;
      after = cursor;
      mkdirSync(dirname(file), { recursive: true });
      writeFileSync(`${file}.tmp`, `${JSON.stringify({ after: cursor })}\n`);
      renameSync(`${file}.tmp`, file);
    },
  };
}

export interface EventSource {
  name: string;
  start(): void;
  stop(): void;
}

/** Short and without control characters: the sender and the subject are written by someone else. */
function clean(value: string, max: number): string {
  let out = "";
  for (const char of value) out += char.charCodeAt(0) < 32 || char.charCodeAt(0) === 127 ? " " : char;
  return out.replace(/ +/g, " ").trim().slice(0, max);
}

export interface WatchOptions {
  provider: Provider;
  /** The plugin's name: signals come from the source `plugin:<name>`, the only source a plugin may use. */
  plugin: string;
  sink: SignalSink;
  /** Where signals go. `self` is the session that owns the plugin instance. */
  target?: string;
  onError?: (error: unknown) => void;
  /** Where the mail watch keeps its position (the plugin's data directory). Without it, mail during a restart is not reported. */
  cursorFile?: string;
}

/**
 * Turns "something arrived" into signals. The text is a one-line notice (id, sender, subject) and never the body: the
 * body is read with a tool, between markers that say it is from outside. The router then labels the signal untrusted,
 * quotes it, and delivers it as a steer to a running agent or as the start of a run. Signals are sent one after the other
 * in arrival order, and the id is stable, so a provider that reports the same mail twice causes one delivery.
 */
export function createWatchSources(options: WatchOptions): EventSource[] {
  const sources: EventSource[] = [];
  const target = options.target ?? "self";
  let queue: Promise<void> = Promise.resolve();
  const send = (id: string, notice: string) => {
    queue = queue.then(() =>
      Promise.resolve(options.sink.emit(target, { id, source: `plugin:${options.plugin}`, text: notice })).catch((error) => options.onError?.(error)),
    );
  };

  const reader = options.provider.mail?.reader;
  if (reader) {
    let stop: (() => void) | undefined;
    sources.push({
      name: `${options.plugin}-mail`,
      start() {
        stop ??= reader.watch(
          (mail) => send(`mail-${mail.id}`, `New mail ${mail.id} from ${clean(mail.from, 120)}: ${clean(mail.subject, 200)}`),
          cursorIn(options.cursorFile),
        );
      },
      stop() {
        stop?.();
        stop = undefined;
      },
    });
  }
  const calendar = options.provider.calendar;
  if (calendar) {
    let stop: (() => void) | undefined;
    sources.push({
      name: `${options.plugin}-calendar`,
      start() {
        stop ??= calendar.watch((event) =>
          send(`event-${event.id}`, `New calendar event ${event.id}: ${clean(event.title, 200)} at ${new Date(event.start).toISOString()}`),
        );
      },
      stop() {
        stop?.();
        stop = undefined;
      },
    });
  }
  return sources;
}
