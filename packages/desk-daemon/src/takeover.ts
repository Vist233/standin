import { randomBytes } from "node:crypto";
import { connect } from "node:net";
import { join } from "node:path";
import type { PluginLogger, StreamMode, TakeoverTicket } from "@standin/contracts";
import type { DaemonConfig } from "./config.ts";
import { SupervisedProcess } from "./supervisor.ts";
import { type Bridge, startBridge, tokensEqual } from "./ws-bridge.ts";

const MODES: readonly StreamMode[] = ["view", "control"];

// Tuned for a desktop that is mostly still (docs/11 section 5): -wait/-defer 66 ms cap the update rate; -nocursorshape
// and friends keep the stream to plain pixels; -nowf -noscr -noxrecord -noncache -nobell -nodpms -nosel remove work
// the page never uses. XDAMAGE stays on (changed regions only) and there is no -repeat.
const X11VNC_FLAGS = [
  "-localhost",
  "-no6",
  "-nopw",
  "-forever",
  "-shared",
  "-quiet",
  "-norc",
  "-nolookup",
  "-wait",
  "66",
  "-defer",
  "66",
  "-rfbwait",
  "30000",
  "-nocursorshape",
  "-nocursorpos",
  "-cursor",
  "arrow",
  "-nowf",
  "-noscr",
  "-noxrecord",
  "-noncache",
  "-nobell",
  "-nodpms",
  "-nosel",
];

function portAnswers(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = connect({ host: "127.0.0.1", port });
    socket.once("connect", () => {
      socket.destroy();
      resolve(true);
    });
    socket.once("error", () => resolve(false));
  });
}

/**
 * The picture of one workspace's whole display (docs/11 D1 to D3): one x11vnc on the display (loopback only) and a
 * token-gated WebSocket bridge in front of it, shared by two kinds of ticket. A `view` ticket opens a filtered
 * connection (no keys, no pointer), a `control` ticket a raw one. Both infrastructure pieces start with the first
 * ticket and stop with the last, or 60 s after the last connection left (`reap`, called by the host inside the
 * workspace's operation queue so it cannot race an `open`).
 */
export class DisplayStream {
  private infra: { x11vnc: SupervisedProcess; bridge: Bridge } | null = null;
  private starting: Promise<void> | null = null;
  private readonly tickets: Partial<Record<StreamMode, TakeoverTicket>> = {};
  private idleSince: number | null = null;

  private readonly workspaceId: string;
  private readonly display: string;
  private readonly vncPort: number;
  private readonly bridgePort: number;
  private readonly runDir: string;
  private readonly config: DaemonConfig;
  private readonly log: PluginLogger;
  private readonly now: () => number;

  constructor(
    workspaceId: string,
    display: string,
    vncPort: number,
    bridgePort: number,
    runDir: string,
    config: DaemonConfig,
    log: PluginLogger,
    now: () => number = Date.now,
  ) {
    this.workspaceId = workspaceId;
    this.display = display;
    this.vncPort = vncPort;
    this.bridgePort = bridgePort;
    this.runDir = runDir;
    this.config = config;
    this.log = log;
    this.now = now;
  }

  /** True while a control ticket is valid: the person has taken over this workspace. */
  controlOpen(): boolean {
    const ticket = this.tickets.control;
    return ticket !== undefined && ticket.expiresAt > this.now();
  }

  isOpen(): boolean {
    return this.infra !== null;
  }

  /** Idempotent: a valid ticket of this mode is returned again; an expired one is replaced by a new token on the same bridge. */
  async open(mode: StreamMode): Promise<TakeoverTicket> {
    this.starting ??= this.start().finally(() => {
      this.starting = null;
    });
    await this.starting;
    // A ticket handed out starts the idle clock again, so the reaper cannot take the stream away from the one who just asked.
    if (this.connectionCount() === 0) this.idleSince = this.now();
    const live = this.tickets[mode];
    if (live && live.expiresAt > this.now()) return live;
    const ticket: TakeoverTicket = {
      workspaceId: this.workspaceId,
      mode,
      host: "127.0.0.1",
      port: this.bridgePort,
      token: randomBytes(32).toString("hex"),
      expiresAt: this.now() + this.config.takeoverTtlMs,
    };
    this.tickets[mode] = ticket;
    return ticket;
  }

  /** Revokes this mode's token and drops its connections; stops the stream when no mode is left. True when a valid ticket was open. */
  async close(mode: StreamMode): Promise<boolean> {
    if (this.starting) await this.starting.catch(() => undefined);
    const ticket = this.tickets[mode];
    delete this.tickets[mode];
    this.infra?.bridge.drop(mode);
    if (MODES.every((m) => this.tickets[m] === undefined)) await this.stopInfra();
    return Boolean(ticket && ticket.expiresAt > this.now());
  }

  /** Stops both modes and the stream. */
  async stop(): Promise<void> {
    for (const mode of MODES) delete this.tickets[mode];
    await this.stopInfra();
  }

  /** Stops the stream when it has had no connection for `streamIdleMs`. True when it did. */
  async reap(): Promise<boolean> {
    if (!this.infra || this.starting || this.connectionCount() > 0) return false;
    if (this.idleSince === null || this.now() - this.idleSince < this.config.streamIdleMs) return false;
    this.log.info("display stream stopped: no connection for a while");
    await this.stop();
    return true;
  }

  /** The display is gone (Xvfb died): x11vnc cannot run without it, so it waits instead of restarting in a loop. */
  async pause(): Promise<void> {
    await this.infra?.x11vnc.pause();
  }

  resume(): void {
    this.infra?.x11vnc.resume();
  }

  private connectionCount(): number {
    const { control, view } = this.infra?.bridge.connections() ?? { control: 0, view: 0 };
    return control + view;
  }

  private authorize(token: string): StreamMode | null {
    let found: StreamMode | null = null;
    for (const mode of MODES) {
      const ticket = this.tickets[mode];
      if (ticket && ticket.expiresAt > this.now() && tokensEqual(token, ticket.token)) found = mode;
    }
    return found;
  }

  private async stopInfra(): Promise<void> {
    const infra = this.infra;
    if (!infra) return;
    this.infra = null;
    this.idleSince = null;
    await infra.bridge.close();
    await infra.x11vnc.stop();
  }

  private async start(): Promise<void> {
    if (this.infra) return;
    const x11vnc = new SupervisedProcess({
      spec: {
        name: `x11vnc-${this.workspaceId}`,
        command: this.config.x11vnc.command,
        args: [...(this.config.x11vnc.args ?? []), "-display", this.display, "-rfbport", String(this.vncPort), ...X11VNC_FLAGS],
        env: { OGB_X11_DIR: this.config.x11Dir },
      },
      log: this.log,
      pidFile: join(this.runDir, "x11vnc.pid"),
      backoff: this.config.backoff,
      probe: () => portAnswers(this.vncPort),
      probeIntervalMs: this.config.probeIntervalMs,
    });
    x11vnc.start();
    try {
      await x11vnc.waitReady(this.config.startTimeoutMs);
      const bridge = await startBridge({
        port: this.bridgePort,
        targetPort: this.vncPort,
        authorize: (token) => this.authorize(token),
        filterView: this.config.viewFilter === "on",
        onViolation: (detail) => this.log.warn("a view-only client sent a message that is not allowed; connection closed", { detail }),
        onChange: () => {
          this.idleSince = this.connectionCount() === 0 ? this.now() : null;
        },
      });
      this.infra = { x11vnc, bridge };
    } catch (error) {
      await x11vnc.stop();
      throw error;
    }
  }
}
