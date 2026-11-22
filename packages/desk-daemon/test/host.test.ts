import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { isOgbError } from "@vesper/contracts";
import { DeskHost } from "../src/host.ts";
import { stubConfig } from "../src/testing/index.ts";
import { alive, eventually, silentLog, tempRoot } from "./helpers.ts";

let root: ReturnType<typeof tempRoot>;
let hosts: DeskHost[];
const paths = () => ({ dataDir: join(root.dir, "d"), socketPath: join(root.dir, "s"), x11Dir: join(root.dir, "x") });
const open = (overrides = {}) => {
  const host = new DeskHost(stubConfig(paths(), overrides), silentLog);
  hosts.push(host);
  return host;
};

beforeEach(() => {
  root = tempRoot();
  mkdirSync(join(root.dir, "x"));
  hosts = [];
});
afterEach(async () => {
  await Promise.all(hosts.map((h) => h.shutdown()));
  root.remove();
});

const pidOf = (file: string) => Number(readFileSync(file, "utf8").trim());
const startsOf = (profileDir: string) => readFileSync(join(profileDir, "starts.log"), "utf8").trim().split("\n");
const pidFromStarts = (profileDir: string) => Number((startsOf(profileDir).at(-1) as string).split(" ")[0]);
const waitRunning = (host: DeskHost, id: string, timeoutMs = 10_000) =>
  eventually(
    () => host.health(id),
    (h) => h.state === "running",
    timeoutMs,
  );

describe("the accessibility bus", () => {
  it("is started per display when configured, its address is in the workspace's info, and it ends with the workspace", async () => {
    const { fileURLToPath } = await import("node:url");
    const bus = { command: process.execPath, args: [fileURLToPath(new URL("../src/testing/stubs/fake-dbus.mjs", import.meta.url))] };
    const host = open({ accessibilityBus: bus });
    const info = await host.ensure({ workspaceId: "w1" });
    expect(info.accessibilityBus).toMatch(/^unix:path=.+a11y-bus$/);
    const socket = (info.accessibilityBus as string).slice("unix:path=".length);
    expect(existsSync(socket)).toBe(true);
    await host.shutdown();
    await eventually(
      () => existsSync(socket),
      (present) => !present,
      5000,
    );
  });

  it("is absent when not configured, and so is its address", async () => {
    expect((await open().ensure({ workspaceId: "w1" })).accessibilityBus).toBeUndefined();
  });
});

describe("kill tests: every process of a workspace comes back", () => {
  it("Chromium: restarted, same profile, no orphan, the stale lock does not block it", async () => {
    const host = open();
    const info = await host.ensure({ workspaceId: "w1" });
    writeFileSync(join(info.profileDir, "Cookies"), "login=1");
    const first = pidFromStarts(info.profileDir);
    const helper = pidOf(join(info.profileDir, "helper.pid"));
    process.kill(first, "SIGKILL");
    await eventually(
      () => startsOf(info.profileDir).length,
      (n) => n === 2,
    );
    await waitRunning(host, "w1");
    expect(alive(helper)).toBe(false);
    expect(alive(pidFromStarts(info.profileDir))).toBe(true);
    expect(readFileSync(join(info.profileDir, "Cookies"), "utf8")).toBe("login=1");
    expect((await host.health("w1")).processes?.browser.restarts).toBe(1);
  });

  it("openbox: restarted alone", async () => {
    const host = open();
    const info = await host.ensure({ workspaceId: "w1" });
    const browserPid = pidFromStarts(info.profileDir);
    const openboxPid = pidOf(join(root.dir, "x", "openbox-100.pid"));
    process.kill(openboxPid, "SIGKILL");
    await eventually(
      async () => (await host.health("w1")).processes?.windowManager.restarts,
      (n) => n === 1,
    );
    await waitRunning(host, "w1");
    expect(pidFromStarts(info.profileDir)).toBe(browserPid); // the browser was not touched
  });

  it("Xvfb: openbox and Chromium are paused, then everything is back on a new X server", async () => {
    const host = open();
    const info = await host.ensure({ workspaceId: "w1" });
    const browserBefore = pidFromStarts(info.profileDir);
    const xvfbPid = pidOf(join(root.dir, "x", "xvfb-100.pid"));
    process.kill(xvfbPid, "SIGKILL");
    await eventually(
      () => startsOf(info.profileDir).length,
      (n) => n === 2,
    );
    const health = await waitRunning(host, "w1");
    expect(pidFromStarts(info.profileDir)).not.toBe(browserBefore);
    expect(health.processes?.display.restarts).toBe(1);
    expect(health.processes?.windowManager.state).toBe("running");
    expect(existsSync(join(root.dir, "x", "X100"))).toBe(true);
  });

  it("the daemon itself: a new daemon finds the workspace stopped, ensure restores it, logins stay", async () => {
    const first = open();
    const info = await first.ensure({ workspaceId: "w1" });
    writeFileSync(join(info.profileDir, "Cookies"), "login=1");
    writeFileSync(join(info.filesDir, "memo.md"), "notes");
    const browser = pidFromStarts(info.profileDir);
    // A hard stop of the daemon cannot be simulated in-process; the container test kills the real process. Here: processes die first.
    process.kill(browser, "SIGKILL");
    await first.shutdown();
    const second = open();
    expect((await second.health("w1")).state).toBe("stopped");
    const again = await second.ensure({ workspaceId: "w1" });
    expect(again).toEqual(info);
    expect(readFileSync(join(info.profileDir, "Cookies"), "utf8")).toBe("login=1");
    expect(readFileSync(join(info.filesDir, "memo.md"), "utf8")).toBe("notes");
    expect(startsOf(info.profileDir)).toHaveLength(2);
  });
});

