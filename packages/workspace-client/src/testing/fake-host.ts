import { mkdirSync } from "node:fs";
import { join } from "node:path";
import {
  checkFileBytes,
  checkInsertText,
  type DestroyResult,
  isWorkspaceId,
  numberedName,
  OgbError,
  type ResolvedWorkspaceSpec,
  resolveWorkspaceSpec,
  sanitizeFileName,
  sameSpec,
  type StreamMode,
  type TakeoverCloseResult,
  type TakeoverTicket,
  type WorkspaceHealth,
  type WorkspaceHost,
  type WorkspaceInfo,
  type WorkspaceSpec,
  type WorkspaceState,
} from "@standin/contracts";

export interface FakeWorkspaceHost extends WorkspaceHost {
  /** Puts a workspace in the `stopped` state (as after a daemon restart); `ensure` wakes it. */
  stop(workspaceId: string): void;
  /** Counts how often each method ran, so tests can see idempotent repeats. */
  readonly calls: string[];
  /** What `input.insertText` received. */
  readonly typed: string[];
}

interface Entry {
  spec: ResolvedWorkspaceSpec;
  info: WorkspaceInfo;
  state: WorkspaceState;
  tickets: Partial<Record<StreamMode, TakeoverTicket>>;
  files: Map<string, { bytes: Uint8Array; modifiedAt: number }>;
}

/** An in-memory WorkspaceHost that obeys the rules written in the contract. Files directories are real directories under `root`. */
export function createFakeWorkspaceHost(options: { root: string; now?: () => number; ticketMs?: number }): FakeWorkspaceHost {
  const now = options.now ?? Date.now;
  const ticketMs = options.ticketMs ?? 60_000;
  const entries = new Map<string, Entry>();
  const calls: string[] = [];
  const typed: string[] = [];
  let counter = 0;

  const idOf = (workspaceId: string): string => {
    if (!isWorkspaceId(workspaceId)) throw new OgbError("invalid_input", "workspaceId must match [a-z0-9][a-z0-9-]{0,31}");
    return workspaceId;
  };

  return {
    calls,
    typed,
    stop(workspaceId) {
      const entry = entries.get(workspaceId);
      if (entry) {
        entry.state = "stopped";
        entry.tickets = {};
      }
    },
    async ensure(rawSpec: WorkspaceSpec) {
      calls.push("ensure");
      const spec = resolveWorkspaceSpec(rawSpec);
      const existing = entries.get(spec.workspaceId);
      if (existing) {
        if (!sameSpec(existing.spec, spec)) throw new OgbError("conflict", `workspace '${spec.workspaceId}' exists with another spec; destroy it first`);
        existing.state = "running"; // a stopped workspace is woken, not refused
        return existing.info;
      }
      counter += 1;
      const filesDir = join(options.root, spec.workspaceId, "files");
      const profileDir = join(options.root, spec.workspaceId, "profile");
      mkdirSync(filesDir, { recursive: true });
      mkdirSync(profileDir, { recursive: true });
      const info: WorkspaceInfo = {
        spec,
        display: `:${100 + counter}`,
        cdpUrl: `http://127.0.0.1:${9300 + counter}`,
        filesDir,
        profileDir,
        appDataDir: join(options.root, "shared", "app-data"),
      };
      entries.set(spec.workspaceId, { spec, info, state: "running", tickets: {}, files: new Map() });
      return info;
    },
    async destroy(workspaceId): Promise<DestroyResult> {
      calls.push("destroy");
      return { existed: entries.delete(idOf(workspaceId)) };
    },
    async health(workspaceId): Promise<WorkspaceHealth> {
      calls.push("health");
      const entry = entries.get(idOf(workspaceId));
      if (!entry) return { workspaceId, state: "absent" };
      if (entry.state === "stopped") return { workspaceId, state: "stopped" };
      const up = { state: "running" as const, restarts: 0 };
      return { workspaceId, state: entry.state, processes: { display: up, windowManager: up, browser: up } };
    },
    takeover: stream("takeover", "control"),
    view: { open: stream("view", "view").open },
    files: {
      async put(workspaceId, name, bytes) {
        calls.push("files.put");
        const entry = entries.get(idOf(workspaceId));
        if (!entry) throw new OgbError("not_found", `no workspace '${workspaceId}'`);
        const clean = sanitizeFileName(name);
        checkFileBytes(bytes);
        let n = 1;
        while (entry.files.has(numberedName(clean, n))) n += 1;
        const stored = numberedName(clean, n);
        entry.files.set(stored, { bytes: Uint8Array.from(bytes), modifiedAt: now() });
        return { name: stored, size: bytes.length, modifiedAt: now(), path: join(entry.info.filesDir, stored) };
      },
      async list(workspaceId) {
        calls.push("files.list");
        const entry = entries.get(idOf(workspaceId));
        if (!entry) throw new OgbError("not_found", `no workspace '${workspaceId}'`);
        return [...entry.files].map(([name, file]) => ({ name, size: file.bytes.length, modifiedAt: file.modifiedAt, path: join(entry.info.filesDir, name) }));
      },
      async get(workspaceId, name) {
        calls.push("files.get");
        const entry = entries.get(idOf(workspaceId));
        if (!entry) throw new OgbError("not_found", `no workspace '${workspaceId}'`);
        const file = entry.files.get(name);
        if (!file) throw new OgbError("not_found", "no such file");
        return Uint8Array.from(file.bytes);
      },
    },
    input: {
      async insertText(workspaceId, text) {
        calls.push("input.insertText");
        const checked = checkInsertText(text);
        const entry = entries.get(idOf(workspaceId));
        if (!entry) throw new OgbError("not_found", `no workspace '${workspaceId}'`);
        const control = entry.tickets.control;
        if (!control || control.expiresAt <= now()) throw new OgbError("denied", "text can be inserted only while the workspace is taken over");
        typed.push(checked);
        return { inserted: [...checked].length };
      },
    },
  };

  /** `takeover.*` and `view.*` differ only in the mode of the ticket; each mode keeps its own ticket. */
  function stream(name: "takeover" | "view", mode: StreamMode): WorkspaceHost["takeover"] {
    return {
      async open(workspaceId): Promise<TakeoverTicket> {
        calls.push(`${name}.open`);
        const entry = entries.get(idOf(workspaceId));
        if (!entry) throw new OgbError("not_found", `no workspace '${workspaceId}'`);
        entry.state = "running";
        const live = entry.tickets[mode];
        if (live && live.expiresAt > now()) return live;
        const ticket: TakeoverTicket = {
          workspaceId,
          mode,
          host: "127.0.0.1",
          port: 6000 + counter,
          token: `token-${mode}-${workspaceId}-${now()}`,
          expiresAt: now() + ticketMs,
        };
        entry.tickets[mode] = ticket;
        return ticket;
      },
      async close(workspaceId): Promise<TakeoverCloseResult> {
        calls.push(`${name}.close`);
        const entry = entries.get(idOf(workspaceId));
        const live = entry?.tickets[mode];
        if (entry) delete entry.tickets[mode];
        return { wasOpen: Boolean(live && live.expiresAt > now()) };
      },
    };
  }
}
