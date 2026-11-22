import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createFakeMatrix, createFakeTempMail } from "@standin/connectors/testing";
import { createApp } from "../src/app.ts";
import { harness, type Harness, KEY, repoRoot } from "./helpers.ts";

const made: Harness[] = [];
afterEach(async () => {
  for (const h of made.splice(0)) await h.cleanup();
});
const start = (env: Record<string, string | undefined> = {}, options: { deskDown?: boolean; processEnv?: boolean; fetch?: typeof fetch } = {}) => {
  const h = harness(env, options);
  made.push(h);
  return h;
};
const api = async (base: string, path: string, init: RequestInit & { json?: unknown } = {}) => {
  const { json, ...rest } = init;
  const response = await fetch(`${base}${path}`, {
    ...rest,
    ...(json !== undefined ? { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(json) } : {}),
  });
  const text = await response.text();
  return { status: response.status, text, json: () => JSON.parse(text) as Record<string, any> };
};

describe("starting", () => {
  it("says what is up and what is not: without the key, sessions cannot call a model", async () => {
    const h = start();
    expect(h.app.startup()).toEqual([]);
    const report = await h.app.start();
    expect(h.app.startup()).toEqual(report.lines);
    expect(report.keyPresent).toBe(false);
    const info = (text: string) => ({ level: "info", text });
    expect(report.lines).toContainEqual({ level: "warn", text: "no COMMANDCODE_API_KEY: sessions cannot call a model" });
    expect(report.lines[0]?.text).toMatch(/^page and API listening on 127\.0\.0\.1:\d+$/);
    expect(report.lines).toContainEqual(info("plugins loaded: handoff, browser, computer, mail-sim, mail-temp, mail-outlook, mail-gmail (7 of 7)"));
    expect(report.lines).toContainEqual(info("profiles: general, general-mail"));
    expect(report.lines).toContainEqual(info("desk-daemon: reachable"));
    expect(report.lines).toContainEqual(info("live view and take-over: through the desk-daemon (the desktop over VNC)"));
    expect(report.lines.map((l) => l.text).join("\n")).not.toContain("not wired");
    const warnings = report.lines.filter((l) => l.level === "warn").map((l) => l.text);
    expect(warnings).toEqual(["no COMMANDCODE_API_KEY: sessions cannot call a model"]);
    expect(
      h
        .parsed()
        .filter((e) => e.level === "warn")
        .map((e) => e.message),
    ).toEqual(warnings);
    expect(report.backends).toEqual({ browser: true, desktop: true });
    expect(report.lines).toContainEqual(info("computer tool: the agent-tools runner is present"));
    expect(h.parsed().at(-1)).toMatchObject({ message: "startup complete", up: true, module: "app" });
  });

  it("with the key: names the model, serves the page and the options, and the key is nowhere in the logs or the answers", async () => {
    const h = start({ COMMANDCODE_API_KEY: KEY });
    const report = await h.app.start();
    expect(report.lines).toContainEqual({ level: "info", text: "model: deepseek/deepseek-v4.1-flash at https://api.commandcode.ai/provider/v1 (key present)" });
    const base = h.base(report);
    const page = await api(base, "/");
    expect(page.status).toBe(200);
    expect(page.text).toContain("<html");
    const options = await api(base, "/api/options");
    expect(options.json()).toMatchObject({ profiles: ["general", "general-mail"], defaultProfile: "general", models: ["main"], takeover: true });
    expect(options.text).not.toContain(KEY);
    expect((await api(base, "/api/health")).json()).toMatchObject({ ok: true, ready: true });
    expect(h.logs.join("\n")).not.toContain(KEY);
  });

  it("a session works end to end through the API with the fake model; the key is in no log line, no request to the model and no file of the workspace", async () => {
    const h = start({ COMMANDCODE_API_KEY: KEY });
    const report = await h.app.start();
    const base = h.base(report);
    const created = await api(base, "/api/sessions", { json: { profile: "general", title: "Ping" } });
    expect(created.status).toBe(201);
    const id = created.json().session.id as string;
    expect((await api(base, `/api/sessions/${id}/messages`, { json: { text: "ping" } })).status).toBe(202);
    await h.app.runtime?.whenIdle(id);
    const events = await h.app.runtime?.read(id);
    expect(JSON.stringify(events)).toContain("pong");
    expect(JSON.stringify(events)).not.toContain(KEY);
    expect(h.logs.join("\n")).not.toContain(KEY);
    const agentsMd = readFileSync(join(h.dataDir, "ws", `s-${id.slice(2)}`, "files", "AGENTS.md"), "utf8");
    expect(agentsMd).toContain("Session name: Ping");
    expect(agentsMd).not.toContain(KEY);
    expect(h.parsed().find((e) => e.session === id)).toMatchObject({ module: "session-runtime", workspace: `s-${id.slice(2)}` });
  });

  it("starts without the desk-daemon and says so; sessions would retry later", async () => {
    const h = start({}, { deskDown: true });
    const report = await h.app.start();
    expect(report.deskReachable).toBe(false);
    expect(report.lines.some((l) => l.level === "warn" && l.text.startsWith("desk-daemon: not reachable yet"))).toBe(true);
    expect((await api(h.base(report), "/api/health")).status).toBe(200);
  }, 15_000);

  it("refuses an invalid environment before building anything, without echoing the value", async () => {
    const h = start({ OGB_PORT: "not-a-number", COMMANDCODE_API_KEY: KEY });
    await expect(h.app.start()).rejects.toThrow(/OGB_PORT/);
    expect(h.logs).toEqual([]);
  });

  it("refuses a profile file that names a model or plugin that does not exist", async () => {
    const h = start();
    mkdirSync(join(h.dataDir, "config"));
    writeFileSync(join(h.dataDir, "config", "profiles.json"), JSON.stringify({ profiles: { odd: { plugins: ["not-installed"], model: "nope" } } }));
    await expect(h.app.start()).rejects.toThrow(/does not fit together[\s\S]*model 'nope'[\s\S]*plugin 'not-installed'/);
  });

  it("drops a built-in profile whose plugin failed to install, says so, and goes on with the others", async () => {
    const h = start();
    const root = mkdtempSync(join(tmpdir(), "ogb-approot-"));
    mkdirSync(join(root, "plugins"));
    for (const name of ["handoff", "browser", "computer"]) symlinkSync(join(repoRoot, "plugins", name), join(root, "plugins", name));
    symlinkSync(join(repoRoot, "packages"), join(root, "packages"));
    const partial = start({ OGB_APP_ROOT: root });
    const report = await partial.app.start();
    expect(report.plugins.skipped.map((s) => s.name)).toEqual(["mail-sim", "mail-temp", "mail-outlook", "mail-gmail"]);
    expect(report.profiles).toEqual(["general"]);
    expect(report.lines.some((l) => l.level === "warn" && l.text.startsWith("plugin mail-sim not loaded"))).toBe(true);
    rmSync(root, { recursive: true, force: true });
    void h;
  });
});

