import { OgbError } from "./errors.ts";
import { isJsonObject, type JsonValue } from "./json.ts";
import type { FileEntry } from "./workspace-files.ts";

/**
 * The protocol between the runtime (through `workspace-client`) and the `desk-daemon` process, and the interface
 * both the real daemon and every fake implement (docs/07 section 4, decision 1).
 *
 * Transport: a Unix socket, one JSON object per line (JSON Lines), UTF-8, `\n` ends a message. The client sends a
 * request and reads exactly one response with the same `id`; requests on one connection may overlap, responses may
 * arrive in any order. A line longer than `MAX_LINE_BYTES` is a protocol error and ends the connection.
 *
 * Rules every implementation keeps:
 * - Every call is idempotent (except `input.insertText`, see there): calling twice leaves the same state and returns an equivalent answer.
 * - A call that needs a running workspace (`ensure`, `takeover.open`) wakes a stopped one instead of failing.
 *   `health` and `destroy` never wake anything: `health` reports what is, `destroy` removes what is.
 * - A workspace is described once. `ensure` with the same spec is a no-op; a different spec for a workspace that
 *   exists is `conflict` (destroy it first), so a screen size never changes behind a running browser.
 * - Failures are `OgbError` kinds, carried on the wire as `{ kind, message }`.
 */
export const WORKSPACE_PROTOCOL_VERSION = 1;
// Room for a file of MAX_FILE_BYTES as base64 (a third larger) in one line, plus the envelope. Only `files.put` and
// `files.get` come near it; the socket is inside the container, so the size is a memory question, not a network one.
export const MAX_LINE_BYTES = 36 * 1024 * 1024;

/** Lower-case letters, digits and dashes, starts with a letter or digit, at most 32 characters; safe in paths and display names. */
export function isWorkspaceId(value: unknown): value is string {
  return typeof value === "string" && /^[a-z0-9][a-z0-9-]{0,31}$/.test(value);
}

/**
 * A session id (`s_1a2b...`) becomes a workspace id by lower-casing and turning `_` into `-`. No hashing and no
 * shortening: a mapping that can collide would put two sessions in one desktop, so an id that does not fit is refused.
 */
export function workspaceIdFor(sessionId: string): string {
  const id = sessionId.toLowerCase().replaceAll("_", "-");
  if (!isWorkspaceId(id))
    throw new OgbError(
      "invalid_input",
      `session id '${sessionId}' cannot be used as a workspace id (lower-case letters, digits and '-', at most 32 characters)`,
    );
  return id;
}

export interface ScreenSize {
  readonly width: number;
  readonly height: number;
}

export const DEFAULT_SCREEN: ScreenSize = { width: 1280, height: 800 };
const MIN_SCREEN_SIDE = 320;
const MAX_SCREEN_SIDE = 7680;

export interface WorkspaceSpec {
  readonly workspaceId: string;
  /** Size of the workspace's display. Default `DEFAULT_SCREEN`. */
  readonly screen?: ScreenSize;
}

/** A spec with every default filled in; this is what is stored, compared and returned. */
export interface ResolvedWorkspaceSpec {
  readonly workspaceId: string;
  readonly screen: ScreenSize;
}

/** Checks a spec from outside and fills the defaults. Throws `invalid_input` and names the field, never a value's content. */
export function resolveWorkspaceSpec(value: unknown): ResolvedWorkspaceSpec {
  if (!isJsonObject(value)) throw new OgbError("invalid_input", "spec must be an object");
  const allowed = new Set(["workspaceId", "screen"]);
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) throw new OgbError("invalid_input", `spec has an unknown field: ${key}`);
  }
  if (!isWorkspaceId(value.workspaceId)) throw new OgbError("invalid_input", "spec.workspaceId must match [a-z0-9][a-z0-9-]{0,31}");
  const screen = value.screen === undefined ? DEFAULT_SCREEN : resolveScreen(value.screen);
  return { workspaceId: value.workspaceId, screen };
}

