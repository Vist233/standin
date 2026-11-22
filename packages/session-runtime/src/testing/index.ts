import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { RunOptions, RunResult } from "@vesper/contracts";
import { createModelRegistry, parseModelConfig } from "@vesper/model-registry";
import { createPluginHost, loadPluginDirectory, type LoadedPlugin } from "@vesper/plugin-host";
import { parseProfileConfig } from "@vesper/profiles";
import { createFakeSecrets } from "@vesper/secrets/testing";
import { createFileSessionStore } from "@vesper/session-store";
import type { FauxClient, FauxScript } from "sakura-agent/testing";
import { createFauxClient } from "sakura-agent/testing";
import { spawnInWorkspace, workspaceEnvironment } from "../run-command.ts";
import { createSessionRuntime, type SessionRuntime } from "../runtime.ts";
import type { SessionRuntimeDeps, WorkspaceInfo, WorkspaceProvider } from "../types.ts";

export interface FakeRunCall {
  command: readonly string[];
  options: RunOptions | undefined;
}

/** Workspaces that are plain directories under `root`; records calls so tests can see create and destroy. */
export function createFakeWorkspaces(
  root: string,
  extra: { display?: string; cdpUrl?: string } = {},
): WorkspaceProvider & {
  ensured: string[];
  destroyed: string[];
  failFor: Set<string>;
  runs: FakeRunCall[];
  onRun: { handler: (call: FakeRunCall) => RunResult | Promise<RunResult> };
} {
  const ensured: string[] = [];
  const destroyed: string[] = [];
  const failFor = new Set<string>();
  const runs: FakeRunCall[] = [];
  /** What a fake `run` answers; replace `handler` to script a worker or a tool. By default: exit 0 with no output. */
  const onRun = {
    handler: (_call: FakeRunCall): RunResult | Promise<RunResult> => ({ exitCode: 0, stdout: "", stderr: "", timedOut: false, truncated: false }),
  };
  return {
    runs,
    onRun,
    ensured,
    destroyed,
    failFor,
    async ensure(sessionId): Promise<WorkspaceInfo> {
      if (failFor.has(sessionId) || failFor.has("*")) throw new Error(`workspace for ${sessionId} cannot start (fake)`);
      ensured.push(sessionId);
      const filesDir = join(root, "workspaces", sessionId, "files");
      mkdirSync(filesDir, { recursive: true });
      return {
        workspaceId: sessionId,
        filesDir,
        hasDisplay: true,
        hasBrowser: true,
        ...extra,
        environment: workspaceEnvironment({ workspaceId: sessionId, filesDir, ...extra }),
        run: async (command, options) => {
          const call = { command, options };
          runs.push(call);
          return onRun.handler(call);
        },
        spawn: (command, options) => spawnInWorkspace({ workspaceId: sessionId, filesDir, ...extra }, command, options),
      };
    },
    async destroy(sessionId) {
      destroyed.push(sessionId);
    },
  };
}

export interface RigOptions {
  /** Directory that holds the sessions; defaults to a fresh temporary one. Pass the same one to build a second rig that "restarts" the box. */
  root?: string;
  script?: FauxScript;
  plugins?: LoadedPlugin[];
  profiles?: unknown;
  runtime?: Partial<SessionRuntimeDeps>;
  /** Display and DevTools addresses the fake workspaces report (`fake:...` selects the demo backends of the browser and computer plugins). */
  workspace?: { display?: string; cdpUrl?: string };
  /** Use the framework's real review and redaction plugins instead of none. */
  realSafety?: boolean;
}

export interface Rig {
  runtime: SessionRuntime;
  root: string;
  faux: FauxClient;
  workspaces: ReturnType<typeof createFakeWorkspaces>;
  deps: SessionRuntimeDeps;
  cleanup(): Promise<void>;
}

export const DEFAULT_PROFILES = {
  default: "general",
  profiles: { general: { plugins: [], optionalPlugins: [] }, withplugins: { plugins: ["demo"], alwaysDeclaredTools: ["gated"] } },
};

/** A runtime wired to a scripted model (the framework's real faux client) and fake workspaces, over real files. */
export function createRig(options: RigOptions = {}): Rig {
  const root = options.root ?? mkdtempSync(join(tmpdir(), "ogb-rig-"));
  const faux = createFauxClient(options.script ?? [{ text: "ok" }]);
  const models = createModelRegistry({
    config: parseModelConfig({ models: { main: { baseUrl: "https://faux.example/v1", model: "faux", contextWindow: 100_000, apiKey: "env:KEY" } } }),
    secrets: createFakeSecrets({ "env:KEY": "k" }),
    createClient: () => faux,
  });
  const workspaces = createFakeWorkspaces(root, options.workspace);
  const deps: SessionRuntimeDeps = {
    store: createFileSessionStore({ root }),
    models,
    profiles: parseProfileConfig(options.profiles ?? DEFAULT_PROFILES),
    pluginHost: createPluginHost(options.plugins ?? []),
    workspaces,
    secrets: createFakeSecrets({}),
    ...(options.realSafety ? {} : { safetyPlugins: () => [] }), // tests of the loop do not want a reviewer spending scripted turns
    routerOptions: { retryDelayMs: 0 },
    ...options.runtime,
  };
  const runtime = createSessionRuntime(deps);
  return {
    runtime,
    root,
    faux,
    workspaces,
    deps,
    async cleanup() {
      await runtime.close();
      if (!options.root) rmSync(root, { recursive: true, force: true });
    },
  };
}

export function loadPlugins(...dirs: string[]): LoadedPlugin[] {
  return dirs.map((dir) => loadPluginDirectory(dir));
}

/** The text of the last user message of a request: how scripts can answer by content. */
/** The framework's own note at the end of every request (sakura-agent's limits plugin: "[Limits: 3 of 15 minutes used.]"), not something the person wrote. */
export const isFrameworkNote = (text: string): boolean => /^\[Limits: [^\]]*\]$/.test(text);

/** The texts of the user messages a scripted model received, without the framework's note. */
export function userTexts(request: { messages: { role: string; content: { type: string; text?: string }[] }[] }): string[] {
  return request.messages
    .filter((m) => m.role === "user")
    .map((m) => m.content.map((c) => (c.type === "text" ? (c.text ?? "") : "")).join(""))
    .filter((text) => !isFrameworkNote(text));
}

/** The last message a scripted model received that is not the framework's note (a tool result, a signal, the person's text). */
export function lastMessage<M extends { role: string; content: { type: string; text?: string }[] }>(request: { messages: M[] }): M | undefined {
  return [...request.messages]
    .reverse()
    .find((m) => !(m.role === "user" && isFrameworkNote(m.content.map((c) => (c.type === "text" ? (c.text ?? "") : "")).join(""))));
}

/** The last thing the person (or a signal) wrote. */
export function lastUserText(request: { messages: { role: string; content: { type: string; text?: string }[] }[] }): string {
  return userTexts(request).at(-1) ?? "";
}
