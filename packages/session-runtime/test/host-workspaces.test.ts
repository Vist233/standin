import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { isOgbError } from "@standin/contracts";
import { createSocketRig } from "@standin/workspace-client/testing";
import { afterEach, describe, expect, it } from "vitest";
import { createHostWorkspaces, workspaceIdFor } from "../src/index.ts";
import { createRig, lastUserText } from "../src/testing/index.ts";

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup();
});

describe("workspace ids", () => {
  it("maps session ids without ever shortening or hashing", () => {
    expect(workspaceIdFor("s_26AA138d7a1f")).toBe("s-26aa138d7a1f");
    expect(workspaceIdFor("abc")).toBe("abc");
    expect(() => workspaceIdFor("x".repeat(33))).toThrow(/cannot be used as a workspace id/);
    expect(() => workspaceIdFor("a.b")).toThrow();
    try {
      workspaceIdFor("a b");
    } catch (error) {
      expect(isOgbError(error, "invalid_input")).toBe(true);
    }
  });
});

describe("the runtime on a workspace host reached through the socket client", () => {
  it("creates the workspace for a session, uses its files directory, and removes it on delete", async () => {
    const socket = await createSocketRig();
    cleanups.push(socket.cleanup);
    const rig = createRig({ script: (request) => ({ text: `echo ${lastUserText(request)}` }), runtime: { workspaces: createHostWorkspaces(socket.client) } });
    cleanups.push(rig.cleanup);

    const { id } = await rig.runtime.createSession({ title: "On the daemon" });
    const workspaceId = workspaceIdFor(id);
    expect((await socket.client.health(workspaceId)).state).toBe("running");
    const files = join(socket.root, "ws", workspaceId, "files");
    expect(readFileSync(join(files, "AGENTS.md"), "utf8")).toContain("Session name: On the daemon");

    await rig.runtime.send(id, "hi");
    await rig.runtime.whenIdle(id);

    // The daemon restarts (connections drop); the next ensure at reopen works and the same workspace is used.
    socket.server.dropConnections();
    await rig.runtime.closeSession(id);
    await rig.runtime.openSession(id);
    expect(socket.server.requests.filter((r) => r.method === "ensure").length).toBeGreaterThanOrEqual(2);

    await rig.runtime.deleteSession(id);
    expect((await socket.client.health(workspaceId)).state).toBe("absent");
    expect(existsSync(join(rig.root, "sessions", id))).toBe(false);
  });
});