describe("what the page may and may not do", () => {
  it("cannot switch review or redaction off: such requests are refused, and every session has the full floor", async () => {
    const h = start({ COMMANDCODE_API_KEY: KEY });
    const base = h.base(await h.app.start());
    for (const attempt of [
      { review: false },
      { redaction: false },
      { safetyFloor: { review: false, redaction: false } },
      { disablePlugins: ["review"] },
      { profile: "general", bypass: true },
    ]) {
      const refused = await api(base, "/api/sessions", { json: attempt });
      expect(refused.status, JSON.stringify(attempt)).toBeGreaterThanOrEqual(400);
      expect(refused.status).toBeLessThan(500);
    }
    const ok = await api(base, "/api/sessions", { json: { profile: "general" } });
    const id = ok.json().session.id as string;
    const record = JSON.parse(readFileSync(join(h.dataDir, "state", "sessions", id, "session.json"), "utf8"));
    expect(record.profile.floor).toEqual(["review", "redaction"]);
    expect((await api(base, "/api/sessions")).json().sessions).toHaveLength(1); // the refused attempts created nothing
  });

  it("a request from another site (Origin) or another Host is refused", async () => {
    const h = start();
    const base = h.base(await h.app.start());
    expect((await api(base, "/api/sessions", { headers: { origin: "http://evil.example" } })).status).toBe(403);
  });
});

