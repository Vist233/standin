import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { createWorkspaceClient } from "@standin/workspace-client";
import { type HostHarness, workspaceHostContract } from "@standin/workspace-client/testing";
import { DeskHost } from "../src/host.ts";
import { serveWorkspaceHost } from "../src/server.ts";
import { stubConfig } from "../src/testing/index.ts";
import { silentLog, tempRoot } from "./helpers.ts";

const TICKET_MS = 1500;

/**
 * The shared contract suite (workspace-client/testing) against the real thing: the real `createWorkspaceClient`,
 * the daemon's own socket server, the real `DeskHost` over the stub programs. A "restart" stops every process and
 * starts a new host on the same socket; the client finds it again by itself.
 */
workspaceHostContract("real client, real daemon server, DeskHost over stub programs", async (): Promise<HostHarness> => {
  const root = tempRoot();
  mkdirSync(join(root.dir, "x"));
  const config = stubConfig({ dataDir: join(root.dir, "d"), socketPath: join(root.dir, "s"), x11Dir: join(root.dir, "x") }, { takeoverTtlMs: TICKET_MS });
  let desk = new DeskHost(config, silentLog);
  let server = await serveWorkspaceHost(desk, { socketPath: config.socketPath });
  const client = createWorkspaceClient({ socketPath: config.socketPath, backoffMs: 20 });
  return {
    host: client,
    // The daemon's tickets use the real clock: waiting out their life is the only way to expire one.
    advance: () => new Promise((resolve) => setTimeout(resolve, TICKET_MS + 200)),
    stop: async () => {
      await server.close();
      await desk.shutdown();
      desk = new DeskHost(config, silentLog);
      server = await serveWorkspaceHost(desk, { socketPath: config.socketPath });
    },
    cleanup: async () => {
      client.close();
      await server.close();
      await desk.shutdown();
      root.remove();
    },
  };
});