function resolveScreen(value: JsonValue): ScreenSize {
  if (!isJsonObject(value)) throw new OgbError("invalid_input", "spec.screen must be an object");
  const { width, height } = value;
  for (const [name, side] of [
    ["width", width],
    ["height", height],
  ] as const) {
    if (typeof side !== "number" || !Number.isInteger(side) || side < MIN_SCREEN_SIDE || side > MAX_SCREEN_SIDE) {
      throw new OgbError("invalid_input", `spec.screen.${name} must be an integer from ${MIN_SCREEN_SIDE} to ${MAX_SCREEN_SIDE}`);
    }
  }
  return { width: width as number, height: height as number };
}

export function sameSpec(a: ResolvedWorkspaceSpec, b: ResolvedWorkspaceSpec): boolean {
  return a.workspaceId === b.workspaceId && a.screen.width === b.screen.width && a.screen.height === b.screen.height;
}

/** What a tool needs to reach a running workspace. Ports are on 127.0.0.1 and chosen by the daemon. */
export interface WorkspaceInfo {
  readonly spec: ResolvedWorkspaceSpec;
  /** X11 display name, for example `:101`. */
  readonly display: string;
  /** Chrome DevTools Protocol endpoint of this workspace's browser, for example `http://127.0.0.1:9301`. */
  readonly cdpUrl: string;
  /** The agent's files directory. It survives restarts and even `destroy`: the desktop never deletes the agent's files. */
  readonly filesDir: string;
  /** The browser profile directory. Its cookies are kept equal across workspaces, so a login is made once for all sessions. */
  readonly profileDir: string;
  /**
   * Settings and data of desktop programs, shared by every workspace (the person's programs keep one set of sign-ins and
   * preferences). Commands get it as XDG_CONFIG_HOME, XDG_DATA_HOME and XDG_STATE_HOME below this directory.
   */
  readonly appDataDir: string;
  /** The display's D-Bus session where desktop programs publish their widgets (absent when the desktop has none). */
  readonly accessibilityBus?: string;
}

export type WorkspaceState =
  | "absent" // the daemon has no record of it
  | "stopped" // recorded on disk, no processes (after a daemon restart, or stopped when idle)
  | "starting"
  | "running" // every process is up
  | "degraded"; // some process is down and being restarted

export type ProcessState = "running" | "restarting" | "stopped" | "failed";

export interface ProcessHealth {
  readonly state: ProcessState;
  /** Restarts since the workspace started. */
  readonly restarts: number;
}

export interface WorkspaceHealth {
  readonly workspaceId: string;
  readonly state: WorkspaceState;
  /** Present when the state is not `absent` or `stopped`. */
  readonly processes?: {
    readonly display: ProcessHealth;
    readonly windowManager: ProcessHealth;
    readonly browser: ProcessHealth;
  };
}

export interface DestroyResult {
  /** False when there was nothing to destroy (the call was a repeat). */
  readonly existed: boolean;
}

/**
 * What a ticket allows on the display stream. `view`: the bridge forwards only what is needed to see the screen and
 * drops every key, pointer and clipboard message. `control`: a raw pipe, the person works the desktop. The mode is
 * fixed by the token and never changes on a live connection; take-over is a new ticket and a new WebSocket.
 */
export type StreamMode = "view" | "control";

/**
 * A short-lived right to open the display stream of one workspace. The stream is a WebSocket on 127.0.0.1
 * that speaks the VNC protocol (what noVNC connects to). The gateway proxies it; it is never exposed directly.
 * `view.open` returns a `view` ticket, `takeover.open` a `control` ticket.
 */
export interface TakeoverTicket {
  readonly workspaceId: string;
  readonly mode: StreamMode;
  readonly host: "127.0.0.1";
  readonly port: number;
  /** Must be sent as the `token` query parameter of the WebSocket URL; the bridge refuses anything else. */
  readonly token: string;
  /** Milliseconds since the epoch; after this the token no longer opens new connections. */
  readonly expiresAt: number;
}