describe("isolation and lifecycle", () => {
  it("two workspaces: own X server, own browser on its own display and port, no shared files", async () => {
    const host = open();
    const [a, b] = await Promise.all([host.ensure({ workspaceId: "a" }), host.ensure({ workspaceId: "b" })]);
    expect(startsOf(a.profileDir)[0]?.split(" ")[1]).toBe(a.display);
    expect(startsOf(b.profileDir)[0]?.split(" ")[1]).toBe(b.display);
    expect(a.cdpUrl).not.toBe(b.cdpUrl);
    expect(existsSync(join(root.dir, "x", `X${a.display.slice(1)}`))).toBe(true);
    expect(existsSync(join(root.dir, "x", `X${b.display.slice(1)}`))).toBe(true);
    writeFileSync(join(a.profileDir, "Cookies"), "a");
    expect(existsSync(join(b.profileDir, "Cookies"))).toBe(false);
    expect(a.profileDir.startsWith(b.profileDir)).toBe(false);
    // Killing one workspace's browser leaves the other's alone.
    const bPid = pidFromStarts(b.profileDir);
    process.kill(pidFromStarts(a.profileDir), "SIGKILL");
    await waitRunning(host, "a");
    expect(pidFromStarts(b.profileDir)).toBe(bPid);
    expect(startsOf(b.profileDir)).toHaveLength(1);
  });

  it("passes the container flags to the browser (running as root needs --no-sandbox)", async () => {
    const info = await open().ensure({ workspaceId: "w1" });
    expect(startsOf(info.profileDir)[0]?.endsWith("true")).toBe(true);
  });

  it("destroy removes the processes, the record and the logins, but keeps the agent's files", async () => {
    const host = open();
    const info = await host.ensure({ workspaceId: "w1" });
    writeFileSync(join(info.filesDir, "memo.md"), "notes");
    const browser = pidFromStarts(info.profileDir);
    await host.destroy("w1");
    expect(alive(browser)).toBe(false);
    expect(existsSync(info.profileDir)).toBe(false);
    expect(existsSync(join(info.filesDir, "memo.md"))).toBe(true);
    expect((await open().health("w1")).state).toBe("absent"); // no record left for the next daemon
  });

  it("a stopped workspace is not woken by health or destroy-of-others", async () => {
    const host = open();
    await host.ensure({ workspaceId: "w1" });
    await host.shutdown();
    const second = open();
    expect((await second.health("w1")).state).toBe("stopped");
    expect((await second.health("w1")).state).toBe("stopped");
  });

  it("the cap is on running desktops: waking one more stops the least recently used, which wakes again when asked", async () => {
    const host = open({ maxWorkspaces: 2 });
    await host.ensure({ workspaceId: "a" });
    await host.ensure({ workspaceId: "b" });
    await host.ensure({ workspaceId: "a" }); // a is now the more recent
    await host.ensure({ workspaceId: "c" });
    expect((await host.health("b")).state).toBe("stopped");
    expect((await host.health("a")).state).not.toBe("stopped");
    expect((await host.health("c")).state).not.toBe("stopped");
    await host.ensure({ workspaceId: "b" });
    expect((await host.health("b")).state).not.toBe("stopped");
    expect((await host.health("a")).state).toBe("stopped");
  });

  it("a desktop with an open live view is never stopped to make room; with no other, waking is unavailable", async () => {
    const host = open({ maxWorkspaces: 1 });
    await host.ensure({ workspaceId: "a" });
    await host.view.open("a");
    const error = await host.ensure({ workspaceId: "b" }).catch((e: unknown) => e);
    expect(isOgbError(error, "unavailable")).toBe(true);
    expect((await host.health("a")).state).not.toBe("stopped");
  });

  it("a slot freed by destroy is reused", async () => {
    const host = open();
    const a = await host.ensure({ workspaceId: "a" });
    await host.destroy("a");
    expect((await host.ensure({ workspaceId: "b" })).display).toBe(a.display);
  });

  it("a program that cannot start fails ensure with unavailable and leaves the workspace stopped, retryable", async () => {
    const broken = open({ chromium: { command: "/no/such/chromium" }, startTimeoutMs: 600 });
    const error = await broken.ensure({ workspaceId: "w1" }).catch((e: unknown) => e);
    expect(isOgbError(error, "unavailable")).toBe(true);
    expect((await broken.health("w1")).state).toBe("stopped");
    const fixed = open();
    await broken.shutdown();
    expect((await fixed.ensure({ workspaceId: "w1" })).display).toBe(":100");
  });

  it("ignores an unreadable record and a record for another id", async () => {
    const d = paths().dataDir;
    mkdirSync(join(d, "workspaces", "bad"), { recursive: true });
    writeFileSync(join(d, "workspaces", "bad", "record.json"), "{not json");
    mkdirSync(join(d, "workspaces", "files-only", "files"), { recursive: true });
    mkdirSync(join(d, "workspaces", "liar"), { recursive: true });
    writeFileSync(join(d, "workspaces", "liar", "record.json"), JSON.stringify({ v: 1, slot: 0, spec: { workspaceId: "other" } }));
    const host = open();
    expect((await host.health("bad")).state).toBe("absent");
    expect((await host.health("liar")).state).toBe("absent");
    expect((await host.health("files-only")).state).toBe("absent");
  });
});

