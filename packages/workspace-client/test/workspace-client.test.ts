import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { isOgbError } from "@standin/contracts";
import { afterEach, describe, expect, it } from "vitest";
import { createWorkspaceClient } from "../src/index.ts";
import { createFakeWorkspaceHost, createSocketRig, type HostHarness, workspaceHostContract } from "../src/testing/index.ts";

const rigs: { cleanup(): Promise<void> }[] = [];
afterEach(async () => {
  for (const r of rigs.splice(0)) await r.cleanup();
});
const kind = (k: string) => (e: unknown) => isOgbError(e, k as never);

workspaceHostContract("fake host", async () => {
  const root = mkdtempSync(join(tmpdir(), "ogb-fakehost-"));
  const clock = { time: 1_000_000 };
  const host = createFakeWorkspaceHost({ root, now: () => clock.time });
  const harness: HostHarness = {
    host,
    advance: (ms) => {
      clock.time += ms;
    },
    stop: (id) => host.stop(id),
    cleanup: async () => rmSync(root, { recursive: true, force: true }),
  };
  return harness;
});

workspaceHostContract("client over a Unix socket to the fake host", async () => {
  const rig = await createSocketRig();
  return {
    host: rig.client,
    advance: (ms) => {
      rig.clock.time += ms;
    },
    stop: (id) => rig.fake.stop(id),
    cleanup: rig.cleanup,
  };
});

describe("workspace client: connection handling", () => {
  it("opens the connection on first use and shares it between overlapping calls", async () => {
    const rig = await createSocketRig();
    rigs.push(rig);
    const results = await Promise.all(["a", "b", "c", "d"].map((id) => rig.client.ensure({ workspaceId: `ws-${id}` })));
    expect(results.map((r) => r.spec.workspaceId)).toEqual(["ws-a", "ws-b", "ws-c", "ws-d"]);
    expect(rig.server.requests).toHaveLength(4);
  });

  it("goes on after the daemon restarts: the dropped connection is opened again and the call repeated", async () => {
    const rig = await createSocketRig();
    rigs.push(rig);
    await rig.client.ensure({ workspaceId: "ws-1" });
    rig.server.dropConnections();
    expect((await rig.client.health("ws-1")).state).toBe("running"); // the fake's state survived, as desktops survive a daemon restart
  });

  it("waits through a daemon that is down for a while and then comes back", async () => {
    let sleeps = 0;
    const rig = await createSocketRig({
      sleep: async () => {
        sleeps += 1;
        if (sleeps === 2) await rig.server.start();
      },
    });
    rigs.push(rig);
    await rig.client.ensure({ workspaceId: "ws-1" });
    await rig.server.stop();
    const result = await rig.client.health("ws-1");
    expect(result.state).toBe("running");
    expect(sleeps).toBeGreaterThanOrEqual(2);
  });

  it("gives up with unavailable after the retries, saying how many tries it made", async () => {
    const rig = await createSocketRig({ retries: 2 });
    rigs.push(rig);
    await rig.server.stop();
    const failure = rig.client.health("ws-1");
    await expect(failure).rejects.toSatisfy(kind("unavailable"));
    await expect(failure).rejects.toThrow(/gave up after 3 tries/);
  });

  it("does not repeat a call the daemon answered with an error", async () => {
    const rig = await createSocketRig();
    rigs.push(rig);
    await rig.client.ensure({ workspaceId: "ws-1" });
    await expect(rig.client.ensure({ workspaceId: "ws-1", screen: { width: 800, height: 600 } })).rejects.toSatisfy(kind("conflict"));
    expect(rig.server.requests.filter((r) => r.method === "ensure")).toHaveLength(2);
  });

  it("times out a daemon that does not answer, then repeats, then gives up", async () => {
    const rig = await createSocketRig({ requestTimeoutMs: 40, retries: 1 });
    rigs.push(rig);
    rig.server.silence("health");
    await expect(rig.client.health("ws-1")).rejects.toThrow(/did not answer 'health' within 40 ms; gave up after 2 tries/);
    expect(rig.server.requests.filter((r) => r.method === "health")).toHaveLength(2);
    rig.server.silence(undefined);
    expect((await rig.client.health("ws-1")).state).toBe("absent"); // a late answer to the old request did not confuse the next one
  });

  it("distrusts a daemon that sends nonsense: it drops that connection and the call is repeated on a new one", async () => {
    const rig = await createSocketRig();
    rigs.push(rig);
    rig.server.replaceNextResponse("this is not json\n");
    expect((await rig.client.health("ws-1")).state).toBe("absent");
  });

  it("does not repeat input.insertText after a transport failure: its outcome is unknown and a repeat would type twice", async () => {
    const rig = await createSocketRig({ requestTimeoutMs: 40, retries: 3 });
    rigs.push(rig);
    await rig.client.ensure({ workspaceId: "ws-1" });
    await rig.client.takeover.open("ws-1");
    rig.server.silence("input.insertText");
    await expect(rig.client.input.insertText("ws-1", "once")).rejects.toSatisfy(kind("unavailable"));
    expect(rig.server.requests.filter((r) => r.method === "input.insertText")).toHaveLength(1);
    rig.server.silence(undefined);
    expect(await rig.client.input.insertText("ws-1", "again")).toEqual({ inserted: 5 });
    expect(rig.fake.typed).toEqual(["again"]);
  });

  it("does not repeat files.put after a transport failure: a repeat would store the file twice", async () => {
    const rig = await createSocketRig({ requestTimeoutMs: 40, retries: 3 });
    rigs.push(rig);
    await rig.client.ensure({ workspaceId: "ws-1" });
    rig.server.silence("files.put");
    await expect(rig.client.files.put("ws-1", "a.txt", new Uint8Array([1]))).rejects.toSatisfy(kind("unavailable"));
    expect(rig.server.requests.filter((r) => r.method === "files.put")).toHaveLength(1);
    rig.server.silence(undefined);
    expect(await rig.client.files.list("ws-1")).toEqual([]);
  });

  it("turns an error kind it does not know into internal, and refuses calls after close", async () => {
    const rig = await createSocketRig();
    rigs.push(rig);
    rig.server.replaceNextResponse(`${JSON.stringify({ v: 1, id: "c1", ok: false, error: { kind: "from_the_future", message: "x" } })}\n`);
    await expect(rig.client.health("ws-1")).rejects.toSatisfy(kind("internal"));
    rig.client.close();
    await expect(rig.client.health("ws-1")).rejects.toSatisfy(kind("unavailable"));
  });

  it("reports a missing socket as unavailable", async () => {
    const client = createWorkspaceClient({ socketPath: join(tmpdir(), "ogb-no-such.sock"), retries: 0, sleep: async () => {} });
    await expect(client.ensure({ workspaceId: "ws-1" })).rejects.toThrow(/cannot reach the desk-daemon/);
    client.close();
  });
});
