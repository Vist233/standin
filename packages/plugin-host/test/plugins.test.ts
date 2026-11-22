import { chmodSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CORE_TOOL_NAMES, isOgbError } from "@standin/contracts";
import { afterEach, describe, expect, it } from "vitest";
import {
  createPluginHost,
  hashPluginDirectory,
  installFromMarketplace,
  loadPluginDirectory,
  makeWritable,
  parseMarketplace,
  parseSkillFrontmatter,
  RESERVED_TOOL_NAMES,
  toolFingerprint,
} from "../src/index.ts";
import { createFakeContext, toolSource, writeFixturePlugin } from "../src/testing/index.ts";

const temps: string[] = [];
function temp(): string {
  const dir = mkdtempSync(join(tmpdir(), "ogb-plugins-"));
  temps.push(dir);
  return dir;
}
afterEach(() => {
  for (const dir of temps.splice(0)) {
    try {
      makeWritable(dir);
    } catch {
      // nothing read-only here
    }
    rmSync(dir, { recursive: true, force: true });
  }
});
const kind = (k: string) => (e: unknown) => isOgbError(e, k as never);

describe("loadPluginDirectory", () => {
  it("loads manifest, skills, MCP servers and a content hash without running plugin code", () => {
    const root = temp();
    const dir = writeFixturePlugin(root, {
      name: "demo",
      toolsSource: "throw new Error('must not run at load');",
      effects: ["read"],
      skills: [{ name: "setup", description: "How to set up" }],
      files: { "mcp.json": JSON.stringify({ mcpServers: { files: { command: "x" } } }) },
      ogb: { onboardingSkill: "setup" },
    });
    const loaded = loadPluginDirectory(dir);
    expect(loaded.manifest.name).toBe("demo");
    expect(loaded.skills).toEqual([{ name: "setup", description: "How to set up", path: "skills/setup/SKILL.md" }]);
    expect(loaded.mcpServers).toEqual([{ name: "files", config: { command: "x" } }]);
    expect(loaded.hash).toMatch(/^sha256:[0-9a-f]{64}$/);
  });

  it("changes the hash when a byte or a file changes, and ignores node_modules and .git", () => {
    const dir = writeFixturePlugin(temp(), { name: "demo" });
    const before = hashPluginDirectory(dir);
    expect(hashPluginDirectory(dir)).toBe(before);
    writeFileSync(join(dir, "extra.txt"), "x");
    const added = hashPluginDirectory(dir);
    expect(added).not.toBe(before);
    writeFileSync(join(dir, "extra.txt"), "y");
    expect(hashPluginDirectory(dir)).not.toBe(added);
    mkdirSync(join(dir, "node_modules"));
    writeFileSync(join(dir, "node_modules", "junk.js"), "z");
    expect(hashPluginDirectory(dir)).not.toBe(before); // extra.txt is still there
    rmSync(join(dir, "extra.txt"));
    expect(hashPluginDirectory(dir)).toBe(before);
  });

  it("refuses broken plugins with a clear kind", () => {
    const root = temp();
    expect(() => loadPluginDirectory(join(root, "missing"))).toThrow();
    const noManifest = join(root, "empty");
    mkdirSync(noManifest);
    expect(() => loadPluginDirectory(noManifest)).toThrowError(/plugin.json is missing/);
    writeFileSync(join(noManifest, "plugin.json"), "{not json");
    expect(() => loadPluginDirectory(noManifest)).toThrowError(/not valid JSON/);

    expect(() => loadPluginDirectory(writeFixturePlugin(root, { name: "onb", ogb: { onboardingSkill: "nope" } }))).toThrowError(/onboardingSkill/);
    expect(() => loadPluginDirectory(writeFixturePlugin(root, { name: "badskill", files: { "skills/x/SKILL.md": "no frontmatter" } }))).toThrowError(
      /frontmatter/,
    );
    expect(() =>
      loadPluginDirectory(writeFixturePlugin(root, { name: "wrongskill", files: { "skills/x/SKILL.md": "---\nname: y\ndescription: d\n---\n" } })),
    ).toThrowError(/must equal its directory/);
    expect(() => loadPluginDirectory(writeFixturePlugin(root, { name: "badmcp", files: { "mcp.json": "[]" } }))).toThrowError(/mcpServers/);
    expect(() => loadPluginDirectory(writeFixturePlugin(root, { name: "badmcp2", files: { "mcp.json": "{" } }))).toThrowError(/not valid JSON/);
    expect(() =>
      loadPluginDirectory(writeFixturePlugin(root, { name: "badmcp3", files: { "mcp.json": JSON.stringify({ mcpServers: { a: 1 } }) } })),
    ).toThrowError(/must be an object/);
    expect(() => loadPluginDirectory(writeFixturePlugin(root, { name: "notools", ogb: { tools: "tools/missing.js", effects: ["read"] } }))).toThrowError(
      /does not exist/,
    );
  });

  it("refuses symbolic links, which could point outside the plugin", () => {
    const root = temp();
    const dir = writeFixturePlugin(root, { name: "linky" });
    writeFileSync(join(root, "secret.txt"), "outside");
    symlinkSync(join(root, "secret.txt"), join(dir, "link.txt"));
    expect(() => loadPluginDirectory(dir)).toThrowError(/symbolic link/);
    try {
      loadPluginDirectory(dir);
    } catch (error) {
      expect(kind("denied")(error)).toBe(true);
    }
  });

  it("reads skill frontmatter with quotes", () => {
    expect(parseSkillFrontmatter("---\nname: \"a\"\ndescription: 'b c'\n---\nbody")).toEqual({ name: "a", description: "b c" });
    expect(parseSkillFrontmatter("nothing")).toEqual({});
  });
});

