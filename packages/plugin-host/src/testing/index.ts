import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { PluginContext } from "@vesper/contracts";

export interface FixturePluginSpec {
  name: string;
  version?: string;
  /** Raw source of tools/index.js. */
  toolsSource?: string;
  sourcesSource?: string;
  effects?: string[];
  requires?: string[];
  approval?: Record<string, string>;
  skills?: { name: string; description: string; body?: string }[];
  extra?: Record<string, unknown>;
  ogb?: Record<string, unknown>;
  files?: Record<string, string>;
  /** Text of a prompt section; written to prompt.md and named in the manifest. */
  promptSection?: string;
}

/** Writes a small plugin directory for tests and returns it. */
export function writeFixturePlugin(root: string, spec: FixturePluginSpec): string {
  const dir = join(root, spec.name);
  const write = (path: string, content: string) => {
    mkdirSync(dirname(join(dir, path)), { recursive: true });
    writeFileSync(join(dir, path), content);
  };
  const ogb: Record<string, unknown> = { ...spec.ogb };
  if (spec.toolsSource !== undefined) ogb.tools = "tools/index.js";
  if (spec.sourcesSource !== undefined) ogb.sources = "sources/index.js";
  if (spec.promptSection !== undefined) ogb.promptSection = "prompt.md";
  if (spec.effects) ogb.effects = spec.effects;
  if (spec.requires) ogb.requires = spec.requires;
  if (spec.approval) ogb.approval = spec.approval;
  write(
    "plugin.json",
    JSON.stringify(
      { name: spec.name, version: spec.version ?? "1.0.0", description: `fixture ${spec.name}`, ...spec.extra, extensions: { vesper: ogb } },
      null,
      2,
    ),
  );
  if (spec.toolsSource !== undefined) write("tools/index.js", spec.toolsSource);
  if (spec.sourcesSource !== undefined) write("sources/index.js", spec.sourcesSource);
  if (spec.promptSection !== undefined) write("prompt.md", spec.promptSection);
  for (const skill of spec.skills ?? [])
    write(`skills/${skill.name}/SKILL.md`, `---\nname: ${skill.name}\ndescription: ${skill.description}\n---\n${skill.body ?? "Steps."}\n`);
  for (const [path, content] of Object.entries(spec.files ?? {})) write(path, content);
  return dir;
}

/** Tool source with one tool of the given name and effect. */
export function toolSource(tools: { name: string; effect?: string; description?: string }[]): string {
  const items = tools.map(
    (t) =>
      `{ name: ${JSON.stringify(t.name)}, description: ${JSON.stringify(t.description ?? `tool ${t.name}`)}, parameters: { type: "object", properties: {} }, effect: ${JSON.stringify(t.effect ?? "read")}, async execute() { return { content: [{ type: "text", text: ${JSON.stringify(`${t.name} ran`)} }] }; } }`,
  );
  return `export function createTools(ctx) { globalThis.__lastPluginContext = ctx; return [${items.join(", ")}]; }\n`;
}

/** A context whose parts record what plugins do. */
export function createFakeContext(overrides: Partial<PluginContext> = {}): PluginContext {
  return {
    workspace: {
      workspaceId: "ws-test",
      filesDir: "/tmp/ws-test/files",
      run: async () => ({ exitCode: 0, stdout: "", stderr: "", timedOut: false, truncated: false }),
      spawn: () => {
        throw new Error("the fake context starts no programs");
      },
    },
    secrets: { resolve: async (reference) => Promise.reject(new Error(`no secret ${reference} in the fake context`)) },
    signals: { emit: () => {} },
    dataDir: "/tmp/ws-test/data",
    sharedDataDir: "/tmp/shared/data",
    log: { info: () => {}, warn: () => {}, error: () => {} },
    ...overrides,
  };
}
