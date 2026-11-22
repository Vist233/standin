import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { OgbError, type RunOptions, type RunResult, type WorkspaceProcess } from "@standin/contracts";

export interface WorkspaceTarget {
  workspaceId: string;
  filesDir: string;
  display?: string | undefined;
  cdpUrl?: string | undefined;
  /** Shared settings and data of desktop programs (WorkspaceInfo.appDataDir). */
  appDataDir?: string | undefined;
  /** The display's accessibility bus (WorkspaceInfo.accessibilityBus). */
  accessibilityBus?: string | undefined;
}

/** Names a caller cannot set through `RunOptions.env`: they are the workspace's own. */
const PROTECTED = new Set([
  "PATH",
  "HOME",
  "LANG",
  "DISPLAY",
  "OGB_WORKSPACE_ID",
  "OGB_FILES_DIR",
  "OGB_CDP_URL",
  "XDG_CONFIG_HOME",
  "XDG_DATA_HOME",
  "XDG_STATE_HOME",
  "DBUS_SESSION_BUS_ADDRESS",
  "GTK_MODULES",
  "NO_AT_BRIDGE",
]);
const ENV_NAME = /^[A-Z][A-Z0-9_]{0,63}$/;
const DEFAULT_TIMEOUT_MS = 30_000;
const DEFAULT_OUTPUT_BYTES = 1_048_576;

/**
 * The whole environment of a command run for a workspace. It is built from scratch, never from the runtime's own environment,
 * so the model keys, tokens and paths the runtime holds cannot reach a command (or a worker, a browser or a desktop tool).
 */
export function workspaceEnvironment(target: WorkspaceTarget, extra: Record<string, string> = {}): Record<string, string> {
  for (const [name, value] of Object.entries(extra)) {
    if (!ENV_NAME.test(name)) throw new OgbError("invalid_input", `environment variable name '${name}' is not allowed (capital letters, digits and '_')`);
    if (PROTECTED.has(name)) throw new OgbError("denied", `environment variable '${name}' belongs to the workspace and cannot be set`);
    if (typeof value !== "string" || value.includes("\0")) throw new OgbError("invalid_input", `environment variable '${name}' must be text without NUL`);
  }
  return {
    PATH: "/usr/local/bin:/usr/bin:/bin",
    HOME: target.filesDir,
    LANG: "C.UTF-8",
    // the box's own zone: without it a bot's `date` says UTC while its scheduled jobs run in the container's zone
    ...(process.env.TZ ? { TZ: process.env.TZ } : {}),
    OGB_WORKSPACE_ID: target.workspaceId,
    OGB_FILES_DIR: target.filesDir,
    ...(target.display !== undefined ? { DISPLAY: target.display } : {}),
    ...(target.cdpUrl !== undefined ? { OGB_CDP_URL: target.cdpUrl } : {}),
    ...(target.appDataDir !== undefined
      ? { XDG_CONFIG_HOME: `${target.appDataDir}/config`, XDG_DATA_HOME: `${target.appDataDir}/data`, XDG_STATE_HOME: `${target.appDataDir}/state` }
      : {}),
    // programs started for the workspace publish their widgets on the display's bus (GTK through its accessibility bridge)
    ...(target.accessibilityBus !== undefined ? { DBUS_SESSION_BUS_ADDRESS: target.accessibilityBus, GTK_MODULES: "gail:atk-bridge", NO_AT_BRIDGE: "0" } : {}),
    ...extra,
  };
}

function checkCommand(command: readonly string[]): void {
  if (command.length === 0 || command.some((part) => typeof part !== "string" || part.includes("\0")) || command[0] === "") {
    throw new OgbError("invalid_input", "command must be a program followed by its arguments, as text");
  }
}

/** Starts `command` in the workspace's files directory with `workspaceEnvironment`, and leaves it running (WorkspaceHandle.spawn). */
export function spawnInWorkspace(target: WorkspaceTarget, command: readonly string[], options: { env?: Record<string, string> } = {}): WorkspaceProcess {
  checkCommand(command);
  const env = workspaceEnvironment(target, options.env);
  if (!existsSync(target.filesDir)) throw new OgbError("unavailable", "the workspace's files directory does not exist");
  const [program, ...args] = command as [string, ...string[]];
  return spawn(program, args, { cwd: target.filesDir, env, shell: false, stdio: ["pipe", "pipe", "pipe"] });
}

/** Runs `command` (program and arguments, no shell) in the workspace's files directory with `workspaceEnvironment`. */
export function runInWorkspace(target: WorkspaceTarget, command: readonly string[], options: RunOptions = {}): Promise<RunResult> {
  if (command.length === 0 || command.some((part) => typeof part !== "string" || part.includes("\0")) || command[0] === "") {
    return Promise.reject(new OgbError("invalid_input", "command must be a program followed by its arguments, as text"));
  }
  let env: Record<string, string>;
  try {
    env = workspaceEnvironment(target, options.env);
  } catch (error) {
    return Promise.reject(error);
  }
  if (!existsSync(target.filesDir)) return Promise.reject(new OgbError("unavailable", "the workspace's files directory does not exist"));
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const maxBytes = options.maxOutputBytes ?? DEFAULT_OUTPUT_BYTES;
  const [program, ...args] = command as [string, ...string[]];

  return new Promise<RunResult>((resolve, reject) => {
    const child = spawn(program, args, { cwd: target.filesDir, env, shell: false, stdio: ["pipe", "pipe", "pipe"] });
    const out: Buffer[] = [];
    const err: Buffer[] = [];
    const sizes = { out: 0, err: 0 };
    let truncated = false;
    let timedOut = false;
    let settled = false;

    const collect = (chunks: Buffer[], key: "out" | "err") => (chunk: Buffer) => {
      const room = maxBytes - sizes[key];
      if (room <= 0) {
        truncated = true;
        return;
      }
      const kept = chunk.length > room ? chunk.subarray(0, room) : chunk;
      if (kept.length < chunk.length) truncated = true;
      chunks.push(kept);
      sizes[key] += kept.length;
    };
    child.stdout.on("data", collect(out, "out"));
    child.stderr.on("data", collect(err, "err"));

    const kill = () => child.kill("SIGKILL");
    const timer = setTimeout(() => {
      timedOut = true;
      kill();
    }, timeoutMs);
    options.signal?.addEventListener("abort", kill, { once: true });
    if (options.signal?.aborted) kill();

    const finish = (action: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      options.signal?.removeEventListener("abort", kill);
      action();
    };
    child.once("error", (error) => {
      finish(() =>
        reject(new OgbError((error as NodeJS.ErrnoException).code === "ENOENT" ? "not_found" : "unavailable", `cannot run '${program}'`, { cause: error })),
      );
    });
    child.once("close", (code) => {
      finish(() => resolve({ exitCode: code, stdout: Buffer.concat(out).toString("utf8"), stderr: Buffer.concat(err).toString("utf8"), timedOut, truncated }));
    });
    child.stdin.on("error", () => {}); // a command that ends without reading its input is not an error of ours
    child.stdin.end(options.stdin ?? "");
  });
}
