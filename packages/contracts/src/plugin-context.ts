import type { SignalDraft } from "./signals.ts";

/** Tools, plugins and models ask for secrets by reference; the value exists only at the moment of use. */
export interface SecretResolver {
  /** Rejects with `not_found`, `denied` or `unavailable`; the error text names the reference, never a value. */
  resolve(reference: string): Promise<string>;
}

/** Where a plugin's event sources put what they notice (a mail arrived). The router decides what happens next. */
export interface SignalSink {
  /** `sessionTarget` is a session id, or `self` for the session that owns this plugin instance. */
  emit(sessionTarget: string, draft: SignalDraft): void | Promise<void>;
}

export interface PluginLogger {
  info(message: string, fields?: Record<string, unknown>): void;
  warn(message: string, fields?: Record<string, unknown>): void;
  error(message: string, fields?: Record<string, unknown>): void;
}

export interface RunOptions {
  /** The command is killed after this long (default 30000 ms). */
  timeoutMs?: number;
  signal?: AbortSignal;
  /** Text written to the command's standard input. */
  stdin?: string;
  /**
   * Extra environment variables for this one command (for example a worker's `BROWSER_TOOL_CDP`). The environment is otherwise
   * exactly the workspace's own (see `WorkspaceHandle.run`); the protected names cannot be set.
   */
  env?: Record<string, string>;
  /** Output beyond this many bytes per stream is dropped and `truncated` is set (default 1 MiB). */
  maxOutputBytes?: number;
}

export interface RunResult {
  /** Null when the command was killed. */
  exitCode: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  truncated: boolean;
}

/** A program started for a workspace that keeps running (a tool's runner): its pipes and how to stop it. `child_process.spawn`'s result fits. */
export interface WorkspaceProcess {
  readonly stdin: NodeJS.WritableStream | null;
  readonly stdout: NodeJS.ReadableStream | null;
  readonly stderr: NodeJS.ReadableStream | null;
  kill(signal?: NodeJS.Signals): boolean;
  once(event: "exit", listener: (code: number | null) => void): unknown;
}

/**
 * One workspace as a tool sees it. A tool is built with exactly one handle and has no way to name another workspace
 * (isolation by construction, docs/07 section 5). Later tasks (desk-daemon, workspace-client) add what a handle can
 * do; this is the part every plugin may rely on.
 */
export interface WorkspaceHandle {
  readonly workspaceId: string;
  /** Directory of the agent's files inside the box. */
  readonly filesDir: string;
  /** X11 display of this workspace (for example `:101`), when it has one. */
  readonly display?: string;
  /** DevTools endpoint of this workspace's browser, when it has one. */
  readonly cdpUrl?: string;
  /**
   * Runs a program (an argument list, no shell) for this workspace and waits for it. In version 1 the runtime and the
   * desk-daemon share one container, so this is a local child process in the files directory with the workspace's `DISPLAY`
   * and DevTools address and NO other inherited environment: the keys, tokens and paths of the runtime never reach it.
   * The interface is the same when a later multi-user version runs the command in a microVM through a tool channel.
   */
  run(command: readonly string[], options?: RunOptions): Promise<RunResult>;
  /**
   * Starts a program for this workspace that keeps running, with the same directory and environment as `run` (`env` adds names; the
   * workspace's own cannot be set). The caller talks to it through its pipes and ends it.
   */
  spawn(command: readonly string[], options?: { env?: Record<string, string> }): WorkspaceProcess;
}

/** The only thing a plugin receives from the runtime (docs/08 section 2, rule 1). */
export interface PluginContext {
  workspace: WorkspaceHandle;
  secrets: SecretResolver;
  signals: SignalSink;
  /** A directory the plugin may write; survives restarts, private to this plugin and this session. */
  dataDir: string;
  /** A directory the plugin may write that all sessions of the box share (a store for what agents hand to each other). Private to this plugin. */
  sharedDataDir: string;
  log: PluginLogger;
}
