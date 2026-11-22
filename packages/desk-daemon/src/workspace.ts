import { mkdirSync } from "node:fs";
import { join } from "node:path";
import {
  OgbError,
  type PluginLogger,
  type ResolvedWorkspaceSpec,
  type StreamMode,
  type TakeoverTicket,
  type WorkspaceHealth,
  type WorkspaceInfo,
} from "@vesper/contracts";
import { createBrowserProcess } from "./browser-proc.ts";
import { type DaemonConfig, type SlotNumbers, slotNumbers } from "./config.ts";
import { Display } from "./display.ts";
import type { SupervisedProcess } from "./supervisor.ts";
import { WorkspaceFiles } from "./files.ts";
import { DisplayStream } from "./takeover.ts";
import { TextInserter } from "./text-input.ts";

export interface WorkspacePaths {
  readonly root: string;
  readonly record: string;
  readonly filesDir: string;
  readonly profileDir: string;
  readonly homeDir: string;
  /** pid records of the running processes; stale ones are swept by the next daemon. */
  readonly runDir: string;
}

export function workspacePaths(dataDir: string, workspaceId: string): WorkspacePaths {
  const root = join(dataDir, "workspaces", workspaceId);
  return {
    root,
    record: join(root, "record.json"),
    filesDir: join(root, "files"),
    profileDir: join(root, "profile"),
    homeDir: join(root, "home"),
    runDir: join(root, "run"),
  };
}

/**
 * One workspace: a display with a window manager, a headed browser on it and the display stream. The numbers (display,
 * ports) come from its slot and never change. It does not know about other workspaces; `DeskHost` owns the set.
 */
export class Workspace {
  readonly spec: ResolvedWorkspaceSpec;
  readonly numbers: SlotNumbers;
  readonly paths: WorkspacePaths;
  private readonly display: Display;
  private readonly browser: SupervisedProcess;
  private readonly stream: DisplayStream;
  private readonly typist: TextInserter;
  readonly files: WorkspaceFiles;
  private readonly config: DaemonConfig;
  private phase: "stopped" | "starting" | "started" = "stopped";

  constructor(spec: ResolvedWorkspaceSpec, slot: number, config: DaemonConfig, log: PluginLogger) {
    this.spec = spec;
    this.config = config;
    this.numbers = slotNumbers(slot, config.portShift);
    this.paths = workspacePaths(config.dataDir, spec.workspaceId);
    const scoped: PluginLogger = {
      info: (m, f) => log.info(m, { workspace: spec.workspaceId, ...f }),
      warn: (m, f) => log.warn(m, { workspace: spec.workspaceId, ...f }),
      error: (m, f) => log.error(m, { workspace: spec.workspaceId, ...f }),
    };
    this.browser = createBrowserProcess(
      {
        name: spec.workspaceId,
        display: this.numbers.display,
        profileDir: this.paths.profileDir,
        homeDir: this.paths.homeDir,
        cdpPort: this.numbers.cdpPort,
        runDir: this.paths.runDir,
        screen: spec.screen,
      },
      config,
      scoped,
    );
    // Chromium and x11vnc cannot outlive their X server: pause them while Xvfb is down, start them again when it is back.
    this.display = new Display(spec.workspaceId, this.numbers.displayNumber, spec.screen, config, scoped, this.paths.runDir, {
      onLost: () => {
        void this.browser.pause();
        void this.stream.pause();
      },
      onRestored: () => {
        this.browser.resume();
        this.stream.resume();
      },
    });
    this.typist = new TextInserter(this.numbers.cdpPort);
    this.files = new WorkspaceFiles(this.paths.filesDir, scoped);
    this.stream = new DisplayStream(spec.workspaceId, this.numbers.display, this.numbers.vncPort, this.numbers.bridgePort, this.paths.runDir, config, scoped);
  }

  info(): WorkspaceInfo {
    return {
      spec: this.spec,
      display: this.numbers.display,
      cdpUrl: `http://127.0.0.1:${this.numbers.cdpPort}`,
      filesDir: this.paths.filesDir,
      profileDir: this.paths.profileDir,
      appDataDir: join(this.config.dataDir, "shared", "app-data"),
      ...(this.display.busAddress ? { accessibilityBus: this.display.busAddress } : {}),
    };
  }

  get running(): boolean {
    return this.phase === "started";
  }

  async start(): Promise<void> {
    if (this.phase === "started") return;
    this.phase = "starting";
    mkdirSync(this.paths.filesDir, { recursive: true });
    try {
      await this.display.start(this.config.startTimeoutMs);
      this.browser.start();
      await this.browser.waitReady(this.config.startTimeoutMs);
      this.phase = "started";
    } catch (error) {
      await this.stop();
      throw error;
    }
  }

  async stop(): Promise<void> {
    await this.stream.stop();
    await this.browser.stop();
    await this.display.stop();
    this.phase = "stopped";
  }

  health(): WorkspaceHealth {
    if (this.phase === "stopped") return { workspaceId: this.spec.workspaceId, state: "stopped" };
    const processes = { display: this.display.xvfb.health(), windowManager: this.display.openbox.health(), browser: this.browser.health() };
    const allUp = Object.values(processes).every((p) => p.state === "running");
    const state = this.phase === "starting" ? "starting" : allUp ? "running" : "degraded";
    return { workspaceId: this.spec.workspaceId, state, processes };
  }

  openStream(mode: StreamMode): Promise<TakeoverTicket> {
    return this.stream.open(mode);
  }

  /** True while the display stream runs (someone watches or controls, or did a moment ago). */
  streamOpen(): boolean {
    return this.stream.isOpen();
  }

  closeStream(mode: StreamMode): Promise<boolean> {
    return this.stream.close(mode);
  }

  /** Types text into the focused page. Only while the person has taken over (a control ticket is valid). */
  async insertText(text: string): Promise<number> {
    if (!this.stream.controlOpen()) throw new OgbError("denied", "text can be inserted only while the workspace is taken over");
    return this.typist.insert(text);
  }

  /** Stops the display stream if nobody has watched for a while. */
  reapStream(): Promise<boolean> {
    return this.stream.reap();
  }

  /** The output of the last failed or running processes, for an error message: names no environment. */
  diagnostics(): string {
    return [this.display.xvfb, this.display.openbox, ...(this.display.bus ? [this.display.bus] : []), this.browser]
      .map((p) => `${p.name}: ${p.lastOutput().trim().slice(-200)}`)
      .join("\n");
  }
}
