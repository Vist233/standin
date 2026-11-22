import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { createWorkspaceClient } from "@standin/workspace-client";
import { afterEach, describe, expect, it } from "vitest";
import { MAX_FILE_BYTES } from "@standin/contracts";
import { DeskHost } from "../src/host.ts";
import { serveWorkspaceHost } from "../src/server.ts";
import { stubConfig } from "../src/testing/index.ts";
import { silentLog, tempRoot } from "./helpers.ts";

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  while (cleanups.length) await cleanups.pop()?.();
});

describe("files through the real client, server and DeskHost", () => {
  it("a file of exactly the limit goes in and comes out unchanged, and lands in the workspace's files directory", async () => {
    const root = tempRoot();
    mkdirSync(join(root.dir, "x"));
    const config = stubConfig({ dataDir: join(root.dir, "d"), socketPath: join(root.dir, "s"), x11Dir: join(root.dir, "x") });
    const desk = new DeskHost(config, silentLog);
    const server = await serveWorkspaceHost(desk, { socketPath: config.socketPath });
    const client = createWorkspaceClient({ socketPath: config.socketPath, requestTimeoutMs: 60_000 });
    cleanups.push(async () => {
      client.close();
      await server.close();
      await desk.shutdown();
      root.remove();
    });
    const info = await client.ensure({ workspaceId: "w1" });
    const content = new Uint8Array(MAX_FILE_BYTES).map((_, i) => (i * 31) % 251);
    const stored = await client.files.put("w1", "big.bin", content);
    expect(stored).toMatchObject({ name: "big.bin", size: MAX_FILE_BYTES });
    const back = await client.files.get("w1", "big.bin");
    expect(back.length).toBe(MAX_FILE_BYTES);
    expect(back.every((b, i) => b === content[i])).toBe(true);
    expect(info.filesDir).toContain("w1");
    await expect(client.files.put("w1", "bigger.bin", new Uint8Array(MAX_FILE_BYTES + 1))).rejects.toMatchObject({ kind: "invalid_input" });
  }, 60_000);
});