/** Most characters one `input.insertText` call takes. */
export const MAX_INSERT_TEXT_CHARS = 2000;

/** Checks text for `input.insertText`: a non-empty string of at most `MAX_INSERT_TEXT_CHARS` characters. Throws `invalid_input` without quoting the text. */
export function checkInsertText(value: unknown): string {
  if (typeof value !== "string" || value === "") throw new OgbError("invalid_input", "text must be a non-empty string");
  if ([...value].length > MAX_INSERT_TEXT_CHARS) throw new OgbError("invalid_input", `text is longer than ${MAX_INSERT_TEXT_CHARS} characters`);
  return value;
}

export interface InsertTextResult {
  /** How many characters (code points) were put into the page. */
  readonly inserted: number;
}

export interface TakeoverCloseResult {
  readonly wasOpen: boolean;
}

export interface WorkspaceHost {
  ensure(spec: WorkspaceSpec): Promise<WorkspaceInfo>;
  destroy(workspaceId: string): Promise<DestroyResult>;
  health(workspaceId: string): Promise<WorkspaceHealth>;
  readonly takeover: {
    /** Idempotent: while a ticket is valid the same ticket is returned; an expired one is replaced. Closing revokes the token and drops its connections. */
    open(workspaceId: string): Promise<TakeoverTicket>;
    close(workspaceId: string): Promise<TakeoverCloseResult>;
  };
  /**
   * The same stream for watching only: a ticket of mode `view`. There is no `view.close`: a view ends when its
   * connections leave, and the daemon stops an idle stream by itself. The daemon keeps a set of tokens, one mode per
   * token, all on one port per workspace. A ticket of a given mode is the same while it is valid, so the gateway asks
   * for a fresh daemon ticket for every page ticket it hands out and never shares one between pages.
   */
  readonly view: {
    open(workspaceId: string): Promise<TakeoverTicket>;
  };
  readonly input: {
    /**
     * Types text into the focused editable element of the workspace's browser page, any Unicode (Chinese, emoji, long
     * text): the keyboard path of the live view carries ASCII only. It does not reach the address bar or other browser
     * chrome. Allowed only while the workspace has an open `control` stream (else `denied`); rate-limited
     * (`unavailable`); at most `MAX_INSERT_TEXT_CHARS` characters. The text is a secret: no implementation logs it,
     * puts it on a command line or in an error message.
     * The only call of this protocol that is NOT idempotent: calling twice types twice, so a client must not repeat it
     * after a transport failure it cannot tell the outcome of.
     */
    insertText(workspaceId: string, text: string): Promise<InsertTextResult>;
  };
  /**
   * Files in the workspace's files directory (`WorkspaceInfo.filesDir`), the one place the person and the agent
   * exchange files. The directory exists on disk even when the workspace is stopped, so none of these wakes it.
   * Only regular files directly in the directory exist for these calls: no sub-directories, no symlinks, no
   * dot-files. File content is never logged by any implementation, only names and sizes.
   */
  readonly files: {
    /**
     * Stores `bytes` under `sanitizeFileName(name)`; a taken name gets a number (`a.pdf` then `a-2.pdf`), nothing is
     * ever overwritten. Returns the entry as stored, so the caller learns the final name. More than `MAX_FILE_BYTES`
     * is `invalid_input`. NOT idempotent: calling twice stores twice, so a client does not repeat it after a
     * transport failure.
     */
    put(workspaceId: string, name: string, bytes: Uint8Array): Promise<FileEntry>;
    list(workspaceId: string): Promise<FileEntry[]>;
    /** `not_found` for a missing file, `denied` for a symlink, anything that is not a regular file, or a file larger than `MAX_FILE_BYTES`. */
    get(workspaceId: string, name: string): Promise<Uint8Array>;
  };
}
