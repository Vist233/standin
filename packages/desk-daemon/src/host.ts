import { mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import {
  checkInsertText,
  type DestroyResult,
  type InsertTextResult,
  isJsonObject,
  isWorkspaceId,
  OgbError,
  type PluginLogger,
  type ResolvedWorkspaceSpec,
  resolveWorkspaceSpec,
  sameSpec,
  type StreamMode,
  type TakeoverCloseResult,
  type TakeoverTicket,
  type WorkspaceHealth,
  type WorkspaceHost,
  type WorkspaceInfo,
  type WorkspaceSpec,
} from "@standin/contracts";
import { type DaemonConfig, SLOT_COUNT } from "./config.ts";
import { devtoolsCookies, SharedLogins } from "./shared-logins.ts";
import { sweepStaleProcesses } from "./supervisor.ts";
import { Workspace, workspacePaths } from "./workspace.ts";

const RECORD_VERSION = 1;

/**
 * The real `WorkspaceHost`: owns the workspaces of this box. A workspace exists as a record on disk until destroyed; at most
 * `maxWorkspaces` of them run at once. Waking one more stops the one used least recently that nobody is watching: its
 * profile (logins) and files stay on disk, and it wakes again the next time its session needs it.
 */
export class DeskHost implements WorkspaceHost {
  readonly takeover: WorkspaceHost["takeover"];
  readonly view: WorkspaceHost["view"];
  readonly input: WorkspaceHost["input"];
  readonly files: WorkspaceHost["files"];
  private readonly workspaces = new Map<string, Workspace>();
  private readonly tails = new Map<string, Promise<unknown>>();
  private readonly lastUsed = new Map<string, number>();
  private readonly config: DaemonConfig;
  private readonly log: PluginLogger;
  private readonly reaper: ReturnType<typeof setInterval>;
  private readonly logins: SharedLogins;
  private readonly loginTimer: ReturnType<typeof setInterval> | null;

  /** Reads the records left by an earlier daemon: those workspaces are `stopped` until someone asks for them. */
  constructor(config: DaemonConfig, log: PluginLogger) {
    this.config = config;
    this.log = log;
    this.loadRecords();
    this.logins = new SharedLogins(join(config.dataDir, "shared", "cookies.json"), log);
    this.loginTimer = config.loginSyncMs > 0 ? setInterval(() => void this.syncLogins(), config.loginSyncMs) : null;
    this.loginTimer?.unref();
    this.takeover = this.streamApi("control");
    this.view = { open: this.streamApi("view").open };
    this.input = {
      insertText: (id, text) =>
        this.serial(id, async (): Promise<InsertTextResult> => {
          const checked = checkInsertText(text);
          const workspace = this.workspaces.get(id);
          if (!workspace) throw new OgbError("not_found", `workspace ${id} does not exist`);
          this.lastUsed.set(id, Date.now());
          return { inserted: await workspace.insertText(checked) };
        }),
    };
    this.files = {
      // put runs in the workspace's queue so two puts of one name cannot race; list and get only read.
      put: (id, name, bytes) => this.serial(id, async () => this.workspaceOf(id).files.put(name, bytes)),
      list: async (id) => this.workspaceOf(id).files.list(),
      get: async (id, name) => this.workspaceOf(id).files.get(name),
    };
    // The reaper runs inside each workspace's operation queue, so it cannot stop a stream in the middle of an `open`.
    this.reaper = setInterval(() => {
      for (const id of this.workspaces.keys()) {
        void this.serial(id, async () => void (await this.workspaces.get(id)?.reapStream())).catch((error) =>
          this.log.warn("display stream sweep failed", { workspace: id, error: String(error) }),
        );
      }
    }, config.reapIntervalMs);
    this.reaper.unref();
  }

  private streamApi(mode: StreamMode): WorkspaceHost["takeover"] {
    return {
      open: (id) => this.serial(id, () => this.openStream(id, mode)),
      close: (id) => this.serial(id, async (): Promise<TakeoverCloseResult> => ({ wasOpen: (await this.workspaces.get(id)?.closeStream(mode)) ?? false })),
    };
  }

  async ensure(specInput: WorkspaceSpec): Promise<WorkspaceInfo> {
    const spec = resolveWorkspaceSpec(specInput);
    return this.serial(spec.workspaceId, async () => {
      let workspace = this.workspaces.get(spec.workspaceId);
      if (workspace && !sameSpec(workspace.spec, spec)) {
        throw new OgbError("conflict", `workspace ${spec.workspaceId} exists with a different spec; destroy it first`);
      }
      workspace ??= this.create(spec);
      await this.wake(workspace);
      return workspace.info();
    });
  }

  async destroy(workspaceId: string): Promise<DestroyResult> {
    this.requireId(workspaceId);
    return this.serial(workspaceId, async () => {
      const workspace = this.workspaces.get(workspaceId);
      if (!workspace) return { existed: false };
      await workspace.stop();
      this.workspaces.delete(workspaceId);
      this.lastUsed.delete(workspaceId);
      // The agent's files stay: they belong to the session, not to the desktop. Logins (the profile) go.
      for (const path of [workspace.paths.record, workspace.paths.profileDir, workspace.paths.homeDir, workspace.paths.runDir])
        rmSync(path, { recursive: true, force: true });
      return { existed: true };
    });
  }

  async health(workspaceId: string): Promise<WorkspaceHealth> {
    this.requireId(workspaceId);
    return this.workspaces.get(workspaceId)?.health() ?? { workspaceId, state: "absent" };
  }

  /** Stops every workspace's processes but keeps the records, so the next daemon finds them. */
  async shutdown(): Promise<void> {
    clearInterval(this.reaper);
    if (this.loginTimer) clearInterval(this.loginTimer);
    await Promise.all([...this.workspaces.keys()].map((id) => this.serial(id, () => this.workspaces.get(id)?.stop() ?? Promise.resolve())));
  }

  private async openStream(workspaceId: string, mode: StreamMode): Promise<TakeoverTicket> {
    const workspace = this.workspaces.get(workspaceId);
    if (!workspace) throw new OgbError("not_found", `workspace ${workspaceId} does not exist`);
    await this.wake(workspace);
    return workspace.openStream(mode);
  }

  /** One round of cookie sharing over the running browsers. */
  private syncLogins(): Promise<void> {
    const running = [...this.workspaces.values()].filter((w) => w.running);
    return this.logins.sync(running.map((w) => devtoolsCookies(w.spec.workspaceId, w.numbers.cdpPort)));
  }

  private async wake(workspace: Workspace): Promise<void> {
    this.lastUsed.set(workspace.spec.workspaceId, Date.now());
    if (workspace.running) return;
    await this.makeRoom(workspace);
    try {
      await workspace.start();
      if (this.config.loginSyncMs > 0) await this.syncLogins(); // a browser that just started gets the shared logins at once
    } catch (error) {
      this.log.error("workspace failed to start", { workspace: workspace.spec.workspaceId, error: String(error) });
      throw new OgbError("unavailable", `workspace ${workspace.spec.workspaceId} did not start: ${workspace.diagnostics()}`, { cause: error });
    }
  }

  /** Stops running workspaces, least recently used first and never one with an open live view or take-over, until `waking` fits. */
  private async makeRoom(waking: Workspace): Promise<void> {
    const max = this.config.maxWorkspaces;
    const others = () => [...this.workspaces.values()].filter((w) => w !== waking && w.running);
    while (others().length >= max) {
      const used = (w: Workspace) => this.lastUsed.get(w.spec.workspaceId) ?? 0;
      const victim = others()
        .filter((w) => !w.streamOpen())
        .sort((a, b) => used(a) - used(b))[0];
      if (!victim) throw new OgbError("unavailable", `all ${max} desktops are running and each has a live view or take-over open; close one and try again`);
      const id = victim.spec.workspaceId;
      this.log.info("stopping the least recently used desktop to make room", { workspace: id, running: max });
      await this.serial(id, () => victim.stop());
    }
  }

  private create(spec: ResolvedWorkspaceSpec): Workspace {
    const used = new Set([...this.workspaces.values()].map((w) => w.numbers.slot));
    let slot = 0;
    while (used.has(slot)) slot += 1;
    if (slot >= SLOT_COUNT) throw new OgbError("unavailable", "no free workspace slot");
    const workspace = new Workspace(spec, slot, this.config, this.log);
    writeJsonAtomic(workspace.paths.record, { v: RECORD_VERSION, spec, slot });
    this.workspaces.set(spec.workspaceId, workspace);
    return workspace;
  }

  private loadRecords(): void {
    const root = join(this.config.dataDir, "workspaces");
    let ids: string[];
    try {
      ids = readdirSync(root);
    } catch {
      return;
    }
    for (const id of ids) {
      try {
        const record: unknown = JSON.parse(readFileSync(workspacePaths(this.config.dataDir, id).record, "utf8"));
        if (!isJsonObject(record) || record.v !== RECORD_VERSION || typeof record.slot !== "number") throw new Error("bad record");
        const spec = resolveWorkspaceSpec(record.spec);
        if (spec.workspaceId !== id) throw new Error("record names another workspace");
        const workspace = new Workspace(spec, record.slot, this.config, this.log);
        // A daemon that was killed leaves its workspaces' processes running in their own groups; they hold the display and the profile lock.
        const swept = sweepStaleProcesses(workspace.paths.runDir);
        if (swept > 0) this.log.warn("killed processes left by an earlier daemon", { workspace: id, groups: swept });
        this.workspaces.set(id, workspace);
      } catch (error) {
        // A directory with only files (a destroyed workspace) has no record; that is normal. Anything else is worth a line.
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") this.log.warn("ignoring unreadable workspace record", { workspace: id });
      }
    }
  }

  private workspaceOf(workspaceId: string): Workspace {
    this.requireId(workspaceId);
    const workspace = this.workspaces.get(workspaceId);
    if (!workspace) throw new OgbError("not_found", `workspace ${workspaceId} does not exist`);
    return workspace;
  }

  private requireId(workspaceId: string): void {
    if (!isWorkspaceId(workspaceId)) throw new OgbError("invalid_input", "workspaceId is not valid");
  }

  /** One operation at a time per workspace; different workspaces run in parallel. */
  private async serial<T>(workspaceId: string, operation: () => Promise<T>): Promise<T> {
    this.requireId(workspaceId);
    const run = (this.tails.get(workspaceId) ?? Promise.resolve()).then(operation, operation);
    const tail = run.catch(() => undefined);
    this.tails.set(workspaceId, tail);
    void tail.then(() => {
      if (this.tails.get(workspaceId) === tail) this.tails.delete(workspaceId);
    });
    return run;
  }
}

function writeJsonAtomic(path: string, value: unknown): void {
  mkdirSync(dirname(path), { recursive: true });
  const temp = `${path}.${process.pid}.tmp`;
  writeFileSync(temp, JSON.stringify(value), { mode: 0o600 });
  renameSync(temp, path);
}