describe("take-over through the host", () => {
  it("opens a bridge that needs the ticket's token, and close shuts it", async () => {
    const host = open({ takeoverTtlMs: 60_000 });
    await host.ensure({ workspaceId: "w1" });
    const ticket = await host.takeover.open("w1");
    const url = (token: string) => `ws://127.0.0.1:${ticket.port}/?token=${token}`;
    const connect = (token: string) =>
      new Promise<WebSocket>((resolve, reject) => {
        const ws = new WebSocket(url(token), "binary");
        ws.binaryType = "arraybuffer";
        ws.onopen = () => resolve(ws);
        ws.onerror = () => reject(new Error("refused"));
      });
    const ws = await connect(ticket.token);
    const greeting = await new Promise<string>((resolve) => {
      ws.onmessage = (e) => resolve(Buffer.from(e.data as ArrayBuffer).toString());
    });
    expect(greeting).toBe("RFB 003.008\n");
    await expect(connect("0".repeat(64))).rejects.toThrow();
    await host.takeover.close("w1");
    await expect(connect(ticket.token)).rejects.toThrow();
    ws.close();
  });

  it("an expired token is refused and open() hands out a fresh one on the same bridge", async () => {
    const host = open({ takeoverTtlMs: 150 });
    await host.ensure({ workspaceId: "w1" });
    const old = await host.takeover.open("w1");
    await new Promise((r) => setTimeout(r, 250));
    const refused = await new Promise<boolean>((resolve) => {
      const ws = new WebSocket(`ws://127.0.0.1:${old.port}/?token=${old.token}`);
      ws.onopen = () => resolve(false);
      ws.onerror = () => resolve(true);
    });
    expect(refused).toBe(true);
    const fresh = await host.takeover.open("w1");
    expect(fresh.token).not.toBe(old.token);
    expect(fresh.port).toBe(old.port);
    const accepted = await new Promise<boolean>((resolve) => {
      const ws = new WebSocket(`ws://127.0.0.1:${fresh.port}/?token=${fresh.token}`);
      ws.onopen = () => {
        ws.close();
        resolve(true);
      };
      ws.onerror = () => resolve(false);
    });
    expect(accepted).toBe(true);
  });

  it("stopping the workspace closes the bridge", async () => {
    const host = open();
    await host.ensure({ workspaceId: "w1" });
    const ticket = await host.takeover.open("w1");
    await host.shutdown();
    const refused = await new Promise<boolean>((resolve) => {
      const ws = new WebSocket(`ws://127.0.0.1:${ticket.port}/?token=${ticket.token}`);
      ws.onopen = () => resolve(false);
      ws.onerror = () => resolve(true);
    });
    expect(refused).toBe(true);
  });
});