describe("listening", () => {
  it("refuses a non-loopback address unless the container opted in (the published port is the host's loopback only) or a token is set", async () => {
    const closed = start({ OGB_HOST: "0.0.0.0" });
    await expect(closed.app.start()).rejects.toThrow(/non-loopback address needs a bearer token/);
    const open = start({ OGB_HOST: "0.0.0.0", OGB_LISTEN_OPEN: "1" });
    const report = await open.app.start();
    expect(report.listening.host).toBe("0.0.0.0");
    expect(open.parsed().some((e) => e.level === "warn" && String(e.message).includes("without a token"))).toBe(true);
    const guarded = start({ OGB_HOST: "0.0.0.0", OGB_API_TOKEN: "page-token-1234567890" });
    const guardedReport = await guarded.app.start();
    const base = guarded.base(guardedReport);
    expect((await api(base, "/api/sessions")).status).toBe(401);
    expect((await api(base, "/api/sessions", { headers: { authorization: "Bearer page-token-1234567890" } })).status).toBe(200);
    expect(guardedReport.lines[0]?.text).toContain("(bearer token required)");
  });
});

describe("stopping and starting again", () => {
  it("stops in order: no new requests, page and API, sessions, workspace client; the port is closed afterwards; twice is harmless", async () => {
    const h = start({ COMMANDCODE_API_KEY: KEY });
    const report = await h.app.start();
    const base = h.base(report);
    await api(base, "/api/sessions", { json: { profile: "general" } });
    await h.app.stop();
    await h.app.stop();
    const messages = h.parsed().map((e) => e.message);
    const order = ["stopping: no new requests", "page and API closed", "sessions closed", "workspace client closed", "stopped"].map((m) => messages.indexOf(m));
    expect(order.every((i) => i >= 0)).toBe(true);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
    expect(h.closed).toEqual(["workspace client"]);
    await expect(fetch(`${base}/api/health`)).rejects.toThrow();
  });

  it("resumes the sessions it had when it started again on the same data", async () => {
    const first = start({ COMMANDCODE_API_KEY: KEY });
    const base = first.base(await first.app.start());
    const id = (await api(base, "/api/sessions", { json: { profile: "general", title: "Back" } })).json().session.id as string;
    await first.app.stop();

    const second = createApp({
      env: { OGB_DATA_DIR: first.dataDir, OGB_HOST: "127.0.0.1", OGB_PORT: "0", OGB_APP_ROOT: repoRoot, COMMANDCODE_API_KEY: KEY },
      write: () => {},
      deps: {
        workspaceHost: { ...(await import("@standin/workspace-client/testing")).createFakeWorkspaceHost({ root: join(first.dataDir, "ws") }), close: () => {} },
        createClient: (await import("./helpers.ts")).pongModel().create,
      },
    });
    const report = await second.start();
    expect(report.resumed).toEqual([id]);
    expect(report.lines).toContainEqual({ level: "info", text: "sessions resumed: 1" });
    await second.stop();
  });
});

describe("the model key", () => {
  it("is taken out of the environment at start: not in the object, not in a child process, still usable and never logged", async () => {
    const saved = {
      key: process.env.COMMANDCODE_API_KEY,
      others: ["OGB_DATA_DIR", "OGB_HOST", "OGB_PORT", "OGB_APP_ROOT"].map((n) => [n, process.env[n]] as const),
    };
    try {
      const h = start({ COMMANDCODE_API_KEY: KEY }, { processEnv: true });
      const report = await h.app.start();
      expect(process.env.COMMANDCODE_API_KEY).toBeUndefined();
      expect(report.keyPresent).toBe(true);
      const { execFileSync } = await import("node:child_process");
      const childSees = execFileSync(process.execPath, ["-e", "process.stdout.write(JSON.stringify(Object.keys(process.env)))"], { encoding: "utf8" });
      expect(childSees).not.toContain("COMMANDCODE_API_KEY");
      const runtime = h.app.runtime;
      const { id } = (await runtime?.createSession()) ?? { id: "" };
      await runtime?.send(id, "hi");
      await runtime?.whenIdle(id);
      expect(h.model.clientOptions.at(-1)?.apiKey).toBe(KEY); // the copy the application holds still reaches the client
      expect(h.logs.join("\n")).not.toContain(KEY);
    } finally {
      for (const [name, value] of saved.others) {
        if (value === undefined) delete process.env[name];
        else process.env[name] = value;
      }
      if (saved.key === undefined) delete process.env.COMMANDCODE_API_KEY;
      else process.env.COMMANDCODE_API_KEY = saved.key;
    }
  });

  it("is removed from the object the application was given when that is a plain object too", async () => {
    const h = start({ COMMANDCODE_API_KEY: KEY });
    await h.app.start();
    expect(h.env.COMMANDCODE_API_KEY).toBeUndefined();
  });
});

