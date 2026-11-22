import { createHash } from "node:crypto";
import { pathToFileURL } from "node:url";
import { CORE_TOOL_NAMES, OgbError, type PluginContext } from "@standin/contracts";
import type { Tool } from "sakura-agent";
import { resolveInside } from "./files.ts";
import type { LoadedPlugin, McpServerEntry, SkillInfo } from "./loader.ts";
import type { ApprovalMode, Effect } from "./manifest.ts";

/** Names the runtime itself owns; a plugin may not define a tool with one of them. */
export const RESERVED_TOOL_NAMES: readonly string[] = Object.values(CORE_TOOL_NAMES).flat();

const TOOL_NAME = /^[a-z][a-z0-9_]*$/;

/** A thing a plugin watches (a mailbox, a calendar). The runtime starts it; it reports through `ctx.signals`. */
export interface EventSourceHandle {
  name: string;
  start(): void | Promise<void>;
  stop(): void | Promise<void>;
}

export interface PluginTool {
  plugin: string;
  tool: Tool;
  approval: ApprovalMode;
}

/**
 * What a session gets from the plugin host. It is a snapshot: frozen when made, and nothing the host does later
 * (enabling, disabling, installing another version) changes it. That is the rule "a session's tool list never changes
 * between turns" in code; the runtime keeps this object for the life of the session.
 */
export interface SessionPlugins {
  readonly plugins: readonly { name: string; version: string }[];
  readonly tools: readonly Tool[];
  readonly toolOwners: Readonly<Record<string, PluginTool>>;
  readonly sources: readonly EventSourceHandle[];
  readonly skills: readonly (SkillInfo & { plugin: string })[];
  readonly mcpServers: readonly (McpServerEntry & { plugin: string })[];
  /** Sections plugins add to AGENTS.md, in plugin order. */
  readonly promptSections: readonly { plugin: string; text: string }[];
  /** Hash of names, descriptions, schemas and effects of the tools in order; equal fingerprints mean the model sees the same tools. */
  readonly fingerprint: string;
}

export interface InstantiateOptions {
  /** Plugins the session's profile asks for, by name. Plugins they `require` are added. */
  plugins: readonly string[];
  /** Builds the one context object a plugin receives. Called once per plugin. */
  contextFor(plugin: LoadedPlugin): PluginContext;
}

export interface PluginHost {
  instantiate(options: InstantiateOptions): Promise<SessionPlugins>;
}

/**
 * Decided by the lead (2026-11-11): everything runs without asking except what cannot be undone. The review plugin still
 * judges exec and network calls; asking a person for every shell command or page visit would make an always-on agent unusable.
 */
function defaultApproval(effect: Effect): ApprovalMode {
  return effect === "irreversible" ? "ask" : "auto";
}

export function toolFingerprint(tools: readonly Tool[]): string {
  const hash = createHash("sha256");
  for (const tool of tools)
    hash.update(JSON.stringify([tool.name, tool.description, tool.parameters, tool.effect, tool.replay ?? "safe", tool.executionMode ?? "parallel"]));
  return `sha256:${hash.digest("hex")}`;
}

