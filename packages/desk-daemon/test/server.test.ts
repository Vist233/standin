import { mkdirSync, writeFileSync } from "node:fs";
import { connect } from "node:net";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { encodeLine, MAX_LINE_BYTES, parseResponse, WORKSPACE_PROTOCOL_VERSION } from "@standin/contracts";
import { respond, serveWorkspaceHost } from "../src/server.ts";
import { createWorkspaceClient } from "@standin/workspace-client";
import { createFakeWorkspaceHost } from "@standin/workspace-client/testing";
import { tempRoot } from "./helpers.ts";

let root: ReturnType<typeof tempRoot>;
const servers: Array<{ close(): void }> = [];
beforeEach(() => {
  root = tempRoot();
});
afterEach(() => {
  while (servers.length) servers.pop()?.close();
  root.remove();
});
const sock = () => join(root.dir, "s");

async function rawExchange(lines: string[]): Promise<string[]> {
  const server = await serveWorkspaceHost(createFakeWorkspaceHost({ root: join(root.dir, "ws") }), { socketPath: sock() });
  servers.push(server);
  const socket = connect(sock());
  servers.push({ close: () => socket.destroy() });
  socket.setEncoding("utf8");
  let received = "";
  socket.on("data", (c: string) => (received += c));
  await new Promise((r) => socket.once("connect", r));
  socket.write(lines.join("\n") + "\n");
  const want = lines.filter((l) => l.trim() !== "").length;
  for (let i = 0; i < 200 && received.split("\n").filter(Boolean).length < want; i++) await new Promise((r) => setTimeout(r, 10));
  return received.split("\n").filter(Boolean);
}

describe("protocol over the socket", () => {
  it("answers a malformed line with invalid_input and keeps the connection usable", async () => {
    const good = JSON.stringify({ v: 1, id: "7", method: "health", params: { workspaceId: "w" } });
    const [bad, ok] = (await rawExchange(["{nope", good])).map(parseResponse);
    expect(bad).toMatchObject({ ok: false, error: { kind: "invalid_input" } });
    expect(ok).toMatchObject({ id: "7", ok: true, result: { state: "absent" } });
  });

  it("echoes the id of a request that is invalid after the id", async () => {
    const [response] = (await rawExchange([JSON.stringify({ v: 1, id: "abc", method: "format-disk", params: {} })])).map(parseResponse);
    expect(response).toMatchObject({ id: "abc", ok: false, error: { kind: "invalid_input" } });
  });

  it("rejects params that are not { workspaceId }", async () => {
    const lines = [
      JSON.stringify({ v: 1, id: "1", method: "destroy", params: "w" }),
      JSON.stringify({ v: 1, id: "2", method: "health", params: { workspaceId: "../x" } }),
    ];
    for (const r of (await rawExchange(lines)).map(parseResponse)) expect(r).toMatchObject({ ok: false, error: { kind: "invalid_input" } });
  });

  it("reports a newer protocol version", async () => {
    const [r] = (await rawExchange([JSON.stringify({ v: 2, id: "1", method: "health", params: {} })])).map(parseResponse);
    expect(r).toMatchObject({ ok: false, error: { kind: "unsupported_version" } });
  });

  it("ignores empty lines", async () => {
    const lines = await rawExchange(["", JSON.stringify({ v: 1, id: "1", method: "health", params: { workspaceId: "w" } })]);
    expect(lines).toHaveLength(1);
  });

  it("ends a connection that sends a line without end that is too long", async () => {
    const server = await serveWorkspaceHost(createFakeWorkspaceHost({ root: join(root.dir, "ws") }), { socketPath: sock() });
    servers.push(server);
    const socket = connect(sock());
    let received = "";
    socket.setEncoding("utf8");
    socket.on("data", (c: string) => (received += c));
    await new Promise((r) => socket.once("connect", r));
    socket.write("x".repeat(MAX_LINE_BYTES + 10));
    await new Promise((r) => socket.once("close", r));
    expect(parseResponse(received.trim())).toMatchObject({ ok: false, error: { kind: "invalid_input" } });
  });

  it("serves overlapping requests on one connection", async () => {
    const server = await serveWorkspaceHost(createFakeWorkspaceHost({ root: join(root.dir, "ws") }), { socketPath: sock() });
    servers.push(server);
    const client = createWorkspaceClient({ socketPath: sock() });
    servers.push(client);
    const infos = await Promise.all(["a", "b", "c"].map((id) => client.ensure({ workspaceId: id })));
    expect(new Set(infos.map((i) => i.display)).size).toBe(3);
  });

  it("does not leak the text of an unexpected exception", async () => {
    const broken = createFakeWorkspaceHost({ root: join(root.dir, "ws") });
    broken.health = async () => {
      throw new Error("secret detail /Users/someone");
    };
    const response = await respond(broken, encodeLine({ v: WORKSPACE_PROTOCOL_VERSION, id: "1", method: "health", params: { workspaceId: "w" } }).trim());
    expect(JSON.stringify(response)).not.toContain("someone");
    expect(response).toMatchObject({ ok: false, error: { kind: "internal" } });
  });
});

describe("socket file", () => {
  it("replaces a stale socket file left by a dead daemon", async () => {
    mkdirSync(root.dir, { recursive: true });
    writeFileSync(sock(), "");
    servers.push(await serveWorkspaceHost(createFakeWorkspaceHost({ root: join(root.dir, "ws") }), { socketPath: sock() }));
    const client = createWorkspaceClient({ socketPath: sock() });
    servers.push(client);
    expect((await client.health("w")).state).toBe("absent");
  });

  it("refuses to take over the socket of a live daemon", async () => {
    servers.push(await serveWorkspaceHost(createFakeWorkspaceHost({ root: join(root.dir, "ws") }), { socketPath: sock() }));
    await expect(serveWorkspaceHost(createFakeWorkspaceHost({ root: join(root.dir, "ws") }), { socketPath: sock() })).rejects.toMatchObject({
      kind: "conflict",
    });
  });

  it("is private to the owner (mode 600)", async () => {
    servers.push(await serveWorkspaceHost(createFakeWorkspaceHost({ root: join(root.dir, "ws") }), { socketPath: sock() }));
    const { statSync } = await import("node:fs");
    expect(statSync(sock()).mode & 0o777).toBe(0o600);
  });
});
