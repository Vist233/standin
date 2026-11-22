import { existsSync } from "node:fs";
import { mkdir, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { renderAgentsMd } from "@standin/agents-md";
import { CORE_TOOL_NAMES, OgbError, type Outgoing, type PluginContext, type SessionEvent, type SignalDraft } from "@standin/contracts";
import { createFileJournal, type EventJournal } from "@standin/event-journal";
import type { LoadedPlugin } from "@standin/plugin-host";
import type { ResolvedProfile } from "@standin/profiles";
import type { SessionRecord } from "@standin/session-store";
import { type Agent, corePlugins, createAgent, limitsPlugin } from "sakura-agent";
import { SessionActor } from "./actor.ts";
import { ApprovalBook, gate } from "./approvals.ts";
import { createCoreTools } from "./core-tools.ts";
import { json } from "./events.ts";
import { workspaceShell } from "./agent-environment.ts";
import { createPersonTool, personPlugin } from "./person.ts";
import { createSessionSearchTool } from "./session-search.ts";
import { skillsPlugin } from "./skills.ts";
import type { HookRegistry } from "./hooks.ts";
import type { Scheduler } from "./scheduler.ts";
import { lastReply, summarize, summarySource } from "./summary.ts";
import { defaultSafetyPlugins, switchableReview } from "./safety.ts";
import { type Authorize, createSearchTools } from "./search-tools.ts";
import { deliverQueued, endTakeover, questionTimedOut, handbackTimedOut } from "./takeover.ts";
import type { SessionRuntimeDeps } from "./types.ts";
import { waitingForPersonPlugin } from "./waiting-plugin.ts";
import { createWaitWatcher, type WaitWatcher } from "./waits.ts";

/** One session, assembled and running. The runtime keeps these by id. */
export interface OpenSession {
  actor: SessionActor;
  agent: Agent;
  journal: EventJournal;
  profile: ResolvedProfile;
  stopUnits: () => Promise<void>;
  approvals: ApprovalBook;
  /** Yolo, as the person last switched it: read by the approval gate and the reviewer at every tool call. */
  yolo: { on: boolean };
  workspaceId: string;
  /** Where the session's files are, as the agent's tools see the path. */
  filesDir: string;
  waits: WaitWatcher;
}

/** The part of the framework's review plugin that `tool_call` uses. */
interface ReviewLike {
  authorize(...args: never[]): unknown;
  exempt?(toolName: string): void;
}

const DEFAULT_TURNS_PER_RUN = 40;
const DEFAULT_RUN_SECONDS = 900;

/** What assembling a session needs from the runtime that owns it. */
export interface AssemblyContext {
  deps: SessionRuntimeDeps;
  now: () => number;
  log: (sessionId: string, entry: Record<string, unknown>) => void;
  /** How a plugin's signal reaches a session (the runtime's own `signal`, which checks the source). */
  signal: (sessionId: string, draft: SignalDraft) => Promise<void>;
  /** The bots' clock (scheduled wake-ups). */
  scheduler: Scheduler;
  /** The bots' webhooks. */
  hooks: HookRegistry;
  /** The person's profile shared by all bots (USER.md). */
  personFile: string;
  /** True once after a scheduled job was delivered to this bot: the run's reply is then a notice for the person. */
  takeNotice: (sessionId: string) => boolean;
  /** Reads a bot's journal (for `session_search` across bots). */
  readJournal: (sessionId: string) => Promise<readonly SessionEvent[]>;
  /** Gives the person something on every channel (the page first). */
  deliver: (message: Outgoing) => Promise<void>;
}

/** The session's AGENTS.md: written for a new session, and again if the file is gone; an existing one is the agent's to keep editing. */
async function writeAgentsMd(input: {
  profile: ResolvedProfile;
  title: string;
  downloadPath: string;
  sharedFolder: string;
  workspace: { filesDir: string; hasDisplay: boolean; hasBrowser: boolean };
  promptSections: readonly { plugin: string; text: string }[];
  fresh: boolean;
}): Promise<void> {
  const file = join(input.workspace.filesDir, "AGENTS.md");
  if (!input.fresh && existsSync(file)) return;
  await mkdir(input.workspace.filesDir, { recursive: true });
  await writeFile(
    file,
    renderAgentsMd({
      profile: input.profile,
      sessionName: input.title,
      downloadPath: input.downloadPath,
      sharedFolder: input.sharedFolder,
      baseTools: [...CORE_TOOL_NAMES.original, ...CORE_TOOL_NAMES.search],
      workspace: { filesDir: input.workspace.filesDir, hasDisplay: input.workspace.hasDisplay, hasBrowser: input.workspace.hasBrowser },
      pluginSections: [...input.promptSections],
    }),
  );
}

/**
 * Builds everything one session needs, in the one order that works: workspace, plugins, AGENTS.md, model and safety
 * plugins, tool catalogue, agent, journal, wait limits, actor. `bridge.actor` is set last, after the actor has opened: until
 * then a tool that announces something (it cannot happen before the first run) would find no actor and say nothing.
 */
export async function assembleSession(ctx: AssemblyContext, record: SessionRecord, fresh: boolean): Promise<OpenSession> {
  const { deps, now, log } = ctx;
  const profile = record.profile as unknown as ResolvedProfile;
  const paths = deps.store.paths(record.id);
  const workspace = await deps.workspaces.ensure(record.id);

  const contextFor = (plugin: LoadedPlugin): PluginContext => ({
    workspace,
    secrets: deps.secrets,
    signals: {
      emit: (target, draft) => {
        // A plugin may speak only as itself: it cannot pose as the person or as the system.
        if (draft.source !== `plugin:${plugin.manifest.name}`)
          throw new OgbError("denied", `plugin '${plugin.manifest.name}' may only emit signals with source 'plugin:${plugin.manifest.name}'`);
        return ctx.signal(target === "self" ? record.id : target, draft);
      },
    },
    dataDir: join(paths.dataDirectory, plugin.manifest.name),
    sharedDataDir: deps.store.sharedDirectory(plugin.manifest.name),
    log: {
      info: (message, fields) => log(record.id, { level: "info", plugin: plugin.manifest.name, message, ...fields }),
      warn: (message, fields) => log(record.id, { level: "warn", plugin: plugin.manifest.name, message, ...fields }),
      error: (message, fields) => log(record.id, { level: "error", plugin: plugin.manifest.name, message, ...fields }),
    },
  });
  const snapshot = await deps.pluginHost.instantiate({ plugins: profile.plugins, contextFor });

  // The folder every bot shares (docs/18 section 4): one directory, linked as `shared/` into each bot's files.
  const sharedDir = deps.store.sharedDirectory("files");
  await mkdir(sharedDir, { recursive: true });
  await symlink(sharedDir, join(workspace.filesDir, "shared")).catch((error: NodeJS.ErrnoException) => {
    if (error.code !== "EEXIST") log(record.id, { level: "warn", message: "the shared folder could not be linked", error: String(error) });
  });
  // Skills every bot shares (docs/20 part 7): found, downloaded and written by the bots themselves, linked as `skills/`.
  const skillsDir = deps.store.sharedDirectory("skills");
  await mkdir(skillsDir, { recursive: true });
  await symlink(skillsDir, join(workspace.filesDir, "skills")).catch((error: NodeJS.ErrnoException) => {
    if (error.code !== "EEXIST") log(record.id, { level: "warn", message: "the skills folder could not be linked", error: String(error) });
  });
  await writeAgentsMd({
    profile,
    title: record.title,
    downloadPath: `/api/sessions/${record.id}/files/`,
    sharedFolder: join(workspace.filesDir, "shared"),
    workspace,
    promptSections: snapshot.promptSections,
    fresh,
  });

  const llm = await deps.models.get(profile.model);
  const yolo = { on: record.yolo === true };
  const unchecked = () => yolo.on;
  const safety = (deps.safetyPlugins ?? defaultSafetyPlugins)(profile.floor, llm, deps.reviewPolicy).map((plugin) => switchableReview(plugin, unchecked));

  // Tools: the original four, then `tool_search` and `tool_call`, then the tools the profile asks to be declared. Everything
  // else (core tools and plugin tools) is found by search. Each tool is wrapped by the approval mode of its manifest.
  const approvals = new ApprovalBook();
  const bridge: { actor?: SessionActor } = {};
  const announce = async (type: string, payload: unknown) => {
    await bridge.actor?.announce(type, json(payload));
  };
  const catalog = [
    ...[
      ...createCoreTools({
        announce,
        tell: async (kind, text) => ctx.deliver({ sessionId: record.id, from: (await deps.store.get(record.id)).title, kind, text, at: now() }),
        workspace,
        sessionId: record.id,
        scheduler: ctx.scheduler,
        hooks: ctx.hooks,
        hookBaseUrl: deps.hookBaseUrl,
      }),
      createPersonTool(ctx.personFile),
      createSessionSearchTool({
        bots: async () => (await deps.store.list()).sessions.filter((s) => s.status === "active").map(({ id, title }) => ({ id, title })),
        read: (id) => (id === record.id ? journal.read(id) : ctx.readJournal(id)),
      }),
    ].map((tool) => gate(tool, { mode: "auto", book: approvals, announce })),
    ...snapshot.tools.map((tool) => gate(tool, { mode: snapshot.toolOwners[tool.name]?.approval ?? "auto", book: approvals, announce, bypass: unchecked })),
  ];
  const reviewer = safety.find((plugin) => typeof (plugin as { authorize?: unknown }).authorize === "function") as ReviewLike | undefined;
  reviewer?.exempt?.("tool_call"); // the inner call is reviewed under its own name by `tool_call` itself (search-tools.ts)
  const searchTools = createSearchTools({ catalog, ...(reviewer ? { authorize: reviewer.authorize.bind(reviewer) as Authorize } : {}) });
  const declared = new Set(profile.alwaysDeclaredTools);

  // The framework's core set already holds a limits plugin; two with one name are refused, so ours takes its place.
  const turnsPerRun = deps.limits?.turnsPerRun ?? DEFAULT_TURNS_PER_RUN;
  const tokensPerRun = deps.limits?.tokensPerRun;
  const runSeconds = deps.limits?.runSeconds ?? DEFAULT_RUN_SECONDS;
  const limits = limitsPlugin({ maxRunSeconds: runSeconds });
  const core = corePlugins().map((plugin) => (plugin.name === limits.name ? limits : plugin));
  const makeAgent = deps.createAgent ?? createAgent;
  const shell = workspaceShell(workspace.filesDir, workspace.environment);
  const agent = await makeAgent({
    model: llm,
    cwd: workspace.filesDir,
    environment: shell,
    tools: [...CORE_TOOL_NAMES.original, ...searchTools, ...catalog.filter((tool) => declared.has(tool.name))],
    plugins: [...safety, ...core, waitingForPersonPlugin(), personPlugin(ctx.personFile), skillsPlugin(skillsDir)],
    ...(deps.models.maxTokens(profile.model) !== undefined ? { maxTokens: deps.models.maxTokens(profile.model) as number } : {}),
    sessionFile: paths.agentFile,
    ...(deps.subAgents === false ? {} : { subAgents: deps.subAgents ?? {} }),
    ...(deps.mcp && Object.keys(deps.mcp.servers).length > 0 ? { mcp: { expose: "direct" as const, ...deps.mcp } } : {}),
  });
  for (const [server, status] of Object.entries(agent.mcp ?? {}))
    if (!status.ok) log(record.id, { level: "warn", message: "an MCP server did not start", server, error: status.error ?? "" });

  const journal = deps.journalFor ? deps.journalFor(paths.journalDirectory) : createFileJournal({ directory: paths.journalDirectory, now });
  const schedule =
    deps.schedule ??
    ((fn: () => void, ms: number) => {
      const timer = setTimeout(fn, Math.min(ms, 2_147_483_647));
      timer.unref();
      return () => clearTimeout(timer);
    });
  const waits: WaitWatcher = createWaitWatcher({
    sessionId: record.id,
    journal,
    limits: deps.waits ?? {},
    now,
    schedule,
    onError: (error) => log(record.id, { level: "error", message: "checking the wait limits failed", error: String(error) }),
    expire: async (item) => {
      if (item.kind === "question") {
        await actor.expireQuestion(item.id, item.minutes);
        // The hold ends only if nothing else keeps the agent away: another open question or an open take-over.
        if (!actor.hasOpenQuestions() && !actor.waitingFor.takeover) await actor.releaseHold();
        await actor.signal({ id: `expired-${item.id}`, source: "system", text: questionTimedOut(item.minutes) });
      } else {
        await endTakeover(actor, { note: "timeout", text: handbackTimedOut(item.minutes) });
      }
    },
  });
  const actor = new SessionActor({
    sessionId: record.id,
    agent,
    journal,
    routerOptions: deps.routerOptions,
    now,
    log: (entry) => log(record.id, entry),
    maxRunMs: runSeconds * 1000,
    onAnnounce: () => void waits.refresh(),
    // The summary line (docs/18 section 2): one small model call after each run; a failure keeps the old line.
    afterRun: () =>
      void (async () => {
        const reply = lastReply(await journal.read(record.id));
        if (reply && !/^\[SILENT\]$/.test(reply)) await deps.store.update(record.id, { last: { at: now(), who: "bot", text: reply.slice(0, 200) } });
        if (ctx.takeNotice(record.id)) {
          // A scheduled run: its reply is what the person should get, unless it chose not to disturb them.
          if (reply && !/^\[SILENT\]$/.test(reply))
            await ctx.deliver({ sessionId: record.id, from: (await deps.store.get(record.id)).title, kind: "notice", text: reply.slice(0, 300), at: now() });
        }
        if (!deps.summaries) return;
        const source = summarySource(await journal.read(record.id));
        if (!source) return;
        const line = await summarize(llm, source, AbortSignal.timeout(60_000));
        if (!line) return;
        await deps.store.update(record.id, { summary: line });
        await bridge.actor?.announce("session.summary", { text: line });
      })().catch((error) => log(record.id, { level: "warn", message: "the summary line was not made", error: String(error) })),
    // The framework counts model replies over the whole session, so each run gets a fresh allowance on top of what is used.
    beforeRun: async () => {
      // The desk-daemon may have stopped this desktop to make room for others (its logins stay on disk): a run wakes it.
      await deps.workspaces.ensure(record.id);
      const { turns, input, output, cacheRead, cacheWrite } = await agent.usage();
      limits.update({
        maxTurns: turns + turnsPerRun,
        ...(tokensPerRun === undefined ? {} : { maxTokens: input + output + cacheRead + cacheWrite + tokensPerRun }),
      });
    },
  });
  const stopUnits = async () => {
    for (const source of snapshot.sources)
      await Promise.resolve(source.stop()).catch((error) => log(record.id, { level: "error", message: "event source failed to stop", error: String(error) }));
    // A plugin tool that keeps something running (the browser's and the computer's code runners) ends it here.
    for (const tool of snapshot.tools as unknown as ReadonlyArray<{ name: string; close?: () => Promise<void> }>)
      if (typeof tool.close === "function")
        await tool.close().catch((error) => log(record.id, { level: "error", message: `tool ${tool.name} failed to close`, error: String(error) }));
  };
  try {
    await actor.open();
    for (const source of snapshot.sources) await source.start();
    await deliverQueued(actor); // texts written before a restart that ended a take-over
    void waits.refresh();
  } catch (error) {
    await actor.close().catch(() => {});
    await stopUnits();
    await agent.close().catch(() => {});
    await journal.close().catch(() => {});
    throw error;
  }
  bridge.actor = actor;
  return { actor, agent, journal, profile, stopUnits, approvals, yolo, workspaceId: workspace.workspaceId, filesDir: workspace.filesDir, waits };
}
