import { randomBytes } from "node:crypto";
import { type JsonValue, OgbError } from "@vesper/contracts";
import type { SessionStore } from "@vesper/session-store";
import { nextCron, parseCron, shortestGap } from "./cron.ts";
import { parseQuiet } from "./heartbeat.ts";

/** One scheduled wake-up of a bot (docs/18 section 3). Kept in the session record. */
export interface ScheduledJob {
  id: string;
  /** What the person or the agent wrote: `in 30m`, `every 2h`, `daily 07:30`, a five-field cron (`0 9 * * 1-5`), or an ISO time. */
  when: string;
  /** Self-contained: what to do and how to report. */
  prompt: string;
  /** Next time it is due (ms since the epoch). */
  next: number;
  everyMs?: number;
  daily?: string;
  /** A five-field cron in the box's time zone (`cron.ts`). */
  cron?: string;
  /** Set on the bot's one heartbeat (`heartbeat.ts`): its quiet hours, `HH:MM-HH:MM`. */
  heartbeat?: { quiet?: string };
  /** A paused job keeps its place but does not run until resumed. */
  paused?: boolean;
}

export const MAX_JOBS = 20;
const MIN_EVERY_MS = 5 * 60_000;
const UNIT: Record<string, number> = { m: 60_000, h: 3_600_000, d: 86_400_000 };

/** The next local time `HH:MM` after `now` (the process's time zone: the container's `TZ`). */
function nextDaily(hhmm: string, now: number): number {
  const [h, m] = hhmm.split(":").map(Number) as [number, number];
  const at = new Date(now);
  at.setHours(h, m, 0, 0);
  if (at.getTime() <= now) at.setDate(at.getDate() + 1);
  return at.getTime();
}

/** Whether a job comes back after it ran (every, daily, cron) or is used up (in, a time). */
export const repeats = (job: ScheduledJob): boolean => job.everyMs !== undefined || job.daily !== undefined || job.cron !== undefined;

/** The next time of a repeating job after `now`. */
export function nextRun(job: ScheduledJob, now: number): number {
  if (job.everyMs !== undefined) return now + job.everyMs;
  if (job.cron !== undefined) return nextCron(parseCron(job.cron), now);
  return nextDaily(job.daily as string, now);
}

/** Reads `when`; refuses what it cannot read or what would wake the bot more often than every five minutes. */
export function parseWhen(when: string, now: number): Pick<ScheduledJob, "next" | "everyMs" | "daily" | "cron"> {
  const text = when.trim().toLowerCase();
  if (/^\S+ \S+ \S+ \S+ \S+$/.test(text) && !/^(in|every|daily) /.test(text)) {
    const cron = parseCron(text);
    if (shortestGap(cron, now) < MIN_EVERY_MS) throw new OgbError("invalid_input", "a repeating job runs at most every 5 minutes");
    return { next: nextCron(cron, now), cron: text };
  }
  const once = /^in (\d{1,4}) ?([mhd])$/.exec(text);
  if (once) return { next: now + Number(once[1]) * (UNIT[once[2] as string] as number) };
  const every = /^every (\d{1,4}) ?([mhd])$/.exec(text);
  if (every) {
    const everyMs = Number(every[1]) * (UNIT[every[2] as string] as number);
    if (everyMs < MIN_EVERY_MS) throw new OgbError("invalid_input", "a repeating job runs at most every 5 minutes");
    return { next: now + everyMs, everyMs };
  }
  const daily = /^daily ([01]?\d|2[0-3]):([0-5]\d)$/.exec(text);
  if (daily) {
    const hhmm = `${daily[1]?.padStart(2, "0")}:${daily[2]}`;
    return { next: nextDaily(hhmm, now), daily: hhmm };
  }
  const at = Date.parse(when.trim());
  if (/^\d{4}-\d{2}-\d{2}/.test(when.trim()) && Number.isFinite(at)) {
    if (at <= now) throw new OgbError("invalid_input", "that time has passed");
    return { next: at };
  }
  throw new OgbError(
    "invalid_input",
    "when must be 'in 30m', 'every 2h', 'daily 07:30', a five-field cron like '0 9 * * 1-5' (minute hour day month weekday), or an ISO time like 2026-12-01T09:00",
  );
}

const jobsOf = (raw: JsonValue[] | undefined): ScheduledJob[] => (raw ?? []) as unknown as ScheduledJob[];

/**
 * The bots' scheduled wake-ups: jobs in the session records, checked every minute; a due job is handed to `deliver`
 * (the runtime turns it into a trusted signal of the bot's own) and then moved to its next time or removed. Every change
 * to a bot's jobs goes through one queue per bot, so the tool and the clock cannot overwrite each other.
 */