export function createPluginHost(plugins: readonly LoadedPlugin[]): PluginHost {
  const byName = new Map<string, LoadedPlugin>();
  for (const plugin of plugins) {
    if (byName.has(plugin.manifest.name)) throw new OgbError("conflict", `two plugins are named '${plugin.manifest.name}'`);
    byName.set(plugin.manifest.name, plugin);
  }

  /** The requested plugins plus everything they require, dependencies first. */
  function order(requested: readonly string[]): LoadedPlugin[] {
    const result: LoadedPlugin[] = [];
    const done = new Set<string>();
    const visiting: string[] = [];
    const visit = (name: string) => {
      if (done.has(name)) return;
      if (visiting.includes(name)) throw new OgbError("invalid_input", `plugins require each other in a circle: ${[...visiting, name].join(" -> ")}`);
      const plugin = byName.get(name);
      if (!plugin)
        throw new OgbError("not_found", `plugin '${name}' is not installed${visiting.length > 0 ? ` (required by ${visiting[visiting.length - 1]})` : ""}`);
      visiting.push(name);
      for (const required of plugin.manifest.ogb.requires ?? []) visit(required);
      visiting.pop();
      done.add(name);
      result.push(plugin);
    };
    for (const name of requested) visit(name);
    return result;
  }

  return {
    async instantiate(options) {
      const tools: Tool[] = [];
      const toolOwners: Record<string, PluginTool> = {};
      const sources: EventSourceHandle[] = [];
      const skills: (SkillInfo & { plugin: string })[] = [];
      const mcpServers: (McpServerEntry & { plugin: string })[] = [];
      const promptSections: { plugin: string; text: string }[] = [];
      const used: { name: string; version: string }[] = [];

      for (const plugin of order(options.plugins)) {
        const name = plugin.manifest.name;
        used.push({ name, version: plugin.manifest.version });
        if (plugin.promptSection) promptSections.push({ plugin: name, text: plugin.promptSection });
        skills.push(...plugin.skills.map((s) => ({ ...s, plugin: name })));
        mcpServers.push(...plugin.mcpServers.map((m) => ({ ...m, plugin: name })));
        const context = options.contextFor(plugin);
        for (const tool of await loadTools(plugin, context)) {
          if (RESERVED_TOOL_NAMES.includes(tool.name)) throw new OgbError("conflict", `plugin '${name}': tool name '${tool.name}' is reserved by the runtime`);
          const owner = toolOwners[tool.name];
          if (owner) throw new OgbError("conflict", `tool '${tool.name}' is defined by both '${owner.plugin}' and '${name}'`);
          tools.push(tool);
          toolOwners[tool.name] = { plugin: name, tool, approval: plugin.manifest.ogb.approval?.[tool.name] ?? defaultApproval(tool.effect) };
        }
        sources.push(...(await loadSources(plugin, context)));
      }
      const snapshot: SessionPlugins = {
        plugins: Object.freeze(used),
        tools: Object.freeze(tools),
        toolOwners: Object.freeze(toolOwners),
        sources: Object.freeze(sources),
        skills: Object.freeze(skills),
        mcpServers: Object.freeze(mcpServers),
        promptSections: Object.freeze(promptSections),
        fingerprint: toolFingerprint(tools),
      };
      return Object.freeze(snapshot);
    },
  };
}

async function importModule(plugin: LoadedPlugin, relativePath: string): Promise<Record<string, unknown>> {
  const real = resolveInside(plugin.root, relativePath);
  try {
    return (await import(/* @vite-ignore */ pathToFileURL(real).href)) as Record<string, unknown>;
  } catch (cause) {
    throw new OgbError("unavailable", `plugin '${plugin.manifest.name}': cannot load ${relativePath}`, { cause });
  }
}

async function loadTools(plugin: LoadedPlugin, context: PluginContext): Promise<Tool[]> {
  const path = plugin.manifest.ogb.tools;
  if (path === undefined) return [];
  const name = plugin.manifest.name;
  const create = (await importModule(plugin, path)).createTools;
  if (typeof create !== "function") throw new OgbError("invalid_input", `plugin '${name}': ${path} must export createTools(ctx)`);
  const tools = await create(context);
  if (!Array.isArray(tools)) throw new OgbError("invalid_input", `plugin '${name}': createTools must return a list of tools`);
  const declared = plugin.manifest.ogb.effects ?? [];
  for (const tool of tools as Tool[]) {
    if (typeof tool?.name !== "string" || !TOOL_NAME.test(tool.name))
      throw new OgbError("invalid_input", `plugin '${name}': a tool has a missing or invalid name (lower-case letters, digits, '_')`);
    if (typeof tool.description !== "string" || typeof tool.execute !== "function" || typeof tool.parameters !== "object" || tool.parameters === null) {
      throw new OgbError("invalid_input", `plugin '${name}': tool '${tool.name}' needs description, parameters and execute`);
    }
    if (!declared.includes(tool.effect)) {
      throw new OgbError(
        "denied",
        `plugin '${name}': tool '${tool.name}' has effect '${tool.effect}', which the manifest does not declare (${declared.join(", ")})`,
      );
    }
  }
  return tools as Tool[];
}

async function loadSources(plugin: LoadedPlugin, context: PluginContext): Promise<EventSourceHandle[]> {
  const path = plugin.manifest.ogb.sources;
  if (path === undefined) return [];
  const name = plugin.manifest.name;
  const create = (await importModule(plugin, path)).createSources;
  if (typeof create !== "function") throw new OgbError("invalid_input", `plugin '${name}': ${path} must export createSources(ctx)`);
  const sources = await create(context);
  if (!Array.isArray(sources) || !sources.every((s) => typeof s?.name === "string" && typeof s.start === "function" && typeof s.stop === "function")) {
    throw new OgbError("invalid_input", `plugin '${name}': createSources must return a list of { name, start, stop }`);
  }
  return sources as EventSourceHandle[];
}
