import { OgbError } from "@standin/contracts";

/**
 * Five-field cron (minute hour day-of-month month day-of-week) in the process's time zone (the box's `TZ`). Fields take `*`, numbers,
 * lists `1,15`, ranges `1-5`, steps `*\/15` or `9-17/2`, and names for months (`jan`) and week days (`mon`; 0 and 7 are Sunday).
 * As in classic cron, when both the day of month and the day of week are restricted, a day matching either one counts.
 */
export interface Cron {
  minutes: Set<number>;
  hours: Set<number>;
  days: Set<number>;
  months: Set<number>;
  weekdays: Set<number>;
  anyDay: boolean;
  anyWeekday: boolean;
}

const MONTHS = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];
const WEEKDAYS = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"];

function field(text: string, min: number, max: number, names: string[] = [], nameBase = 0): Set<number> {
  const values = new Set<number>();
  const value = (part: string): number => {
    const named = names.indexOf(part.toLowerCase());
    const number = named >= 0 ? named + nameBase : /^\d+$/.test(part) ? Number(part) : Number.NaN;
    if (!Number.isInteger(number) || number < min || number > max) throw new OgbError("invalid_input", `'${part}' is not in ${min}-${max}`);
    return number;
  };
  for (const item of text.split(",")) {
    const [range = "", stepText] = item.split("/");
    const step = stepText === undefined ? 1 : Number(stepText);
    if (!Number.isInteger(step) || step < 1) throw new OgbError("invalid_input", `'${item}' has a bad step`);
    let from = min;
    let to = max;
    if (range !== "*") {
      const [a = "", b] = range.split("-");
      from = value(a);
      to = b === undefined ? (stepText === undefined ? from : max) : value(b);
      if (to < from) throw new OgbError("invalid_input", `'${range}' runs backwards`);
    }
    for (let n = from; n <= to; n += step) values.add(n);
  }
  return values;
}

/** Reads a five-field cron; throws `invalid_input` naming what is wrong. */
export function parseCron(text: string): Cron {
  const parts = text.trim().split(/\s+/);
  if (parts.length !== 5) throw new OgbError("invalid_input", "a cron has five fields: minute hour day-of-month month day-of-week");
  const [m = "", h = "", dom = "", mon = "", dow = ""] = parts;
  const weekdays = field(dow, 0, 7, WEEKDAYS);
  if (weekdays.delete(7)) weekdays.add(0);
  return {
    minutes: field(m, 0, 59),
    hours: field(h, 0, 23),
    days: field(dom, 1, 31),
    months: field(mon, 1, 12, MONTHS, 1),
    weekdays,
    anyDay: dom === "*",
    anyWeekday: dow === "*",
  };
}

function dayMatches(cron: Cron, at: Date): boolean {
  const byDay = cron.days.has(at.getDate());
  const byWeekday = cron.weekdays.has(at.getDay());
  if (cron.anyDay && cron.anyWeekday) return true;
  if (cron.anyDay) return byWeekday;
  if (cron.anyWeekday) return byDay;
  return byDay || byWeekday;
}

/** The first matching minute strictly after `now` (local time). Throws when nothing matches within five years (`30 2 31 2 *`). */
export function nextCron(cron: Cron, now: number): number {
  const at = new Date(now);
  at.setSeconds(0, 0);
  at.setMinutes(at.getMinutes() + 1);
  const limit = now + 5 * 366 * 86_400_000;
  while (at.getTime() <= limit) {
    if (!cron.months.has(at.getMonth() + 1)) {
      at.setMonth(at.getMonth() + 1, 1);
      at.setHours(0, 0, 0, 0);
    } else if (!dayMatches(cron, at)) {
      at.setDate(at.getDate() + 1);
      at.setHours(0, 0, 0, 0);
    } else if (!cron.hours.has(at.getHours())) {
      at.setHours(at.getHours() + 1, 0, 0, 0);
    } else if (!cron.minutes.has(at.getMinutes())) {
      at.setMinutes(at.getMinutes() + 1, 0, 0);
    } else {
      return at.getTime();
    }
  }
  throw new OgbError("invalid_input", "that cron never comes (no such date in five years)");
}

/** The shortest gap between the next runs, to refuse a cron that would wake a bot too often. */
export function shortestGap(cron: Cron, now: number, runs = 30): number {
  let previous = nextCron(cron, now);
  let gap = Number.POSITIVE_INFINITY;
  for (let i = 1; i < runs; i += 1) {
    const next = nextCron(cron, previous);
    gap = Math.min(gap, next - previous);
    previous = next;
  }
  return gap;
}