export function createScheduler(options: {
  store: SessionStore;
  deliver: (sessionId: string, job: ScheduledJob, late: boolean) => Promise<void>;
  now: () => number;
  log: (entry: Record<string, unknown>) => void;
  intervalMs?: number;
}) {
  const queues = new Map<string, Promise<unknown>>();
  let timer: ReturnType<typeof setInterval> | undefined;

  function change<T>(sessionId: string, edit: (jobs: ScheduledJob[]) => { jobs: ScheduledJob[]; result: T }): Promise<T> {
    const run = (queues.get(sessionId) ?? Promise.resolve()).then(async () => {
      const record = await options.store.get(sessionId);
      const { jobs, result } = edit(jobsOf(record.schedules));
      await options.store.update(sessionId, { schedules: jobs as unknown as JsonValue[] });
      return result;
    });
    queues.set(
      sessionId,
      run.catch(() => undefined),
    );
    return run;
  }

  async function tick(): Promise<void> {
    const now = options.now();
    const { sessions } = await options.store.list();
    for (const record of sessions) {
      const isDue = (job: ScheduledJob) => job.next <= now && !job.paused;
      if (record.status !== "active" || !jobsOf(record.schedules).some(isDue)) continue;
      const due = await change(record.id, (jobs) => {
        const fired = jobs.filter(isDue);
        const kept = jobs.filter((job) => !isDue(job) || repeats(job)).map((job) => (isDue(job) ? { ...job, next: nextRun(job, now) } : job));
        return { jobs: kept, result: fired };
      });
      for (const job of due) {
        const late = now - job.next > 2 * 60_000; // missed while the box was down: it runs once, and says so
        await options
          .deliver(record.id, job, late)
          .catch((error) => options.log({ level: "error", message: "a scheduled job could not be delivered", session: record.id, error: String(error) }));
      }
    }
  }

  return {
    start() {
      timer ??= setInterval(
        () => void tick().catch((error) => options.log({ level: "error", message: "the scheduler failed", error: String(error) })),
        options.intervalMs ?? 60_000,
      );
      timer.unref?.();
      void tick().catch(() => {}); // jobs missed while the box was down run now
    },
    stop() {
      if (timer) clearInterval(timer);
      timer = undefined;
    },
    tick,
    list: async (sessionId: string) => jobsOf((await options.store.get(sessionId)).schedules),
    add: (sessionId: string, when: string, prompt: string) =>
      change(sessionId, (jobs) => {
        if (jobs.length >= MAX_JOBS) throw new OgbError("invalid_input", `a bot has at most ${MAX_JOBS} scheduled jobs; cancel one first`);
        const text = prompt.trim();
        if (text === "" || text.length > 2000) throw new OgbError("invalid_input", "prompt must be 1 to 2000 characters");
        const job: ScheduledJob = { id: `j_${randomBytes(4).toString("hex")}`, when: when.trim(), prompt: text, ...parseWhen(when, options.now()) };
        return { jobs: [...jobs, job], result: job };
      }),
    /** Pauses or resumes a job; a resumed job whose time passed runs at the next check (a repeating one moves to its next time). */
    setPaused: (sessionId: string, id: string, paused: boolean) =>
      change(sessionId, (jobs) => {
        const now = options.now();
        let found: ScheduledJob | null = null;
        const next = jobs.map((job) => {
          if (job.id !== id) return job;
          const moved = paused || job.next > now ? job.next : repeats(job) ? nextRun(job, now) : now;
          found = { ...job, next: moved, ...(paused ? { paused: true } : {}) };
          if (!paused) delete (found as ScheduledJob).paused;
          return found;
        });
        return { jobs: next, result: found as ScheduledJob | null };
      }),
    /** Runs a job now. A one-shot job is used up; a repeating one keeps its next time. */
    runNow: async (sessionId: string, id: string) => {
      const job = await change(sessionId, (jobs) => {
        const found = jobs.find((candidate) => candidate.id === id) ?? null;
        const once = found && !repeats(found);
        return { jobs: once ? jobs.filter((candidate) => candidate.id !== id) : jobs, result: found };
      });
      if (job) await options.deliver(sessionId, job, false);
      return job;
    },
    /**
     * Sets the bot's one heartbeat (`every 30m`, a cron; at least every five minutes apart) with optional quiet hours, or removes it
     * (`off`). Returns the job, or null when it was removed.
     */
    setHeartbeat: (sessionId: string, when: string, quiet?: string) =>
      change(sessionId, (jobs) => {
        const others = jobs.filter((job) => !job.heartbeat);
        if (when.trim().toLowerCase() === "off") return { jobs: others, result: null };
        parseQuiet(quiet);
        const timing = parseWhen(when, options.now());
        if (timing.everyMs === undefined && timing.cron === undefined && timing.daily === undefined)
          throw new OgbError("invalid_input", "a heartbeat repeats: 'every 30m', 'daily 09:00' or a cron");
        if (others.length >= MAX_JOBS) throw new OgbError("invalid_input", `a bot has at most ${MAX_JOBS} scheduled jobs; cancel one first`);
        const job: ScheduledJob = {
          id: `hb_${randomBytes(4).toString("hex")}`,
          when: when.trim(),
          prompt: "heartbeat",
          ...timing,
          heartbeat: quiet?.trim() ? { quiet: quiet.trim() } : {},
        };
        return { jobs: [...others, job], result: job as ScheduledJob | null };
      }),
    cancel: (sessionId: string, id: string) =>
      change(sessionId, (jobs) => ({ jobs: jobs.filter((job) => job.id !== id), result: jobs.some((job) => job.id === id) })),
  };
}

export type Scheduler = ReturnType<typeof createScheduler>;
