import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { DeskHost } from "../src/host.ts";
import { sweepStaleProcesses } from "../src/supervisor.ts";
import { createWorkspaceClient } from "@standin/workspace-client";
import { stubConfig } from "../src/testing/index.ts";
import { alive, eventually, silentLog, tempRoot } from "./helpers.ts";

let root: ReturnType<typeof tempRoot>;
beforeEach(() => {
  root = tempRoot();
  mkdirSync(join(root.dir, "x"));
});
afterEach(() => root.remove());

describe("sweepStaleProcesses", () => {
  it("kills a recorded group whose command line matches, and removes the record", () => {
    const child = spawn("sleep", ["300"], { detached: true, stdio: "ignore" });
    writeFileSync(join(root.dir, "a.pid"), JSON.stringify({ pid: child.pid, args: "sleep 300" }));
    expect(sweepStaleProcesses(root.dir)).toBe(1);
    expect(existsSync(join(root.dir, "a.pid"))).toBe(false);
    return eventually(
      () => alive(child.pid as number),
      (a) => !a,
    );
  });

  it("does not touch a process whose command line differs (a reused pid)", () => {
    const child = spawn("sleep", ["301"], { detached: true, stdio: "ignore" });
    writeFileSync(join(root.dir, "b.pid"), JSON.stringify({ pid: child.pid, args: "chromium --user-data-dir=/x" }));
    expect(sweepStaleProcesses(root.dir)).toBe(0);
    expect(alive(child.pid as number)).toBe(true);
    child.kill("SIGKILL");
  });

  it("removes garbage records, ignores other files, and a missing directory is fine", () => {
    writeFileSync(join(root.dir, "c.pid"), "{nope");
    writeFileSync(join(root.dir, "d.pid"), JSON.stringify({ pid: 2 ** 22 - 5, args: "gone" }));
    writeFileSync(join(root.dir, "keep.txt"), "x");
    expect(sweepStaleProcesses(root.dir)).toBe(0);
    expect(existsSync(join(root.dir, "c.pid"))).toBe(false);
    expect(existsSync(join(root.dir, "d.pid"))).toBe(false);
    expect(existsSync(join(root.dir, "keep.txt"))).toBe(true);
    expect(sweepStaleProcesses(join(root.dir, "missing"))).toBe(0);
  });
});

describe("the daemon is killed with SIGKILL", () => {
  it("leaves processes behind, the next daemon removes them and ensure brings the workspace back with its logins", async () => {
    const dataDir = join(root.dir, "d");
    const socketPath = join(root.dir, "s");
    const x11Dir = join(root.dir, "x");
    const fixture = fileURLToPath(new URL("./fixtures/stub-daemon.ts", import.meta.url));
    const daemon = spawn(process.execPath, [fixture, dataDir, socketPath, x11Dir], { stdio: ["ignore", "pipe", "inherit"] });
    await new Promise<void>((resolve) => daemon.stdout.once("data", () => resolve()));
    const client = createWorkspaceClient({ socketPath });
    const info = await client.ensure({ workspaceId: "w1" });
    client.close();
    writeFileSync(join(info.profileDir, "Cookies"), "login=1");
    const browserPid = Number(readFileSync(join(info.profileDir, "starts.log"), "utf8").split(" ")[0]);
    const helperPid = Number(readFileSync(join(info.profileDir, "helper.pid"), "utf8"));
    const xvfbPid = Number(readFileSync(join(x11Dir, "xvfb-100.pid"), "utf8"));
    daemon.kill("SIGKILL");
    await new Promise((resolve) => daemon.once("exit", resolve));
    // The orphans are really still there: this is the situation the sweep exists for.
    expect([alive(browserPid), alive(helperPid), alive(xvfbPid)]).toEqual([true, true, true]);

    const next = new DeskHost(stubConfig({ dataDir, socketPath, x11Dir }, { portShift: 1000 }), silentLog);
    try {
      // SIGKILL is delivered at once, but a killed process stays visible until init reaps it.
      await eventually(
        () => [alive(browserPid), alive(helperPid), alive(xvfbPid)],
        (states) => states.every((up) => !up),
      );
      expect((await next.health("w1")).state).toBe("stopped");
      expect(await next.ensure({ workspaceId: "w1" })).toEqual(info);
      expect(readFileSync(join(info.profileDir, "Cookies"), "utf8")).toBe("login=1");
      expect(readFileSync(join(info.profileDir, "starts.log"), "utf8").trim().split("\n")).toHaveLength(2);
    } finally {
      await next.shutdown();
    }
  });
});
