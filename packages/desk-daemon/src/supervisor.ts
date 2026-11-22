import { type ChildProcess, execFileSync, spawn } from "node:child_process";
import { mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { PluginLogger, ProcessHealth, ProcessState } from "@standin/contracts";

export interface Backoff {
  readonly initialMs: number;
  readonly maxMs: number;
  /** A process that ran at least this long counts as healthy again: the next failure starts from `initialMs`. */
  readonly stableMs: number;
}

export const DEFAULT_BACKOFF: Backoff = { initialMs: 500, maxMs: 15_000, stableMs: 30_000 };

export interface ProcessSpec {
  readonly name: string;
  readonly command: string;
  readonly args: readonly string[];
  readonly env?: Readonly<Record<string, string>>;
  readonly cwd?: string;
}

export interface SupervisedOptions {
  readonly spec: ProcessSpec;
  readonly log: PluginLogger;
  readonly backoff?: Backoff;
  /** Resolves true when the process serves what it should (a port answers, a socket file exists). Never throws. */
  readonly probe?: () => Promise<boolean>;
  /** How often `probe` runs after the process is ready; 0 turns the periodic check off (exit detection stays). */
  readonly probeIntervalMs?: number;
  /** Consecutive failed probes after which the process is killed and restarted. */
  readonly probeFailuresToRestart?: number;
  /** Time a SIGTERM gets before SIGKILL. */
  readonly graceMs?: number;
  /**
   * A file that records the process group leader while it runs, so a later daemon can find and kill what this one
   * left behind if it was killed (the children are in their own groups and survive their parent).
   */
  readonly pidFile?: string;
  /** Runs before every start, including restarts (for example: remove a stale lock file the previous process left). */
  readonly beforeStart?: () => void | Promise<void>;
  /** Called when the process died without being asked to, after its process group was swept. */
  readonly onUnexpectedExit?: (info: { code: number | null; signal: NodeJS.Signals | null }) => void;
  /** Called every time the process is up and, when a probe exists, ready. `restart` is false for the first start. */
  readonly onReady?: (info: { restart: boolean }) => void;
}

const OUTPUT_TAIL_BYTES = 2048;

/**
 * Runs one OS process and keeps it running: its own process group (so the whole tree can be killed and no child is
 * left behind), restart with exponential backoff, an optional readiness and health probe. It knows nothing about
 * displays or browsers. States: `stopped` (not wanted), `running`, `restarting` (died or being killed, a restart
 * is planned), `failed` (could not be started; retried with backoff like any other death).
 */
export class SupervisedProcess {
  private readonly options: SupervisedOptions;
  private readonly backoff: Backoff;
  private child: ChildProcess | null = null;
  private wanted = false;
  private paused = false;
  private state: ProcessState = "stopped";
  private restartCount = 0;
  private failures = 0;
  private startedAt = 0;
  private timer: NodeJS.Timeout | null = null;
  private probeTimer: NodeJS.Timeout | null = null;
  private probeFailures = 0;
  private outputTail = "";
  private exited: Promise<void> = Promise.resolve();
  private generation = 0;
  private readyWaiters: Array<{ resolve(): void; reject(error: Error): void }> = [];
  private ready = false;

  constructor(options: SupervisedOptions) {
    this.options = options;
    this.backoff = options.backoff ?? DEFAULT_BACKOFF;
  }

  get name(): string {
    return this.options.spec.name;
  }

  get pid(): number | undefined {
    return this.child?.pid;
  }

  health(): ProcessHealth {
    return { state: this.state, restarts: this.restartCount };
  }

  /** The last bytes the process wrote to standard output and error, for error messages and logs. */
  lastOutput(): string {
    return this.outputTail;
  }

  /** Starts the process (idempotent). Resolves when it has been spawned; use `waitReady` to wait for the probe. */
  start(): void {
    if (this.wanted) return;
    this.wanted = true;
    this.paused = false;
    this.failures = 0;
    this.spawnNow(false);
  }

  /**
   * Stops the process and its whole process group and waits until it is gone (idempotent).
   * After `stop` the process is not restarted until `start` or `resume` is called.
   */
  async stop(): Promise<void> {
    this.wanted = false;
    this.paused = false;
    await this.halt();
    this.state = "stopped";
  }

  /** Stops the process but keeps it wanted: `resume` starts it again. Used when something it depends on is down. */
  async pause(): Promise<void> {
    if (!this.wanted) return;
    this.paused = true;
    await this.halt();
    this.state = "restarting";
  }

  resume(): void {
    if (!this.wanted || !this.paused) return;
    this.paused = false;
    this.failures = 0;
    this.spawnNow(true);
  }

  /**
   * Resolves when the process is up and ready. Rejects after `timeoutMs`, and at once when the program cannot be
   * started at all (a missing binary does not fix itself by waiting).
   */
  waitReady(timeoutMs: number): Promise<void> {
    if (this.state === "running" && this.ready) return Promise.resolve();
    return new Promise((resolve, reject) => {
      const waiter = {
        resolve: () => {
          clearTimeout(timeout);
          resolve();
        },
        reject: (error: Error) => {
          clearTimeout(timeout);
          reject(error);
        },
      };
      const timeout = setTimeout(() => {
        this.readyWaiters = this.readyWaiters.filter((w) => w !== waiter);
        reject(new Error(`${this.name} was not ready after ${timeoutMs} ms: ${this.outputTail.trim().slice(-300)}`));
      }, timeoutMs);
      this.readyWaiters.push(waiter);
    });
  }

  private async halt(): Promise<void> {
    this.clearTimers();
    this.generation += 1; // answers any exit event of the current child as "asked for"
    const child = this.child;
    if (child?.pid !== undefined && child.exitCode === null && child.signalCode === null) {
      killGroup(child.pid, "SIGTERM");
      const forced = setTimeout(() => killGroup(child.pid as number, "SIGKILL"), this.options.graceMs ?? 2000);
      await this.exited;
      clearTimeout(forced);
    } else {
      await this.exited;
    }
    if (child?.pid !== undefined) killGroup(child.pid, "SIGKILL"); // sweep what the leader left behind
    this.child = null;
    this.forgetPid();
    this.ready = false;
  }

  private spawnNow(isRestart: boolean): void {
    const { spec } = this.options;
    const generation = ++this.generation;
    this.ready = false;
    void (async () => {
      try {
        await this.options.beforeStart?.();
        if (generation !== this.generation) return;
        const child = spawn(spec.command, [...spec.args], {
          cwd: spec.cwd,
          env: { ...inheritedEnvironment(), ...spec.env },
          detached: true, // own process group: `kill(-pid)` reaches the whole tree
          stdio: ["ignore", "pipe", "pipe"],
        });
        this.child = child;
        this.recordPid(child.pid);
        this.startedAt = Date.now();
        this.outputTail = "";
        this.state = "running";
        const collect = (chunk: Buffer) => {
          this.outputTail = (this.outputTail + chunk.toString("utf8")).slice(-OUTPUT_TAIL_BYTES);
        };
        child.stdout?.on("data", collect);
        child.stderr?.on("data", collect);
        this.exited = new Promise<void>((resolve) => {
          child.once("exit", (code, signal) => {
            resolve();
            this.onExit(generation, code, signal);
          });
          child.once("error", (error) => {
            // `exit` does not fire when the spawn itself failed (missing binary).
            this.outputTail = String(error.message);
            resolve();
            this.onExit(generation, null, null, true);
          });
        });
        void this.becomeReady(generation, isRestart);
      } catch (error) {
        this.options.log.error("start failed", { process: spec.name, error: String(error) });
        this.onExit(generation, null, null, true);
      }
    })();
  }

  private async becomeReady(generation: number, isRestart: boolean): Promise<void> {
    const { probe } = this.options;
    if (probe) {
      const deadline = Date.now() + 60_000;
      while (generation === this.generation && Date.now() < deadline) {
        if (await safe(probe)) break;
        await sleep(50);
      }
    }
    if (generation !== this.generation || this.state !== "running") return;
    this.ready = true;
    for (const waiter of this.readyWaiters.splice(0)) waiter.resolve();
    this.options.onReady?.({ restart: isRestart || this.restartCount > 0 });
    this.schedulePeriodicProbe(generation);
  }

  private schedulePeriodicProbe(generation: number): void {
    const interval = this.options.probeIntervalMs ?? 2000;
    if (!this.options.probe || interval <= 0) return;
    const limit = this.options.probeFailuresToRestart ?? 3;
    this.probeTimer = setTimeout(async () => {
      if (generation !== this.generation) return;
      const ok = await safe(this.options.probe as () => Promise<boolean>);
      if (generation !== this.generation) return;
      this.probeFailures = ok ? 0 : this.probeFailures + 1;
      if (this.probeFailures >= limit) {
        this.probeFailures = 0;
        this.options.log.warn("health probe failed; killing for restart", { process: this.name });
        if (this.child?.pid !== undefined) killGroup(this.child.pid, "SIGKILL");
        return; // the exit handler restarts it and probing begins again
      }
      this.schedulePeriodicProbe(generation);
    }, interval);
  }

  private onExit(generation: number, code: number | null, signal: NodeJS.Signals | null, spawnFailed = false): void {
    if (generation !== this.generation) return; // we asked for it (stop, pause, a newer start)
    this.clearTimers();
    if (this.child?.pid !== undefined) killGroup(this.child.pid, "SIGKILL"); // no orphan after a kill of the leader
    this.child = null;
    this.forgetPid();
    this.ready = false;
    this.state = spawnFailed ? "failed" : "restarting";
    if (spawnFailed) {
      for (const waiter of this.readyWaiters.splice(0)) waiter.reject(new Error(`${this.name} could not be started: ${this.outputTail.trim().slice(-300)}`));
    }
    this.options.log.warn("process exited", { process: this.name, code, signal });
    this.options.onUnexpectedExit?.({ code, signal });
    if (!this.wanted || this.paused) return;
    const ranFor = Date.now() - this.startedAt;
    if (ranFor >= this.backoff.stableMs) this.failures = 0;
    const delay = Math.min(this.backoff.maxMs, this.backoff.initialMs * 2 ** this.failures);
    this.failures += 1;
    this.restartCount += 1;
    this.timer = setTimeout(() => {
      this.timer = null;
      if (this.wanted && !this.paused) this.spawnNow(true);
    }, delay);
  }

  private recordPid(pid: number | undefined): void {
    const file = this.options.pidFile;
    if (!file || pid === undefined) return;
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, JSON.stringify({ pid, args: commandLine(this.options.spec) }));
  }

  private forgetPid(): void {
    if (this.options.pidFile) rmSync(this.options.pidFile, { force: true });
  }

  private clearTimers(): void {
    if (this.timer) clearTimeout(this.timer);
    if (this.probeTimer) clearTimeout(this.probeTimer);
    this.timer = null;
    this.probeTimer = null;
    this.probeFailures = 0;
  }
}

