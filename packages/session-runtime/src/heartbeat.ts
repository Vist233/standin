import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { OgbError } from "@vesper/contracts";

/**
 * A bot's heartbeat (docs/26 3.3): a repeating wake-up that looks at a checklist and stays quiet when nothing needs the person.
 * What costs money is the model call, so a beat is skipped, without one, in quiet hours, when the checklist is empty or missing,
 * and while the bot waits for the person (a question or an approval) or was stopped.
 */
export const CHECKLIST = "HEARTBEAT.md";
const MAX_CHECKLIST = 8000;

/** `23:00-08:00` (may cross midnight) → minutes of the day; undefined when not given. */
export function parseQuiet(text: string | undefined): { from: number; to: number } | undefined {
  if (text === undefined || text.trim() === "") return undefined;
  const match = /^([01]?\d|2[0-3]):([0-5]\d)-([01]?\d|2[0-3]):([0-5]\d)$/.exec(text.trim());
  if (!match) throw new OgbError("invalid_input", "quiet hours are 'HH:MM-HH:MM', for example 23:00-08:00");
  const [, h1, m1, h2, m2] = match.map(Number) as [number, number, number, number, number];
  return { from: h1 * 60 + m1, to: h2 * 60 + m2 };
}

/** Whether `now` (local time, the box's `TZ`) falls in the quiet hours. */
export function inQuiet(quiet: string | undefined, now: number): boolean {
  const range = parseQuiet(quiet);
  if (!range) return false;
  const at = new Date(now);
  const minute = at.getHours() * 60 + at.getMinutes();
  return range.from <= range.to ? minute >= range.from && minute < range.to : minute >= range.from || minute < range.to;
}

/** The checklist: the bot's own `HEARTBEAT.md`, else the shared one every bot sees (`shared/HEARTBEAT.md`). Empty when neither has text. */
export async function readChecklist(filesDir: string): Promise<string> {
  for (const path of [join(filesDir, CHECKLIST), join(filesDir, "shared", CHECKLIST)]) {
    const text = await readFile(path, "utf8").catch(() => "");
    if (text.trim()) return text.trim().slice(0, MAX_CHECKLIST);
  }
  return "";
}

/** What a beat says to the bot, or why it is skipped. */
export function beat(input: {
  every: string;
  quiet?: string | undefined;
  now: number;
  checklist: string;
  status: { pending: number; held: boolean };
}): { prompt: string } | { skip: "quiet" | "empty" | "waiting" | "stopped" } {
  if (inQuiet(input.quiet, input.now)) return { skip: "quiet" };
  if (input.status.held) return { skip: "stopped" };
  if (input.status.pending > 0) return { skip: "waiting" };
  if (input.checklist === "") return { skip: "empty" };
  return {
    prompt:
      `Heartbeat (${input.every}). Go through your checklist and do what is due. Report only what the person should know; ` +
      `if nothing needs them, reply exactly [SILENT].\n\nChecklist (${CHECKLIST}):\n${input.checklist}`,
  };
}
