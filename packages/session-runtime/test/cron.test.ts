// Five-field cron for scheduled jobs: parsing, the next time (month ends, Sundays as 0 and 7, the day-of-month OR day-of-week rule,
// a daylight-saving shift), and the five-minute floor in parseWhen.
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { nextCron, parseCron, shortestGap } from "../src/cron.ts";
import { nextRun, parseWhen, repeats } from "../src/scheduler.ts";

let zone: string | undefined;
beforeEach(() => {
  zone = process.env.TZ;
  process.env.TZ = "UTC";
});
afterEach(() => {
  process.env.TZ = zone;
  if (zone === undefined) delete process.env.TZ;
});
const at = (iso: string) => Date.parse(iso);
const next = (cron: string, from: string) => new Date(nextCron(parseCron(cron), at(from))).toISOString();

describe("cron", () => {
  it("weekdays at 09:00; Monday by name; the 1st of each month; every 15 minutes in working hours", () => {
    expect(next("0 9 * * 1-5", "2026-11-20T10:00:00Z")).toBe("2026-11-23T09:00:00.000Z"); // Friday after nine → Monday
    expect(next("0 9 * * mon", "2026-11-17T08:00:00Z")).toBe("2026-11-23T09:00:00.000Z");
    expect(next("0 8 1 * *", "2026-11-17T08:00:00Z")).toBe("2026-12-01T08:00:00.000Z");
    expect(next("*/15 9-17 * * *", "2026-11-17T17:50:00Z")).toBe("2026-11-18T09:00:00.000Z");
    expect(next("30 2 * jan,jul *", "2026-11-17T00:00:00Z")).toBe("2027-01-01T02:30:00.000Z");
  });

  it("month ends and leap days; Sunday is 0 and 7; day of month OR day of week when both are given", () => {
    expect(next("0 0 31 * *", "2026-11-17T00:00:00Z")).toBe("2026-12-31T00:00:00.000Z");
    expect(next("0 0 29 2 *", "2026-11-17T00:00:00Z")).toBe("2028-02-29T00:00:00.000Z");
    expect(next("0 12 * * 7", "2026-11-17T00:00:00Z")).toBe(next("0 12 * * 0", "2026-11-17T00:00:00Z"));
    expect(next("0 12 * * sun", "2026-11-17T00:00:00Z")).toBe("2026-11-22T12:00:00.000Z");
    expect(next("0 12 20 * mon", "2026-11-17T00:00:00Z")).toBe("2026-11-20T12:00:00.000Z"); // the 20th comes before Monday the 23rd
    expect(() => nextCron(parseCron("0 0 31 2 *"), at("2026-11-17T00:00:00Z"))).toThrow(/never comes/);
  });

  it("strictly after now, and in the box's time zone across a daylight-saving change", () => {
    expect(next("0 9 * * *", "2026-11-17T09:00:00Z")).toBe("2026-11-18T09:00:00.000Z");
    process.env.TZ = "America/New_York"; // clocks go back on 2026-11-01
    expect(next("0 9 * * *", "2026-10-31T14:00:00Z")).toBe("2026-11-01T14:00:00.000Z"); // 09:00 EST
    expect(next("0 9 * * *", "2026-10-30T12:00:00Z")).toBe("2026-10-30T13:00:00.000Z"); // 09:00 EDT
  });

  it("refuses what it cannot read, by name", () => {
    expect(() => parseCron("0 9 * *")).toThrow(/five fields/);
    expect(() => parseCron("61 9 * * *")).toThrow(/'61' is not in 0-59/);
    expect(() => parseCron("0 9 * * funday")).toThrow(/funday/);
    expect(() => parseCron("0 9-5 * * *")).toThrow(/backwards/);
    expect(() => parseCron("*/0 * * * *")).toThrow(/bad step/);
  });

  it("parseWhen takes a cron, refuses one that fires more often than every five minutes; such a job repeats", () => {
    const now = at("2026-11-17T08:00:00Z");
    const job = { id: "j", when: "0 9 * * 1-5", prompt: "p", ...parseWhen("0 9 * * 1-5", now) };
    expect(job).toMatchObject({ cron: "0 9 * * 1-5", next: at("2026-11-17T09:00:00Z") });
    expect(repeats(job)).toBe(true);
    expect(nextRun(job, job.next)).toBe(at("2026-11-18T09:00:00Z"));
    expect(() => parseWhen("* * * * *", now)).toThrow(/every 5 minutes/);
    expect(() => parseWhen("0,1 9 * * *", now)).toThrow(/every 5 minutes/);
    expect(shortestGap(parseCron("*/5 * * * *"), now)).toBe(5 * 60_000);
    expect(parseWhen("daily 07:30", now).daily).toBe("07:30"); // the old forms still work
    expect(() => parseWhen("whenever", now)).toThrow(/five-field cron/);
  });
});
