import type { StartupLine, WorkspaceHost } from "@vesper/contracts";
import type { SessionRuntime } from "@vesper/session-runtime";

/** The part of the session runtime the gateway uses. A fake with these methods is enough to test it. */
/** A file the person attached to a message: it is already in the workspace's files directory. */
export interface Attachment {
  name: string;
  size: number;
}

export type GatewayRuntime = Omit<
  Pick<
    SessionRuntime,
    | "createSession"
    | "updateSession"
    | "openSession"
    | "list"
    | "send"
    | "stop"
    | "status"
    | "events"
    | "read"
    | "pendingApprovals"
    | "decideApproval"
    | "deleteSession"
    | "openTakeover"
    | "reportTakeoverViewer"
    | "closeTakeover"
    | "takeoverState"
    | "receiveHook"
  >,
  "send"
> & {
  send(sessionId: string, text: string, id?: string, attachments?: Attachment[]): Promise<void>;
};

/** What the new-session form may offer. The gateway does not know models or profiles; whoever builds it passes the names. */
export interface Catalog {
  profiles: string[];
  defaultProfile?: string;
  models: string[];
}

export interface GatewayLimits {
  /** Largest request body in bytes. Default 64 KiB. */
  maxBodyBytes: number;
  /** Most event streams open at once. Default 200. */
  maxStreams: number;
  /** A client that does not read for this long is dropped (it reconnects with Last-Event-ID). Default 30 s. */
  slowClientMs: number;
  /** A comment line every this many ms keeps proxies and the page's idle timer quiet. Default 15 s. */
  heartbeatMs: number;
  /** Largest file the page may upload, in bytes. Default 25 MB. */
  maxFileBytes: number;
  /** Most files in one session's files directory that the page may add. Default 20. */
  maxFiles: number;
  /** Lifetime of a one-time WebSocket ticket. Default 30 s. */
  ticketMs: number;
  /** Most relayed WebSocket connections at once. Default 32. */
  maxRelays: number;
}

export interface GatewayOptions {
  runtime: GatewayRuntime;
  /** Needed for the live view and take-over (`view.open`, `takeover.open`); without it those endpoints answer `unavailable`. */
  workspaces?: WorkspaceHost;
  /** Lines of the start-up report (what is not up); read at every `/api/options`. */
  startup?: () => StartupLine[];
  catalog?: () => Catalog | Promise<Catalog>;
  /** The directory of the page (`packages/web/src`). Without it only the API is served. */
  staticDir?: string;
  /** When set, every API call needs `Authorization: Bearer <token>`. Required when listening on a non-loopback address. */
  token?: string;
  /**
   * Allows listening on a non-loopback address WITHOUT a bearer token. For one case only: the box's container, whose port is
   * published to the host's loopback by the container runtime (so "one local port, no login" still holds). The Host and Origin
   * checks stay on. The gateway logs a warning when it starts this way. Never set it for a port that others can reach.
   */
  openListen?: boolean;
  /** Host names (no port) accepted in the Host header besides the loopback names. */
  extraHosts?: string[];
  /** False while the runtime is still starting; the page shows it. Default: always ready. */
  ready?: () => boolean;
  limits?: Partial<GatewayLimits>;
  log?: (entry: Record<string, unknown>) => void;
  now?: () => number;
}

export interface Gateway {
  /** Starts listening. Loopback by default; any other address needs a token. Resolves with the bound port. */
  listen(options?: { port?: number; host?: string }): Promise<{ host: string; port: number }>;
  /** Ends event streams and relays, then stops listening. */
  close(): Promise<void>;
}
