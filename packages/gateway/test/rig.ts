import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { checkInsertText, type OgbError, type TakeoverTicket, type WorkspaceHost } from "@standin/contracts";
import { createFakeWorkspaceHost, type FakeWorkspaceHost } from "@standin/workspace-client/testing";
import { workspaceIdFor } from "@standin/session-runtime";
import { createGateway, type Gateway, type GatewayOptions } from "../src/index.ts";
import { createFakeRuntime, type EchoServer, type FakeRuntime, type Probe, startEchoUpgradeServer, startProbe } from "../src/testing/index.ts";

export interface GatewayRig {
  runtime: FakeRuntime;
  host: FakeWorkspaceHost;
  /** What the gateway asked of the workspace host, as `method:workspace`. */
  hostCalls: string[];
  /** The text the host was asked to type (kept apart from `hostCalls`, which never holds text). */
  typed: string[];
  /** Makes the next `input.insertText` fail. */
  failInsert(error: OgbError): void;
  gateway: Gateway;
  port: number;
  probe: Probe;
  staticDir: string;
  root: string;
  clock: { time: number };
  logs: Record<string, unknown>[];
  bridge: EchoServer;
  cleanup(): Promise<void>;
}

/** A gateway over a fake runtime, a fake workspace host and an echo server that stands in for the desk-daemon's display stream. */
export type RigOptions = { [K in keyof GatewayOptions]?: GatewayOptions[K] | undefined } & { probeHeaders?: Record<string, string> };

export async function startRig(options: RigOptions = {}): Promise<GatewayRig> {
  const root = mkdtempSync(join(tmpdir(), "ogb-gw-"));
  const staticDir = join(root, "site");
  mkdirSync(join(staticDir, "sub"), { recursive: true });
  writeFileSync(join(staticDir, "index.html"), "<!doctype html><title>page</title>");
  writeFileSync(join(staticDir, "app.js"), "export {};");
  writeFileSync(join(staticDir, "sub", "a.css"), "body{}");
  writeFileSync(join(staticDir, ".secret.txt"), "hidden");
  writeFileSync(join(staticDir, "data.bin"), "bin");
  writeFileSync(join(root, "outside.txt"), "outside");
  symlinkSync(join(root, "outside.txt"), join(staticDir, "link.txt"));

  const runtime = createFakeRuntime();
  const clock = { time: 1_000_000 };
  const host = createFakeWorkspaceHost({ root: join(root, "ws"), now: () => clock.time });
  const bridge = await startEchoUpgradeServer({ requireToken: "daemon-token" });
  const logs: Record<string, unknown>[] = [];
  const hostCalls: string[] = [];
  const typed: string[] = [];
  let insertFailure: OgbError | undefined;
  // The fake host decides whether a workspace exists; the bridge it announces is replaced by the rig's echo server.
  const workspaces: WorkspaceHost = {
    ensure: (spec) => host.ensure(spec),
    destroy: (id) => host.destroy(id),
    health: (id) => host.health(id),
    takeover: {
      async open(id): Promise<TakeoverTicket> {
        hostCalls.push(`open:${id}`);
        const ticket = await host.takeover.open(id);
        return { ...ticket, port: bridge.port, token: "daemon-token" };
      },
      async close(id) {
        hostCalls.push(`close:${id}`);
        return host.takeover.close(id);
      },
    },
    input: {
      async insertText(id, text) {
        const checked = checkInsertText(text);
        hostCalls.push(`insertText:${id}:${[...checked].length}`);
        typed.push(checked);
        if (insertFailure) throw insertFailure;
        return { inserted: [...checked].length };
      },
    },
    files: host.files,
    view: {
      async open(id): Promise<TakeoverTicket> {
        hostCalls.push(`view:${id}`);
        const ticket = await host.view.open(id);
        return { ...ticket, port: bridge.port, token: "daemon-token" };
      },
    },
  };
  const { probeHeaders, ...rest } = options;
  const gateway = createGateway({
    runtime,
    workspaces,
    catalog: () => ({ profiles: ["general"], defaultProfile: "general", models: ["main"] }),
    staticDir,
    log: (entry) => logs.push(entry),
    now: () => clock.time,
    ...rest,
  } as GatewayOptions);
  const { port } = await gateway.listen();
  return {
    runtime,
    host,
    hostCalls,
    typed,
    failInsert(error) {
      insertFailure = error;
    },
    gateway,
    port,
    probe: startProbe(port, probeHeaders),
    staticDir,
    root,
    clock,
    logs,
    bridge,
    async cleanup() {
      await gateway.close();
      await bridge.stop();
      rmSync(root, { recursive: true, force: true });
    },
  };
}

/** Makes the workspace of a session exist in the fake host, as the runtime does when it opens the session. */
export async function ensureWorkspace(rig: GatewayRig, sessionId: string): Promise<void> {
  await rig.host.ensure({ workspaceId: workspaceIdFor(sessionId) });
}
