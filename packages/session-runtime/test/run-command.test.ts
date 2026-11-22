import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { isOgbError } from "@vesper/contracts";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createHostWorkspaces, runInWorkspace, spawnInWorkspace, workspaceEnvironment } from "../src/index.ts";
import { createFakeWorkspaceHost } from "@vesper/workspace-client/testing";

const dirs: string[] = [];
const node = process.execPath;
const target = () => {
  const filesDir = realpathSync(mkdtempSync(join(tmpdir(), "ogb-run-")));
  dirs.push(filesDir);
  return { workspaceId: "ws-1", filesDir, display: ":101", cdpUrl: "http://127.0.0.1:9301" };
};
const SECRETS = { ANTHROPIC_API_KEY: "sk-parent-secret", OGB_RUNTIME_TOKEN: "parent-token", AWS_SECRET_ACCESS_KEY: "parent-aws" };
const saved: Record<string, string | undefined> = {};
beforeEach(() => {
  for (const [key, value] of Object.entries(SECRETS)) {
    saved[key] = process.env[key];
    process.env[key] = value;
  }
});
afterEach(() => {
  for (const [key, value] of Object.entries(saved)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});
const kind = (k: string) => (e: unknown) => isOgbError(e, k as never);
/** macOS adds this one variable to every child process itself; it does not come from the runtime. */
const withoutPlatformAdditions = (env: Record<string, string>) => {
  const { __CF_USER_TEXT_ENCODING: _added, ...rest } = env;
  return rest;
};
const printEnv = ["-e", "process.stdout.write(JSON.stringify(process.env))"];

describe("running a command for a workspace", () => {
  it("passes exactly the workspace's environment and nothing inherited: the runtime's secrets never reach the command", async () => {
    const t = target();
    const result = await runInWorkspace(t, [node, ...printEnv]);
    expect(result.exitCode).toBe(0);
    const env = withoutPlatformAdditions(JSON.parse(result.stdout) as Record<string, string>);
    expect(env).toEqual({
      PATH: "/usr/local/bin:/usr/bin:/bin",
      HOME: t.filesDir,
      LANG: "C.UTF-8",
      OGB_WORKSPACE_ID: "ws-1",
      OGB_FILES_DIR: t.filesDir,
      DISPLAY: ":101",
      OGB_CDP_URL: "http://127.0.0.1:9301",
    });
    for (const secret of Object.values(SECRETS)) expect(result.stdout).not.toContain(secret);
    expect(Object.keys(process.env)).toEqual(expect.arrayContaining(Object.keys(SECRETS))); // they really were in the parent's environment
  });

  it("leaves out DISPLAY and the DevTools address for a workspace that has none, and adds the caller's variables on top", async () => {
    const t = { workspaceId: "ws-2", filesDir: target().filesDir };
    const env = withoutPlatformAdditions(JSON.parse((await runInWorkspace(t, [node, ...printEnv], { env: { BROWSER_TOOL_AGENT_ID: "agent-a" } })).stdout));
    expect(Object.keys(env).sort()).toEqual(["BROWSER_TOOL_AGENT_ID", "HOME", "LANG", "OGB_FILES_DIR", "OGB_WORKSPACE_ID", "PATH"]);
  });

  it("points desktop programs at the shared settings directory through the XDG variables", () => {
    const env = workspaceEnvironment({ ...target(), appDataDir: "/data/desk/shared/app-data" });
    expect(env).toMatchObject({
      XDG_CONFIG_HOME: "/data/desk/shared/app-data/config",
      XDG_DATA_HOME: "/data/desk/shared/app-data/data",
      XDG_STATE_HOME: "/data/desk/shared/app-data/state",
    });
  });

  it("gives programs the box's time zone, so a bot's clock agrees with its schedule (testers' B-2)", () => {
    const saved = process.env.TZ;
    try {
      process.env.TZ = "Asia/Shanghai";
      expect(workspaceEnvironment(target()).TZ).toBe("Asia/Shanghai");
      delete process.env.TZ;
      expect(workspaceEnvironment(target())).not.toHaveProperty("TZ");
    } finally {
      if (saved === undefined) delete process.env.TZ;
      else process.env.TZ = saved;
    }
  });

  it("puts programs on the display's accessibility bus, with GTK's bridge on, when the workspace has one", () => {
    expect(workspaceEnvironment({ ...target(), accessibilityBus: "unix:path=/run/a11y-bus" })).toMatchObject({
      DBUS_SESSION_BUS_ADDRESS: "unix:path=/run/a11y-bus",
      GTK_MODULES: "gail:atk-bridge",
      NO_AT_BRIDGE: "0",
    });
    expect(workspaceEnvironment(target())).not.toHaveProperty("DBUS_SESSION_BUS_ADDRESS");
  });

  it("starts a program that keeps running, in the files directory with the workspace's environment and nothing inherited", async () => {
    const t = target();
    const child = spawnInWorkspace(
      t,
      [
        node,
        "-e",
        "process.stdin.on('data', (d) => process.stdout.write(JSON.stringify({ got: String(d).trim(), cwd: process.cwd(), key: process.env.ANTHROPIC_API_KEY ?? null, extra: process.env.TOOL_VAR })))",
      ],
      { env: { TOOL_VAR: "x" } },
    );
    let out = "";
    child.stdout?.on("data", (chunk: Buffer) => {
      out += chunk.toString();
    });
    child.stdin?.write("hello\n");
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(JSON.parse(out)).toEqual({ got: "hello", cwd: t.filesDir, key: null, extra: "x" });
    child.kill("SIGKILL");
    expect(() => spawnInWorkspace(t, [node], { env: { PATH: "/evil" } })).toThrow(/belongs to the workspace/);
  });

  it("refuses to let a caller set the workspace's own variables or odd names", () => {
    const t = target();
    for (const name of ["PATH", "HOME", "DISPLAY", "LANG", "OGB_CDP_URL", "OGB_FILES_DIR", "OGB_WORKSPACE_ID", "XDG_CONFIG_HOME", "DBUS_SESSION_BUS_ADDRESS"]) {
      expect(() => workspaceEnvironment(t, { [name]: "x" }), name).toThrow(/belongs to the workspace/);
    }
    expect(() => workspaceEnvironment(t, { "lower-case": "x" })).toThrow(/not allowed/);
    expect(() => workspaceEnvironment(t, { OK_NAME: "a\0b" })).toThrow(/without NUL/);
    return expect(runInWorkspace(t, [node, "-e", ""], { env: { PATH: "/evil" } })).rejects.toSatisfy(kind("denied"));
  });

  it("runs in the files directory, feeds stdin, and reports a failing exit code and standard error", async () => {
    const t = target();
    const cwd = await runInWorkspace(t, [node, "-e", "process.stdout.write(process.cwd())"]);
    expect(cwd.stdout).toBe(t.filesDir);
    const echoed = await runInWorkspace(t, [node, "-e", "process.stdin.pipe(process.stdout)"], { stdin: "hello" });
    expect(echoed.stdout).toBe("hello");
    const failed = await runInWorkspace(t, [node, "-e", "console.error('boom'); process.exit(3)"]);
    expect(failed).toMatchObject({ exitCode: 3, stderr: expect.stringContaining("boom"), timedOut: false, truncated: false });
  });

  it("does not use a shell: arguments are not interpreted", async () => {
    const t = target();
    const result = await runInWorkspace(t, [node, "-e", "process.stdout.write(process.argv[1])", "$(echo injected); `id`"]);
    expect(result.stdout).toBe("$(echo injected); `id`");
  });

  it("kills a command that runs too long or whose caller gives up, and cuts too much output", async () => {
    const t = target();
    const slow = await runInWorkspace(t, [node, "-e", "setTimeout(() => {}, 10000)"], { timeoutMs: 80 });
    expect(slow).toMatchObject({ timedOut: true, exitCode: null });
    const controller = new AbortController();
    const pending = runInWorkspace(t, [node, "-e", "setTimeout(() => {}, 10000)"], { signal: controller.signal });
    setTimeout(() => controller.abort(), 50);
    expect((await pending).exitCode).toBeNull();
    expect((await runInWorkspace(t, [node, "-e", ""], { signal: AbortSignal.abort() })).exitCode).toBeNull();
    const loud = await runInWorkspace(t, [node, "-e", "process.stdout.write('x'.repeat(5000))"], { maxOutputBytes: 100 });
    expect(loud.stdout).toHaveLength(100);
    expect(loud.truncated).toBe(true);
  });

  it("rejects a program that does not exist and a bad command", async () => {
    const t = target();
    await expect(runInWorkspace(t, ["no-such-program-ogb"])).rejects.toSatisfy(kind("not_found"));
    await expect(runInWorkspace(t, [])).rejects.toSatisfy(kind("invalid_input"));
    await expect(runInWorkspace(t, [""])).rejects.toSatisfy(kind("invalid_input"));
    await expect(runInWorkspace(t, ["a\0b"])).rejects.toSatisfy(kind("invalid_input"));
    await expect(runInWorkspace({ ...t, filesDir: join(t.filesDir, "missing") }, [node, "-e", ""])).rejects.toSatisfy(kind("unavailable"));
  });
});

describe("the handle the host adapter gives", () => {
  it("runs commands in the workspace the host made, with its display and DevTools address", async () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), "ogb-host-")));
    dirs.push(root);
    const provider = createHostWorkspaces(createFakeWorkspaceHost({ root }));
    const workspace = await provider.ensure("s_abc123");
    expect(workspace.workspaceId).toBe("s-abc123");
    const env = withoutPlatformAdditions(JSON.parse((await workspace.run([node, ...printEnv])).stdout));
    expect(env).toMatchObject({ OGB_WORKSPACE_ID: "s-abc123", OGB_FILES_DIR: workspace.filesDir, DISPLAY: workspace.display, OGB_CDP_URL: workspace.cdpUrl });
    expect(env.XDG_CONFIG_HOME).toBe(join(root, "shared", "app-data", "config")); // the host's shared settings directory
    expect(Object.keys(env)).toHaveLength(10);
    expect(JSON.stringify(env)).not.toContain("parent-secret");
  });
});