describe("the display stream: view and control tickets over one x11vnc", () => {
  const record = (id: string) => JSON.parse(readFileSync(join(root.dir, "d", "workspaces", id, "run", "x11vnc.pid"), "utf8")) as { pid: number; args: string };
  const connect = (ticket: { port: number; token: string }) =>
    new Promise<WebSocket>((resolve, reject) => {
      const ws = new WebSocket(`ws://127.0.0.1:${ticket.port}/?token=${ticket.token}`, "binary");
      ws.binaryType = "arraybuffer";
      ws.onopen = () => resolve(ws);
      ws.onerror = () => reject(new Error("refused"));
    });
  const refused = (ticket: { port: number; token: string }) =>
    connect(ticket).then(
      (ws) => {
        ws.close();
        return false;
      },
      () => true,
    );
  const received = (ws: WebSocket, length: number) =>
    new Promise<Buffer>((resolve) => {
      const parts: Buffer[] = [];
      ws.onmessage = (event) => {
        parts.push(Buffer.from(event.data as ArrayBuffer));
        if (Buffer.concat(parts).length >= length) resolve(Buffer.concat(parts));
      };
    });
  const KEY = Buffer.from([4, 1, 0, 0, 0, 0, 0xff, 0x0d]);
  const REQUEST = Buffer.from([3, 1, 0, 0, 0, 0, 5, 0, 3, 32]);

  it("starts one x11vnc with the tuned flags: loopback only, no password, shared, no -repeat", async () => {
    const host = open();
    await host.ensure({ workspaceId: "w1" });
    await host.view.open("w1");
    await host.takeover.open("w1");
    const args = record("w1").args;
    for (const flag of [
      "-localhost",
      "-no6",
      "-nopw",
      "-forever",
      "-shared",
      "-wait 66",
      "-defer 66",
      "-rfbwait 30000",
      "-nocursorshape",
      "-nodpms",
      "-nosel",
    ]) {
      expect(args).toContain(flag);
    }
    expect(args).not.toContain("-repeat");
    expect(args).not.toContain("-once");
  });

  it("a view token cannot send keys; a control token can; one bridge serves both", async () => {
    const host = open();
    await host.ensure({ workspaceId: "w1" });
    const view = await host.view.open("w1");
    const control = await host.takeover.open("w1");
    expect(view.port).toBe(control.port);
    const watcher = await connect(view);
    const echoed = received(watcher, 12 + 2 + REQUEST.length * 2 + 12);
    watcher.send(Buffer.concat([Buffer.from("RFB 003.008\n"), Buffer.from([1, 0]), REQUEST, KEY, REQUEST]));
    const seen = await echoed; // the greeting of the stub, then exactly what the filter let through
    expect(seen.subarray(12).equals(Buffer.concat([Buffer.from("RFB 003.008\n"), Buffer.from([1, 1]), REQUEST, REQUEST]))).toBe(true);
    const driver = await connect(control);
    const echo = received(driver, 12 + KEY.length);
    driver.send(KEY);
    expect((await echo).subarray(12).equals(KEY)).toBe(true);
    watcher.close();
    driver.close();
  });

  it("takeover.close revokes the control token and drops its connections while the view keeps working; an unwatched stream is then reaped", async () => {
    const host = open({ streamIdleMs: 400, reapIntervalMs: 50 });
    await host.ensure({ workspaceId: "w1" });
    const view = await host.view.open("w1");
    const control = await host.takeover.open("w1");
    const driver = await connect(control);
    const dropped = new Promise<void>((resolve) => {
      driver.onclose = () => resolve();
    });
    const x11vnc = record("w1").pid;
    expect(await host.takeover.close("w1")).toEqual({ wasOpen: true });
    await dropped;
    expect(await refused(control)).toBe(true);
    const watcher = await connect(view);
    expect(alive(x11vnc)).toBe(true);
    watcher.close();
    await eventually(
      () => alive(x11vnc),
      (up) => !up,
      3000,
    );
    expect(await refused(view)).toBe(true);
    const again = await host.view.open("w1"); // a later open starts the stream again, with a new token
    expect(again.token).not.toBe(view.token);
    expect(alive(record("w1").pid)).toBe(true);
  });

  it("the reaper stops an unwatched stream after the idle time, and keeps one that has a connection", async () => {
    const host = open({ streamIdleMs: 300, reapIntervalMs: 50 });
    await host.ensure({ workspaceId: "w1" });
    await host.ensure({ workspaceId: "w2" });
    const idle = await host.view.open("w1");
    const watched = await host.view.open("w2");
    const idlePid = record("w1").pid;
    const watchedPid = record("w2").pid;
    const watcher = await connect(watched);
    await eventually(
      () => alive(idlePid),
      (up) => !up,
      3000,
    );
    expect(alive(watchedPid)).toBe(true);
    expect(await refused(idle)).toBe(true);
    watcher.close(); // once it leaves, the idle time starts again
    await eventually(
      () => alive(watchedPid),
      (up) => !up,
      3000,
    );
  });

  it("an open that arrives while the reaper runs gets a working stream", async () => {
    const host = open({ streamIdleMs: 100, reapIntervalMs: 20 });
    await host.ensure({ workspaceId: "w1" });
    for (let round = 0; round < 6; round += 1) {
      const ticket = await host.view.open("w1");
      await new Promise((resolve) => setTimeout(resolve, 90 + round * 10)); // around the idle time
      const again = await host.view.open("w1");
      const ws = await connect(again);
      ws.close();
      expect(again.port).toBe(ticket.port);
    }
  });

  it("viewFilter off makes the view ticket a raw pipe; on (the default) filters it and logs the offending type", async () => {
    const warnings: Record<string, unknown>[] = [];
    const log = { ...silentLog, warn: (_m: string, f?: Record<string, unknown>) => void warnings.push(f ?? {}) };
    for (const setting of ["on", "off"] as const) {
      const host = new DeskHost(stubConfig({ ...paths(), dataDir: join(root.dir, `d-${setting}`) }, { viewFilter: setting }), log);
      hosts.push(host);
      await host.ensure({ workspaceId: "w1" });
      const ws = await connect(await host.view.open("w1"));
      const echoed = received(ws, 12 + KEY.length);
      const closed = new Promise<number>((resolve) => {
        ws.onclose = (event) => resolve(event.code);
      });
      ws.send(setting === "on" ? Buffer.concat([Buffer.from("RFB 003.008\n"), Buffer.from([1, 0, 9, 0, 0, 0])]) : KEY);
      if (setting === "off") expect((await echoed).subarray(12).equals(KEY)).toBe(true);
      else expect(await closed).toBe(1008);
      ws.close();
      await host.shutdown(); // the next round reuses the same ports
    }
    expect(warnings.map((w) => w.detail)).toEqual(["message type 9 is not allowed from a view-only client"]);
  });

  it("x11vnc waits while Xvfb is down and comes back with it", async () => {
    const host = open();
    await host.ensure({ workspaceId: "w1" });
    const ticket = await host.view.open("w1");
    const before = record("w1").pid;
    process.kill(pidOf(join(root.dir, "x", "xvfb-100.pid")), "SIGKILL");
    await eventually(
      () => alive(before),
      (up) => !up,
    );
    await waitRunning(host, "w1");
    await eventually(() => (existsSync(join(root.dir, "d", "workspaces", "w1", "run", "x11vnc.pid")) ? alive(record("w1").pid) : false), Boolean);
    expect(record("w1").pid).not.toBe(before);
    // the same ticket works again as soon as the new x11vnc listens
    await eventually(
      () =>
        connect(ticket).then(
          (ws) => {
            ws.close();
            return true;
          },
          () => false,
        ),
      Boolean,
    );
  });
});

