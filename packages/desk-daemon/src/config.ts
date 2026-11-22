import type { Backoff } from "./supervisor.ts";
import { DEFAULT_BACKOFF } from "./supervisor.ts";

/** How to start a program: tests point these at stub scripts, the image at the real binaries. */
export interface Launcher {
  readonly command: string;
  readonly args?: readonly string[];
}

export interface DaemonConfig {
  /** Everything the daemon stores: one directory per workspace (record, files, browser profile). */
  readonly dataDir: string;
  /** The Unix socket the protocol is served on. */
  readonly socketPath: string;
  /** Where X servers put their sockets. */
  readonly x11Dir: string;
  readonly xvfb: Launcher;
  readonly openbox: Launcher;
  readonly chromium: Launcher;
  readonly x11vnc: Launcher;
  /**
   * A D-Bus session per display, where desktop programs publish their widgets (the accessibility tree the agent's computer tool reads; the
   * AT-SPI service is started by D-Bus activation). Absent: no bus, and programs publish nothing.
   */
  readonly accessibilityBus?: Launcher;
  /** Chromium refuses to run as root without it; the container runs as root. */
  readonly noSandbox: boolean;
  /** Most workspaces running at once (memory is the limit: about 320 MiB each, docs/11 D10); more may exist stopped. */
  readonly maxWorkspaces: number;
  readonly takeoverTtlMs: number;
  /** The display stream (x11vnc and its bridge) stops after this long without a connection. */
  readonly streamIdleMs: number;
  /** `off` makes a view connection a raw pipe like control (a smoke-test escape if the filter closes an honest noVNC; docs/11 section 7). Default `on`. */
  readonly viewFilter: "on" | "off";
  /** How often the host looks for display streams to stop. */
  readonly reapIntervalMs: number;
  /** How often the browsers' cookies are made equal (one set of logins for every session); 0 turns the sharing off. */
  readonly loginSyncMs: number;
  readonly backoff: Backoff;
  readonly probeIntervalMs: number;
  readonly startTimeoutMs: number;
  /** Added to the three port bases; tests that run side by side on one machine use different shifts. */
  readonly portShift: number;
}

export const SLOT_COUNT = 100;
/** One slot per workspace fixes all of its numbers, so they are the same after every restart. */
const SLOT_BASE = { display: 100, cdpPort: 9300, vncPort: 5900, bridgePort: 6900 } as const;

export function defaultConfig(overrides: Partial<DaemonConfig> & Pick<DaemonConfig, "dataDir" | "socketPath">): DaemonConfig {
  return {
    x11Dir: "/tmp/.X11-unix",
    xvfb: { command: "Xvfb" },
    openbox: { command: "openbox" },
    chromium: { command: "chromium" },
    x11vnc: { command: "x11vnc" },
    noSandbox: typeof process.getuid === "function" && process.getuid() === 0,
    maxWorkspaces: 8,
    takeoverTtlMs: 5 * 60_000,
    streamIdleMs: 60_000,
    viewFilter: "on",
    reapIntervalMs: 5000,
    loginSyncMs: 5000,
    backoff: DEFAULT_BACKOFF,
    probeIntervalMs: 2000,
    startTimeoutMs: 30_000,
    portShift: 0,
    ...overrides,
  };
}

export interface SlotNumbers {
  readonly slot: number;
  readonly displayNumber: number;
  readonly display: string;
  readonly cdpPort: number;
  readonly vncPort: number;
  readonly bridgePort: number;
}

export function slotNumbers(slot: number, portShift = 0): SlotNumbers {
  const displayNumber = SLOT_BASE.display + slot;
  return {
    slot,
    displayNumber,
    display: `:${displayNumber}`,
    cdpPort: SLOT_BASE.cdpPort + portShift + slot,
    vncPort: SLOT_BASE.vncPort + portShift + slot,
    bridgePort: SLOT_BASE.bridgePort + portShift + slot,
  };
}

/** Reads `OGB_DESK_VIEW_FILTER` (`on` or `off`); anything else is an error, because a typo must not silently switch the filter off. */
export function parseViewFilter(value: string | undefined): "on" | "off" {
  if (value === undefined || value === "" || value === "on") return "on";
  if (value === "off") return "off";
  throw new Error("OGB_DESK_VIEW_FILTER must be 'on' or 'off'");
}