describe("marketplace", () => {
  const entry = (extra: Record<string, unknown> = {}) => ({ name: "demo", source: { type: "local", path: "./demo" }, ...extra });

  it("parses the Codex shape and defaults the policy", () => {
    const m = parseMarketplace({
      name: "mine",
      plugins: [entry({ category: "tools", policy: { installation: "INSTALLED_BY_DEFAULT", authentication: "ON_USE" } }), entry({ name: "other" })],
    });
    expect(m.plugins[0]?.policy).toEqual({ installation: "INSTALLED_BY_DEFAULT", authentication: "ON_USE" });
    expect(m.plugins[1]?.policy.installation).toBe("AVAILABLE");
  });

  it("reports every problem", () => {
    try {
      parseMarketplace({
        name: "Bad",
        plugins: [
          entry({ name: "Bad Name" }),
          entry({ sha256: "abc" }),
          entry({ source: { type: "local", path: "../up" } }),
          entry({ source: {} }),
          entry({ policy: { installation: "SOMETIMES" } }),
          3,
        ],
      });
      expect.unreachable();
    } catch (error) {
      const text = (error as Error).message;
      for (const part of [
        "name: required",
        "plugins[0].name",
        "plugins[1].sha256",
        "plugins[2].source.path",
        "plugins[3].source",
        "plugins[4].policy.installation",
        "plugins[5]: must be an object",
      ])
        expect(text).toContain(part);
    }
    expect(() => parseMarketplace(3)).toThrow();
    expect(() => parseMarketplace({ name: "m" })).toThrow(/plugins: must be a list/);
  });

  function setup() {
    const base = temp();
    const cache = join(base, "cache");
    writeFixturePlugin(join(base, "src"), { name: "demo", version: "1.0.0", toolsSource: toolSource([{ name: "demo_tool" }]), effects: ["read"] });
    return {
      base,
      cache,
      market: (extra: Record<string, unknown> = {}) =>
        parseMarketplace({ name: "mine", plugins: [{ name: "demo", source: { type: "local", path: "./src/demo" }, ...extra }] }),
    };
  }

  it("installs a local plugin into the cache as name@marketplace@version, read-only, and loads it from there", () => {
    const { base, cache, market } = setup();
    const result = installFromMarketplace({ marketplace: market(), baseDir: base, cacheDir: cache });
    expect(result.skipped).toEqual([]);
    const installed = result.installed[0];
    expect(installed?.identity).toBe("demo@mine@1.0.0");
    expect(installed?.root).toBe(join(cache, "mine", "demo", "1.0.0"));
    expect(() => writeFileSync(join(installed?.root as string, "plugin.json"), "{}")).toThrow(); // files are read-only
    expect(() => writeFileSync(join(installed?.root as string, "new.txt"), "x")).toThrow(); // and so is the directory
    expect(readFileSync(join(installed?.root as string, "plugin.json"), "utf8")).toContain("demo");
  });

  it("is idempotent, and refuses the same version with different contents", () => {
    const { base, cache, market } = setup();
    installFromMarketplace({ marketplace: market(), baseDir: base, cacheDir: cache });
    expect(installFromMarketplace({ marketplace: market(), baseDir: base, cacheDir: cache }).installed).toHaveLength(1);
    writeFileSync(join(base, "src/demo/extra.txt"), "changed");
    const again = installFromMarketplace({ marketplace: market(), baseDir: base, cacheDir: cache });
    expect(again.installed).toEqual([]);
    expect(again.skipped[0]?.reason).toMatch(/already installed with different contents/);
  });

  it("enforces the hash pin: a changed plugin is not installed until the owner updates the pin", () => {
    const { base, cache, market } = setup();
    const pinned = hashPluginDirectory(join(base, "src/demo"));
    expect(installFromMarketplace({ marketplace: market({ sha256: pinned }), baseDir: base, cacheDir: cache }).installed).toHaveLength(1);
    writeFileSync(join(base, "src/demo/tools/index.js"), "export function createTools() { return []; }");
    const result = installFromMarketplace({ marketplace: market({ sha256: pinned }), baseDir: base, cacheDir: join(base, "cache2") });
    expect(result.installed).toEqual([]);
    expect(result.skipped[0]?.reason).toMatch(/changed since they were pinned/);
    const repinned = hashPluginDirectory(join(base, "src/demo"));
    expect(installFromMarketplace({ marketplace: market({ sha256: repinned }), baseDir: base, cacheDir: join(base, "cache2") }).installed).toHaveLength(1);
  });

  it("skips what it cannot install without stopping the rest", () => {
    const base = temp();
    writeFixturePlugin(join(base, "src"), { name: "good" });
    writeFixturePlugin(join(base, "src"), { name: "renamed" });
    const marketplace = parseMarketplace({
      name: "mine",
      plugins: [
        { name: "remote", source: { type: "git", url: "https://x.example/r.git" } },
        { name: "hidden", source: { type: "local", path: "./src/good" }, policy: { installation: "NOT_AVAILABLE" } },
        { name: "absent", source: { type: "local", path: "./src/absent" } },
        { name: "wrong-name", source: { type: "local", path: "./src/renamed" } },
        { name: "good", source: { type: "local", path: "./src/good" } },
      ],
    });
    const result = installFromMarketplace({ marketplace, baseDir: base, cacheDir: join(base, "cache") });
    expect(result.installed.map((p) => p.identity)).toEqual(["good@mine@1.0.0"]);
    expect(Object.fromEntries(result.skipped.map((s) => [s.name, s.reason]))).toMatchObject({
      remote: expect.stringContaining("not supported yet"),
      hidden: "marked NOT_AVAILABLE",
      absent: expect.stringContaining("does not exist"),
      "wrong-name": expect.stringContaining("names 'renamed'"),
    });
    expect(installFromMarketplace({ marketplace, baseDir: base, cacheDir: join(base, "cache"), only: ["good"] }).installed).toHaveLength(1);
  });

  it("installing from a source that is a symbolic link copies real files and leaves the source untouched", () => {
    const base = temp();
    const real = writeFixturePlugin(join(base, "elsewhere"), { name: "linked", toolsSource: toolSource([{ name: "linked_tool" }]), effects: ["read"] });
    mkdirSync(join(base, "plugins"));
    symlinkSync(real, join(base, "plugins", "linked"));
    const marketplace = parseMarketplace({ name: "mine", plugins: [{ name: "linked", source: { type: "local", path: "./plugins/linked" } }] });
    const result = installFromMarketplace({ marketplace, baseDir: base, cacheDir: join(base, "cache") });
    expect(result.skipped).toEqual([]);
    expect(lstatSync(join(result.installed[0]?.root as string, "plugin.json")).isSymbolicLink()).toBe(false);
    writeFileSync(join(real, "plugin.json"), readFileSync(join(real, "plugin.json"), "utf8")); // the source is still writable
    expect(() => writeFileSync(join(real, "tools", "index.js"), "// still writable")).not.toThrow();
  });

  it("refuses a local source that leaves the marketplace directory, even when the catalogue was not parsed", () => {
    const base = temp();
    const marketplace = {
      name: "mine",
      plugins: [{ name: "demo", source: { type: "local", path: "./a/../../x" }, policy: { installation: "AVAILABLE" as const } }],
    };
    expect(() => parseMarketplace(marketplace)).toThrow(/relative path inside/); // the parser already refuses it
    const result = installFromMarketplace({ marketplace, baseDir: join(base, "inner"), cacheDir: join(base, "cache") });
    expect(result.skipped[0]?.reason).toMatch(/leaves the marketplace directory/);
  });
});

