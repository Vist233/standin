import { existsSync, rmSync } from "node:fs";
import { join } from "node:path";
import type { PluginLogger, ScreenSize } from "@vesper/contracts";
import type { DaemonConfig } from "./config.ts";
import { SupervisedProcess } from "./supervisor.ts";

export interface DisplayCallbacks {
  /** Xvfb died without being asked to; everything that draws on it must stop until it is back. */
  onLost(): void;
  /** Xvfb is up again after a death. */
  onRestored(): void;
}

/**
 * One workspace's X server (Xvfb) and window manager (openbox). The window manager is useful for real
 * windows (file dialogs, browser menus) and is restarted alone when it dies; Xvfb is the root of everything,
 * so when it dies the dependents are paused through the callbacks.
 */
export class Display {
  readonly xvfb: SupervisedProcess;
  readonly openbox: SupervisedProcess;
  /** The display's D-Bus session for the accessibility tree, and its address; absent when the configuration has none. */
  readonly bus?: SupervisedProcess;
  readonly busAddress?: string;
  readonly socketPath: string;
  readonly number: number;

  constructor(name: string, number: number, screen: ScreenSize, config: DaemonConfig, log: PluginLogger, runDir: string, callbacks: DisplayCallbacks) {
    this.number = number;
    this.socketPath = join(config.x11Dir, `X${number}`);
    const display = `:${number}`;
    const lockFile = `/tmp/.X${number}-lock`;
    this.xvfb = new SupervisedProcess({
      spec: {
        name: `xvfb-${name}`,
        command: config.xvfb.command,
        args: [...(config.xvfb.args ?? []), display, "-screen", "0", `${screen.width}x${screen.height}x24`, "-nolisten", "tcp", "-noreset"],
        env: { OGB_X11_DIR: config.x11Dir },
      },
      log,
      pidFile: join(runDir, "xvfb.pid"),
      backoff: config.backoff,
      probe: async () => existsSync(this.socketPath),
      probeIntervalMs: config.probeIntervalMs,
      // A killed Xvfb leaves its socket and lock file; a new one must not meet them.
      beforeStart: () => {
        rmSync(this.socketPath, { force: true });
        rmSync(lockFile, { force: true });
      },
      onUnexpectedExit: () => {
        void this.openbox.pause();
        callbacks.onLost();
      },
      onReady: ({ restart }) => {
        if (!restart) return;
        this.openbox.resume();
        callbacks.onRestored();
      },
    });
    this.openbox = new SupervisedProcess({
      spec: {
        name: `openbox-${name}`,
        command: config.openbox.command,
        args: [...(config.openbox.args ?? [])],
        env: { DISPLAY: display, OGB_X11_DIR: config.x11Dir },
      },
      log,
      pidFile: join(runDir, "openbox.pid"),
      backoff: config.backoff,
    });
    if (config.accessibilityBus) {
      const socket = join(runDir, "a11y-bus");
      this.busAddress = `unix:path=${socket}`;
      this.bus = new SupervisedProcess({
        spec: {
          name: `a11y-bus-${name}`,
          command: config.accessibilityBus.command,
          args: [...(config.accessibilityBus.args ?? []), "--session", "--nofork", "--nopidfile", `--address=${this.busAddress}`],
          env: { DISPLAY: display, OGB_X11_DIR: config.x11Dir }, // what it starts (the AT-SPI service) registers with this display
        },
        log,
        pidFile: join(runDir, "a11y-bus.pid"),
        backoff: config.backoff,
        probe: async () => existsSync(socket),
        probeIntervalMs: config.probeIntervalMs,
        beforeStart: () => rmSync(socket, { force: true }),
      });
    }
  }

  async start(timeoutMs: number): Promise<void> {
    this.xvfb.start();
    await this.xvfb.waitReady(timeoutMs);
    this.openbox.start();
    if (this.bus) {
      this.bus.start();
      await this.bus.waitReady(timeoutMs);
    }
  }

  async stop(): Promise<void> {
    await this.bus?.stop();
    await this.openbox.stop();
    await this.xvfb.stop();
  }
}