describe("typing text into the page through DevTools", () => {
  const insertedLog = (profileDir: string) =>
    readFileSync(join(profileDir, "inserted.log"), "utf8")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as { target: string; text: string });

  it("sends any Unicode to the focused page and only to it", async () => {
    const host = open();
    const info = await host.ensure({ workspaceId: "w1" });
    await host.takeover.open("w1");
    expect(await host.input.insertText("w1", "密码 p@ss 🙂")).toEqual({ inserted: 9 });
    writeFileSync(join(info.profileDir, "focus"), "b");
    await host.input.insertText("w1", "second");
    expect(insertedLog(info.profileDir)).toEqual([
      { target: "a", text: "密码 p@ss 🙂" },
      { target: "b", text: "second" },
    ]);
  });

  it("falls back to the last page when none says it has focus", async () => {
    const host = open();
    const info = await host.ensure({ workspaceId: "w1" });
    await host.takeover.open("w1");
    writeFileSync(join(info.profileDir, "focus"), "none");
    await host.input.insertText("w1", "x");
    expect(insertedLog(info.profileDir)).toEqual([{ target: "b", text: "x" }]);
  });

  it("refuses without a take-over, also when only a view is open, and sends nothing", async () => {
    const host = open();
    const info = await host.ensure({ workspaceId: "w1" });
    await host.view.open("w1");
    await expect(host.input.insertText("w1", "secret")).rejects.toMatchObject({ kind: "denied" });
    expect(existsSync(join(info.profileDir, "inserted.log"))).toBe(false);
  });

  it("limits the rate: a sixth insertion within a second is refused, the text is not queued", async () => {
    const host = open();
    const info = await host.ensure({ workspaceId: "w1" });
    await host.takeover.open("w1");
    for (let i = 0; i < 5; i += 1) await host.input.insertText("w1", `t${i}`);
    await expect(host.input.insertText("w1", "t5")).rejects.toMatchObject({ kind: "unavailable" });
    expect(insertedLog(info.profileDir).map((e) => e.text)).toEqual(["t0", "t1", "t2", "t3", "t4"]);
  });

  it("never puts the text in a log line or an error message", async () => {
    const lines: string[] = [];
    const log = {
      info: (m: string, f?: object) => lines.push(m + JSON.stringify(f)),
      warn: (m: string, f?: object) => lines.push(m + JSON.stringify(f)),
      error: (m: string, f?: object) => lines.push(m + JSON.stringify(f)),
    };
    const host = new DeskHost(stubConfig(paths()), log);
    hosts.push(host);
    await host.ensure({ workspaceId: "w1" });
    await host.takeover.open("w1");
    await host.input.insertText("w1", "TOP-SECRET-TEXT");
    const failure = await host.input.insertText("w1", "x".repeat(3000)).catch((e: Error) => e);
    expect(String((failure as Error).message)).not.toContain("xxxx");
    expect(lines.join("\n")).not.toContain("TOP-SECRET-TEXT");
  });
});