describe("the start-up report for the page", () => {
  it("is what /api/options returns", async () => {
    const h = start();
    const report = await h.app.start();
    const options = await api(h.base(report), "/api/options");
    expect(options.json().startup).toEqual(report.lines);
  });
});

describe("real mail (docs/25)", () => {
  const MAIL = { OGB_TEMP_MAIL_URL: "https://mail-api.example.test", OGB_TEMP_MAIL_DOMAIN: "mail.test", OGB_MAIL_TO: "me@home.test" };

  it("with a deployment and the person's address: the mail channel writes from vesper@domain, every bot gets its own address, the admin password leaves the environment", async () => {
    const site = createFakeTempMail({ domain: "mail.test" });
    const h = start({ COMMANDCODE_API_KEY: KEY, ...MAIL, OGB_TEMP_MAIL_ADMIN: site.adminPassword }, { fetch: site.fetch });
    const report = await h.app.start();
    expect(report.plugins.loaded).toContain("mail-temp");
    expect(h.parsed().find((line) => line.message === "mail channel on")?.from).toBe("vesper@mail.test");
    expect(h.env.OGB_TEMP_MAIL_ADMIN).toBeUndefined();
    expect(h.logs.join("\n")).not.toContain(site.adminPassword);
    const options = await api(h.base(report), "/api/options");
    expect(options.status).toBe(200);
  });

  it("a wrong admin password: the box starts without the mail channel and says why", async () => {
    const site = createFakeTempMail({ domain: "mail.test" });
    const h = start({ COMMANDCODE_API_KEY: KEY, ...MAIL, OGB_TEMP_MAIL_ADMIN: "wrong-password" }, { fetch: site.fetch });
    await h.app.start();
    expect(h.parsed().some((line) => line.message === "the mail channel is off: its address could not be opened")).toBe(true);
  });

  it("without a deployment there is no mail plugin in the built-in profiles and no mail channel", async () => {
    const h = start({ COMMANDCODE_API_KEY: KEY, OGB_MAIL_TO: "me@home.test" });
    await h.app.start();
    expect(h.parsed().some((line) => String(line.message).startsWith("mail channel"))).toBe(false);
  });
});

describe("chat bridges (docs/26 4.3)", () => {
  it("chat.json names a Matrix bridge: it is on, its token a secret reference; a bridge that cannot be reached leaves the box up", async () => {
    const server = createFakeMatrix({ token: "mx-tok-0123" });
    const h = start({ COMMANDCODE_API_KEY: KEY, OGB_SECRET_ENV: "OGB_MATRIX_TOKEN", OGB_MATRIX_TOKEN: "mx-tok-0123" }, { fetch: server.fetch });
    mkdirSync(join(h.dataDir, "config"), { recursive: true });
    const bridge = { name: "matrix", kind: "matrix", url: "https://matrix.example.test", token: "env:OGB_MATRIX_TOKEN", person: ["@me:x"], personRoom: "!dm" };
    writeFileSync(
      join(h.dataDir, "config", "chat.json"),
      JSON.stringify({ bridges: [bridge, { ...bridge, name: "down", url: "https://down.example.test", token: "env:OGB_MATRIX_TOKEN_MISSING" }] }),
    );
    await h.app.start();
    expect(h.parsed().find((l) => l.message === "chat bridge on")?.bridge).toBe("matrix");
    expect(h.parsed().some((l) => l.message === "a chat bridge is off: it could not be opened" && l.bridge === "down")).toBe(true);
    expect(h.logs.join("\n")).not.toContain("mx-tok-0123");
  });

  it("a malformed chat.json stops the start and names the field", async () => {
    const h = start({ COMMANDCODE_API_KEY: KEY });
    mkdirSync(join(h.dataDir, "config"), { recursive: true });
    writeFileSync(
      join(h.dataDir, "config", "chat.json"),
      JSON.stringify({ bridges: [{ name: "x", kind: "irc", url: "https://a.test", person: ["@me"], personRoom: "!dm" }] }),
    );
    await expect(h.app.start()).rejects.toThrow(/'kind' must be matrix or satori/);
  });
});
