import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { checkInsertText, type TakeoverTicket, type WorkspaceHost } from "@standin/contracts";
import { createGateway, type Gateway, type GatewayOptions } from "@standin/gateway";
import { createFakeRuntime, type FakeRuntime } from "@standin/gateway/testing";
import { workspaceIdFor } from "@standin/session-runtime";
import { createFakeWorkspaceHost, type FakeWorkspaceHost } from "@standin/workspace-client/testing";
import { type FakeDesktop, startFakeDesktop } from "./rfb-server.ts";

export interface Harness {
  url: string;
  port: number;
  runtime: FakeRuntime;
  host: FakeWorkspaceHost;
  desktop: FakeDesktop;
  /** What the gateway asked of the workspace host, as `method:workspace`. */
  hostCalls: string[];
  /** Text the host was asked to type into the page (the stand-in for Chrome's `Input.insertText`). */
  typed: string[];
  /** Stops the gateway only (the box restarts but the sessions and the desktop go on). */
  stopGateway(): Promise<void>;
  startGateway(): Promise<void>;
  /** Makes a session known to the fake runtime and its workspace known to the fake host. */
  addSession(id: string, title?: string): Promise<void>;
  stop(): Promise<void>;
}

export const WEB_DIR = new URL("../../packages/web/src/", import.meta.url).pathname;

/** The gateway with the real page over a fake runtime, a fake workspace host and a fake desktop that speaks RFB, for browser tests and for looking at the page by hand. */
export async function startHarness(options: Partial<GatewayOptions> & { port?: number } = {}): Promise<Harness> {
  const root = mkdtempSync(join(tmpdir(), "ogb-web-"));
  mkdirSync(root, { recursive: true });
  const runtime = createFakeRuntime();
  const host = createFakeWorkspaceHost({ root: join(root, "ws") });
  const desktop = await startFakeDesktop();
  const hostCalls: string[] = [];
  const typed: string[] = [];
  // The fake host decides whether a workspace exists; the stream it announces is replaced by the fake desktop.
  const redirect = async (ticket: TakeoverTicket): Promise<TakeoverTicket> => ({ ...ticket, port: desktop.port, token: desktop.token });
  const workspaces: WorkspaceHost = {
    ensure: (spec) => host.ensure(spec),
    destroy: (id) => host.destroy(id),
    health: (id) => host.health(id),
    takeover: {
      open: async (id) => {
        hostCalls.push(`takeover.open:${id}`);
        return redirect(await host.takeover.open(id));
      },
      close: async (id) => {
        hostCalls.push(`takeover.close:${id}`);
        return host.takeover.close(id);
      },
    },
    input: {
      insertText: async (id, text) => {
        const checked = checkInsertText(text);
        hostCalls.push(`input.insertText:${id}`);
        typed.push(checked);
        return { inserted: [...checked].length };
      },
    },
    files: host.files,
    view: {
      open: async (id) => {
        hostCalls.push(`view.open:${id}`);
        return redirect(await host.view.open(id));
      },
    },
  };
  const { port: wantedPort, ...rest } = options;
  const make = (): Gateway =>
    createGateway({
      runtime,
      workspaces,
      catalog: () => ({ profiles: ["general", "operator"], defaultProfile: "general", models: ["main", "small"] }),
      staticDir: WEB_DIR,
      ...rest,
    } as GatewayOptions);
  let gateway = make();
  let port = wantedPort ?? 0;
  port = (await gateway.listen({ port })).port;
  return {
    get url() {
      return `http://127.0.0.1:${port}`;
    },
    get port() {
      return port;
    },
    runtime,
    host,
    desktop,
    hostCalls,
    typed,
    async stopGateway() {
      await gateway.close();
    },
    async startGateway() {
      gateway = make();
      await gateway.listen({ port });
    },
    async addSession(id, title) {
      runtime.add(id, title);
      await host.ensure({ workspaceId: workspaceIdFor(id) });
    },
    async stop() {
      await gateway.close();
      await desktop.stop();
      rmSync(root, { recursive: true, force: true });
    },
  };
}