describe("plugin host", () => {
  function hostWith(specs: Parameters<typeof writeFixturePlugin>[1][]) {
    const root = temp();
    return createPluginHost(specs.map((spec) => loadPluginDirectory(writeFixturePlugin(root, spec))));
  }
  const contextFor = () => createFakeContext();

  it("gives each plugin only its PluginContext and returns its tools, skills and approval modes", async () => {
    const host = hostWith([
      {
        name: "alpha",
        toolsSource: toolSource([{ name: "alpha_read" }, { name: "alpha_send", effect: "network" }]),
        effects: ["read", "network"],
        approval: { alpha_read: "never" },
        skills: [{ name: "how", description: "d" }],
      },
    ]);
    const received: unknown[] = [];
    const snapshot = await host.instantiate({
      plugins: ["alpha"],
      contextFor: (plugin) => {
        const context = createFakeContext({ dataDir: `/data/${plugin.manifest.name}` });
        received.push(context);
        return context;
      },
    });
    expect(received).toHaveLength(1);
    expect((globalThis as { __lastPluginContext?: unknown }).__lastPluginContext).toBe(received[0]);
    expect(snapshot.tools.map((t) => t.name)).toEqual(["alpha_read", "alpha_send"]);
    expect(snapshot.toolOwners.alpha_read).toMatchObject({ plugin: "alpha", approval: "never" });
    expect(snapshot.toolOwners.alpha_send?.approval).toBe("auto"); // default for network: the review plugin judges it
    expect(snapshot.skills).toEqual([{ name: "how", description: "d", path: "skills/how/SKILL.md", plugin: "alpha" }]);
    expect(snapshot.plugins).toEqual([{ name: "alpha", version: "1.0.0" }]);
  });

  it("starts requirements first and finds circles and missing plugins", async () => {
    const host = hostWith([
      { name: "base", toolsSource: toolSource([{ name: "base_tool" }]), effects: ["read"] },
      { name: "top", toolsSource: toolSource([{ name: "top_tool" }]), effects: ["read"], requires: ["base"] },
      { name: "loop-a", requires: ["loop-b"] },
      { name: "loop-b", requires: ["loop-a"] },
      { name: "lonely", requires: ["ghost"] },
    ]);
    expect((await host.instantiate({ plugins: ["top"], contextFor })).tools.map((t) => t.name)).toEqual(["base_tool", "top_tool"]);
    await expect(host.instantiate({ plugins: ["loop-a"], contextFor })).rejects.toThrow(/circle: loop-a -> loop-b -> loop-a/);
    await expect(host.instantiate({ plugins: ["lonely"], contextFor })).rejects.toThrow(/'ghost' is not installed \(required by lonely\)/);
    await expect(host.instantiate({ plugins: ["nothing"], contextFor })).rejects.toSatisfy(kind("not_found"));
  });

  it("fingerprints the tools in order: the same plugins give the same fingerprint", async () => {
    const host = hostWith([
      { name: "one", toolsSource: toolSource([{ name: "one_tool" }]), effects: ["read"] },
      { name: "two", toolsSource: toolSource([{ name: "two_tool" }]), effects: ["read"] },
    ]);
    const first = await host.instantiate({ plugins: ["one", "two"], contextFor });
    const again = await host.instantiate({ plugins: ["one", "two"], contextFor });
    const fewer = await host.instantiate({ plugins: ["one"], contextFor });
    expect(first.tools.map((t) => t.name)).toEqual(["one_tool", "two_tool"]);
    expect(again.fingerprint).toBe(first.fingerprint);
    expect(fewer.fingerprint).not.toBe(first.fingerprint);
    expect(first.fingerprint).toBe(toolFingerprint(first.tools));
  });

  it("freezes the snapshot so nothing can add or remove a tool in the middle of a conversation", async () => {
    const host = hostWith([{ name: "one", toolsSource: toolSource([{ name: "one_tool" }]), effects: ["read"] }]);
    const snapshot = await host.instantiate({ plugins: ["one"], contextFor });
    expect(Object.isFrozen(snapshot)).toBe(true);
    expect(() => (snapshot.tools as unknown[]).push({})).toThrow();
    expect(() => (snapshot.tools as unknown[]).pop()).toThrow();
    expect(() => {
      (snapshot.toolOwners as Record<string, unknown>).extra = {};
    }).toThrow();
  });

  it("asks only for irreversible tools by default", async () => {
    const host = hostWith([
      {
        name: "mailer",
        toolsSource: toolSource([
          { name: "send_mail", effect: "irreversible" },
          { name: "run_it", effect: "exec" },
        ]),
        effects: ["irreversible", "exec"],
      },
    ]);
    const snapshot = await host.instantiate({ plugins: ["mailer"], contextFor });
    expect(snapshot.toolOwners.send_mail?.approval).toBe("ask");
    expect(snapshot.toolOwners.run_it?.approval).toBe("auto");
  });

  it("collects the prompt sections of the plugins in the session, in plugin order", async () => {
    const host = hostWith([{ name: "first", promptSection: "# First\nrules\n" }, { name: "second", promptSection: "second rules" }, { name: "silent" }]);
    const snapshot = await host.instantiate({ plugins: ["second", "silent", "first"], contextFor });
    expect(snapshot.promptSections).toEqual([
      { plugin: "second", text: "second rules" },
      { plugin: "first", text: "# First\nrules" },
    ]);
  });

  it("refuses a prompt section outside the plugin or missing", () => {
    const root = temp();
    expect(() => loadPluginDirectory(writeFixturePlugin(root, { name: "missing", ogb: { promptSection: "nope.md" } }))).toThrow(/does not exist/);
    expect(() => loadPluginDirectory(writeFixturePlugin(root, { name: "outside", ogb: { promptSection: "../x.md" } }))).toThrow(/inside the plugin directory/);
  });

  it("refuses a tool whose effect the manifest does not declare", async () => {
    const host = hostWith([{ name: "liar", toolsSource: toolSource([{ name: "liar_tool", effect: "exec" }]), effects: ["read"] }]);
    await expect(host.instantiate({ plugins: ["liar"], contextFor })).rejects.toSatisfy(kind("denied"));
    await expect(host.instantiate({ plugins: ["liar"], contextFor })).rejects.toThrow(/effect 'exec'/);
  });

  it("a plugin cannot take any core tool name, workspace_info included (it would replace the core tool)", async () => {
    for (const name of Object.values(CORE_TOOL_NAMES).flat()) {
      const host = hostWith([{ name: "thief", toolsSource: toolSource([{ name }]), effects: ["read"] }]);
      await expect(host.instantiate({ plugins: ["thief"], contextFor }), name).rejects.toThrow(/reserved/);
    }
  });

  it("refuses reserved names and duplicate names across plugins", async () => {
    const host = hostWith([
      { name: "thief", toolsSource: toolSource([{ name: "bash" }]), effects: ["read"] },
      { name: "a", toolsSource: toolSource([{ name: "same" }]), effects: ["read"] },
      { name: "b", toolsSource: toolSource([{ name: "same" }]), effects: ["read"] },
    ]);
    expect(RESERVED_TOOL_NAMES).toContain("tool_call");
    expect([...RESERVED_TOOL_NAMES].sort()).toEqual([...Object.values(CORE_TOOL_NAMES).flat()].sort());
    await expect(host.instantiate({ plugins: ["thief"], contextFor })).rejects.toThrow(/reserved/);
    await expect(host.instantiate({ plugins: ["a", "b"], contextFor })).rejects.toThrow(/defined by both 'a' and 'b'/);
  });

  it("refuses bad tool modules", async () => {
    const cases: [string, string, RegExp][] = [
      ["no-export", "export const x = 1;", /must export createTools/],
      ["not-list", "export function createTools() { return 3; }", /return a list/],
      [
        "bad-name",
        "export function createTools() { return [{ name: 'Bad', description: 'd', parameters: {}, effect: 'read', execute() {} }]; }",
        /missing or invalid name/,
      ],
      ["bad-shape", "export function createTools() { return [{ name: 'ok', effect: 'read' }]; }", /needs description/],
      ["syntax", "export function createTools( {", /cannot load/],
    ];
    const host = hostWith(cases.map(([name, source]) => ({ name, toolsSource: source, effects: ["read"] })));
    for (const [name, , pattern] of cases) await expect(host.instantiate({ plugins: [name], contextFor }), name).rejects.toThrow(pattern);
  });

  it("loads event sources and refuses bad ones", async () => {
    const good = `export function createSources(ctx) { return [{ name: "watch", start() { ctx.signals.emit("s1", { id: "1", source: "plugin:good", text: "hi" }); }, stop() {} }]; }`;
    const host = hostWith([
      { name: "good", sourcesSource: good },
      { name: "nofn", sourcesSource: "export const x = 1;" },
      { name: "badlist", sourcesSource: "export function createSources() { return [{}]; }" },
    ]);
    const emitted: unknown[] = [];
    const snapshot = await host.instantiate({
      plugins: ["good"],
      contextFor: () => createFakeContext({ signals: { emit: (target, draft) => void emitted.push([target, draft]) } }),
    });
    expect(snapshot.sources.map((s) => s.name)).toEqual(["watch"]);
    await snapshot.sources[0]?.start();
    expect(emitted).toEqual([["s1", { id: "1", source: "plugin:good", text: "hi" }]]);
    await expect(host.instantiate({ plugins: ["nofn"], contextFor })).rejects.toThrow(/must export createSources/);
    await expect(host.instantiate({ plugins: ["badlist"], contextFor })).rejects.toThrow(/list of \{ name, start, stop \}/);
  });

  it("refuses duplicates and passes, and passes MCP servers through", async () => {
    const root = temp();
    const one = loadPluginDirectory(
      writeFixturePlugin(root, { name: "mcp-only", files: { "mcp.json": JSON.stringify({ mcpServers: { s: { command: "c" } } }) } }),
    );
    const host = createPluginHost([one]);
    expect(() => createPluginHost([one, one])).toThrow(/two plugins are named/);
    expect((await host.instantiate({ plugins: ["mcp-only"], contextFor })).mcpServers).toEqual([{ name: "s", config: { command: "c" }, plugin: "mcp-only" }]);
    chmodSync(root, 0o755);
  });
});