/**
 * Signals a whole process group. A group that is already gone is not an error. macOS answers EPERM, not ESRCH, for
 * a group whose leader has just exited and has not been reaped; the group is ours, so both mean "nothing to signal".
 */
const SECRET_NAME = /(API_?KEY|TOKEN|SECRET|PASSWORD|PASSWD|CREDENTIAL)/i;

/**
 * What a started program inherits from the daemon: everything except variables that look like secrets. The image
 * already starts the daemon without the model key (s6 run script); this keeps a browser or a desktop program from
 * ever receiving one if the daemon is started some other way. What `spec.env` names is passed on as given.
 */
function inheritedEnvironment(): NodeJS.ProcessEnv {
  return Object.fromEntries(Object.entries(process.env).filter(([name]) => !SECRET_NAME.test(name)));
}

export function killGroup(pid: number, signal: NodeJS.Signals): void {
  try {
    process.kill(-pid, signal);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code !== "ESRCH" && code !== "EPERM") throw error;
  }
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function safe(probe: () => Promise<boolean>): Promise<boolean> {
  try {
    return await probe();
  } catch {
    return false;
  }
}

function commandLine(spec: ProcessSpec): string {
  return [spec.command, ...spec.args].join(" ");
}

/**
 * Kills the process groups that an earlier daemon recorded in `*.pid` files of `dir` and did not stop. A record is
 * trusted only when the process with that pid still runs exactly the recorded command line, so a reused pid is
 * never signalled. Returns how many groups were killed.
 */
export function sweepStaleProcesses(dir: string): number {
  let names: string[];
  try {
    names = readdirSync(dir).filter((name) => name.endsWith(".pid"));
  } catch {
    return 0;
  }
  let killed = 0;
  for (const name of names) {
    const file = join(dir, name);
    try {
      const record = JSON.parse(readFileSync(file, "utf8")) as { pid?: unknown; args?: unknown };
      if (typeof record.pid === "number" && typeof record.args === "string" && runningCommandLine(record.pid) === record.args) {
        killGroup(record.pid, "SIGKILL");
        killed += 1;
      }
    } catch {
      // an unreadable record names nothing we could trust; it is removed below
    }
    rmSync(file, { force: true });
  }
  return killed;
}

function runningCommandLine(pid: number): string | null {
  try {
    return execFileSync("ps", ["-ww", "-p", String(pid), "-o", "args="], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
  } catch {
    return null; // ps exits 1 when the process does not exist
  }
}
