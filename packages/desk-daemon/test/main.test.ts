import { type ChildProcess, spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { createWorkspaceClient } from "@standin/workspace-client";
import { eventually, tempRoot } from "./helpers.ts";

const main = fileURLToPath(new URL("../src/main.ts", import.meta.url));
let child: ChildProcess | undefined;
afterEach(() => {
  child?.kill("SIGKILL");
});

describe("the desk-daemon program", () => {
  it("serves the protocol on the configured socket, reports a missing Xvfb as unavailable, and exits 0 on SIGTERM", async () => {
    const root = tempRoot();
    const socketPath = join(root.dir, "run", "d.sock");
    child = spawn(process.execPath, [main], {
      env: { PATH: "/nonexistent", OGB_DESK_DATA_DIR: join(root.dir, "data"), OGB_DESK_SOCKET: socketPath, OGB_X11_DIR: root.dir, OGB_MAX_WORKSPACES: "2" },
      stdio: ["ignore", "ignore", "pipe"],
    });
    let log = "";
    child.stderr?.on("data", (c: Buffer) => (log += c.toString()));
    const exited = new Promise<number | null>((resolve) => child?.once("exit", resolve));
    await eventually(
      () => existsSync(socketPath),
      (ok) => ok,
    );
    const client = createWorkspaceClient({ socketPath, retries: 0 });
    expect(await client.health("w1")).toEqual({ workspaceId: "w1", state: "absent" });
    await expect(client.ensure({ workspaceId: "w1" })).rejects.toMatchObject({ kind: "unavailable" });
    client.close();
    child.kill("SIGTERM");
    expect(await exited).toBe(0);
    expect(log).toContain('"module":"desk-daemon"');
    expect(log).not.toContain("OGB_DESK_DATA_DIR");
    root.remove();
  });

  it("exits with 1 and a message when the socket is already served", async () => {
    const root = tempRoot();
    const env = { PATH: "/nonexistent", OGB_DESK_DATA_DIR: join(root.dir, "data"), OGB_DESK_SOCKET: join(root.dir, "d.sock"), OGB_X11_DIR: root.dir };
    child = spawn(process.execPath, [main], { env, stdio: "ignore" });
    await eventually(
      () => existsSync(env.OGB_DESK_SOCKET),
      (ok) => ok,
    );
    const second = spawn(process.execPath, [main], { env, stdio: ["ignore", "ignore", "pipe"] });
    let message = "";
    second.stderr?.on("data", (c: Buffer) => (message += c.toString()));
    expect(await new Promise((resolve) => second.once("exit", resolve))).toBe(1);
    expect(message).toContain("another daemon");
    root.remove();
  });
});
