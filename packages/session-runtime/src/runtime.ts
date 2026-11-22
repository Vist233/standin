import { randomBytes } from "node:crypto";
import { rm } from "node:fs/promises";
import { join } from "node:path";
import { type Channel, type JsonValue, OgbError, type Outgoing, type SessionEvent, type SignalDraft } from "@vesper/contracts";
import { resolveSession } from "@vesper/profiles";
import type { SessionRecord } from "@vesper/session-store";
import { attachmentRefs, withAttachmentLine } from "./attachments.ts";
import { json } from "./events.ts";
import { type AssemblyContext, assembleSession, type OpenSession } from "./session-assembly.ts";
import { beat, readChecklist } from "./heartbeat.ts";
import { createHookRegistry, hookSignal } from "./hooks.ts";
import { createScheduler } from "./scheduler.ts";
import { endTakeover } from "./takeover.ts";
import type { SessionInfo, SessionRuntimeDeps, SessionStatus } from "./types.ts";

export interface SessionRuntime {
  /** `request` is what the page sent (profile, title, model, extraPlugins); it is validated by the profiles module. */
  createSession(request?: unknown): Promise<SessionInfo>;
  /** Renames a bot, changes its star, or switches yolo (its approvals and review off) — the person's call, from the page. */
  updateSession(id: string, patch: { title?: string; star?: string; yolo?: boolean }): Promise<SessionInfo>;
  /** Opens a stored session (also what happens, lazily, when you send to a session that is not open). Idempotent. */
  openSession(id: string): Promise<SessionInfo>;
  /** Opens every active session; one that fails to open is reported and does not stop the others. */
  resumeAll(): Promise<{ opened: string[]; failed: { id: string; error: string }[] }>;
  /** The person writes. `id` makes a retry safe: the same id is accepted once. `attachments` are files already in the files directory (the gateway checked them); the agent is told where they are. */
  send(sessionId: string, text: string, id?: string, attachments?: { name: string; size: number }[]): Promise<void>;
  /** A signal from a plugin or outside source. The sources `user` and `system` cannot be used here. */
  signal(sessionId: string, draft: SignalDraft): Promise<void>;
  /**
   * A webhook delivery (docs/26 3.4): checks the hook's token and wakes the bot with an untrusted `external:<name>` signal. False for
   * a wrong token, an unknown hook or a bot that is gone (the caller cannot tell which).
   */
  receiveHook(sessionId: string, name: string, token: string, body: string, deliveryId?: string): Promise<boolean>;
  stop(sessionId: string, id?: string): Promise<void>;
  status(sessionId: string): Promise<SessionStatus>;
  /** Replay then follow (the page's `Last-Event-ID` is `after`). */
  events(sessionId: string, after?: number): AsyncIterable<SessionEvent>;
  read(sessionId: string, after?: number): Promise<SessionEvent[]>;
  /** Approvals waiting for the person. */
  pendingApprovals(sessionId: string): Promise<{ id: string; tool: string; args: unknown }[]>;
  /** The person's decision on a request shown to them. The session is told, so the agent can go on. Repeating a decision changes nothing. */
  decideApproval(sessionId: string, approvalId: string, approved: boolean): Promise<void>;
  /**
   * Take-over and the person (usable plan D4). The state lives in the journal, not in the gateway.
   * Holds the session, lets the running tool call settle, journals `takeover.opened`. The gateway then asks the desk-daemon for the ticket.
   */
  openTakeover(sessionId: string): Promise<{ since: number; workspaceId: string }>;
  /** The gateway saw a viewer connect to the desktop: journals `takeover.viewer_connected` (once per take-over). */
  reportTakeoverViewer(sessionId: string): Promise<void>;
  /**
   * Journals `takeover.closed { note?, viewed }` and tells the agent the true hand-back text (`HANDBACK_VIEWED` or
   * `HANDBACK_NOT_VIEWED`); this also ends the hold. Harmless when no take-over is open.
   */
  closeTakeover(sessionId: string, note?: string): Promise<void>;
  /** The open take-over, or null. Derived from the journal, so it survives a restart. */
  takeoverState(sessionId: string): Promise<{ since: number; viewed: boolean } | null>;
  /** Resolves when no run is going for the session (waiting signals of a held session do not count). */
  whenIdle(sessionId: string): Promise<void>;
  list(): Promise<SessionInfo[]>;
  /** Closes the agent and the journal; the files stay. */
  closeSession(sessionId: string): Promise<void>;
  /** Closes and removes the session, its workspace and its files. Harmless if it does not exist. */
  deleteSession(sessionId: string): Promise<void>;
  close(): Promise<void>;
}

/** A running tool call gets this long to finish when the person presses Take over; then the run is cancelled. */
const TAKEOVER_SETTLE_MS = 5000;

function info(record: SessionRecord): SessionInfo {
  return {
    id: record.id,
    title: record.title,
    status: record.status,
    createdAt: record.createdAt,
    ...(record.star !== undefined ? { star: record.star } : {}),
    ...(record.yolo ? { yolo: true } : {}),
    ...(record.summary !== undefined ? { summary: record.summary } : {}),
    ...nextJob(record),
    ...(record.notice !== undefined ? { notice: record.notice } : {}),
    ...(record.last !== undefined ? { last: record.last } : {}),
  };
}

/** The bot's next scheduled job, as the person or the agent wrote it, for the rail ("next: daily 07:30"). */
function nextJob(record: SessionRecord): { next?: string } {
  const jobs = (record.schedules ?? []) as unknown as { when: string; next: number }[];
  const first = [...jobs].sort((a, b) => a.next - b.next)[0];
  return first ? { next: first.when } : {};
}

const STAR = /^[a-z][a-z0-9-]{0,23}$/;
const TITLE_MAX = 80;

/** The bot's own fields of a request (name and star); the rest goes to the profiles module, which refuses what it does not know. */
function botFields(request: unknown): { rest: unknown; star?: string } {
  if (request === null || typeof request !== "object" || Array.isArray(request) || !("star" in request)) return { rest: request };
  const { star, ...rest } = request as Record<string, unknown>;
  if (typeof star !== "string" || !STAR.test(star)) throw new OgbError("invalid_input", "star must be a short preset name");
  return { rest, star };
}

export function createSessionRuntime(deps: SessionRuntimeDeps): SessionRuntime {
  const now = deps.now ?? Date.now;
  const open = new Map<string, Promise<OpenSession>>();
  const newId = () => `m_${randomBytes(8).toString("hex")}`;
  const log = (sessionId: string, entry: Record<string, unknown>) => deps.log?.({ module: "session-runtime", session: sessionId, ...entry });

  const noticeDue = new Set<string>();
  const hooks = createHookRegistry(join(deps.store.sharedDirectory("hooks"), "hooks.json"), now);
  // A due job is the bot's own instruction: a trusted signal (source system) into the same conversation (docs/18 section 3).
  const scheduler = createScheduler({
    store: deps.store,
    now,
    log: (entry) => deps.log?.({ module: "session-runtime", ...entry }),
    ...(deps.scheduleIntervalMs !== undefined ? { intervalMs: deps.scheduleIntervalMs } : {}),
    deliver: async (sessionId, job, late) => {
      if (job.heartbeat) {
        // A beat costs a model call only when there is something to look at (docs/26 3.3).
        const session = await opened(sessionId);
        const decided = beat({
          every: job.when,
          quiet: job.heartbeat.quiet,
          now: now(),
          checklist: await readChecklist(session.filesDir),
          status: session.actor.status(),
        });
        if ("skip" in decided) {
          deps.log?.({ module: "session-runtime", level: "info", message: "heartbeat skipped", session: sessionId, reason: decided.skip });
          return;
        }
        noticeDue.add(sessionId);
        await session.actor.signal({ id: `beat-${job.id}-${now()}`, source: "system", text: decided.prompt });
        return;
      }
      noticeDue.add(sessionId);
      const lateNote = late ? " It is late: the box was down when it was due." : "";
      await (await opened(sessionId)).actor.signal({
        id: `sched-${job.id}-${now()}`,
        source: "system",
        text: `Scheduled job ${job.id} (${job.when}).${lateNote} ${job.prompt}`,
      });
    },
  });
  // The page is the first channel: it shows the whole journal, and what it needs besides is the notice on the bot's card (the contact
  // list and the browser notification). Its input is the gateway, which calls `send`.
  const page: Channel = {
    name: "page",
    async deliver(message) {
      if (message.kind !== "notice") return;
      const notice = { at: message.at, text: message.text };
      await deps.store.update(message.sessionId, { notice });
      await (await opened(message.sessionId)).actor.announce("session.notice", notice as unknown as JsonValue);
    },
  };
  const channels: Channel[] = [page, ...(deps.channels ?? [])];
  /** Gives the person something on every channel; a channel that fails is logged and never stops the bot. */
  const deliver = async (message: Outgoing) => {
    for (const channel of channels)
      await channel
        .deliver(message)
        .catch((error) => log(message.sessionId, { level: "error", message: `channel ${channel.name} could not deliver`, error: String(error) }));
  };
  const assembly: AssemblyContext = {
    deps,
    now,
    log,
    signal: (id, draft) => runtime.signal(id, draft),
    scheduler,
    hooks,
    personFile: join(deps.store.sharedDirectory("person"), "USER.md"),
    takeNotice: (id) => noticeDue.delete(id),
    readJournal: (id) => runtime.read(id),
    deliver,
  };

  function opened(id: string, fresh = false): Promise<OpenSession> {
    let session = open.get(id);
    if (!session) {
      session = deps.store.get(id).then((record) => assembleSession(assembly, record, fresh));
      open.set(id, session);
      session.catch(() => open.delete(id)); // a failed open is not remembered
    }
    return session;
  }

  async function close(id: string): Promise<void> {
    const pending = open.get(id);
    if (!pending) return;
    open.delete(id);
    const session = await pending.catch(() => undefined);
    if (!session) return;
    session.waits.stop();
    await session.actor.close();
    await session.stopUnits();
    await session.agent.close();
    await session.journal.close();
  }

  const runtime: SessionRuntime = {
    async createSession(request) {
      const { rest, star } = botFields(request);
      const profile = resolveSession(deps.profiles, rest);
      const record = await deps.store.create({
        title: profile.title,
        ...(star !== undefined ? { star } : {}),
        profile: json(profile) as Record<string, JsonValue>,
        ...(profile.model !== undefined ? { model: profile.model } : {}),
      });
      try {
        open.set(record.id, assembleSession(assembly, record, true));
        await open.get(record.id);
      } catch (error) {
        open.delete(record.id);
        await deps.workspaces.destroy(record.id).catch(() => {});
        await deps.store.delete(record.id);
        throw error;
      }
      return info(record);
    },

    async updateSession(id, patch) {
      const title = patch.title?.trim();
      if (title !== undefined && (title === "" || title.length > TITLE_MAX)) throw new OgbError("invalid_input", `a name is 1 to ${TITLE_MAX} characters`);
      const { star } = botFields(patch.star === undefined ? {} : { star: patch.star });
      if (patch.yolo !== undefined && typeof patch.yolo !== "boolean") throw new OgbError("invalid_input", "yolo is true or false");
      const before = await deps.store.get(id);
      const record = await deps.store.update(id, {
        ...(title !== undefined ? { title } : {}),
        ...(star !== undefined ? { star } : {}),
        ...(patch.yolo !== undefined ? { yolo: patch.yolo } : {}),
      });
      if (patch.yolo !== undefined && patch.yolo !== Boolean(before.yolo)) {
        // An open bot follows at once, from its next tool call; the switch is in the journal, so the record shows who ran unchecked when.
        const session = open.has(id) ? await open.get(id) : undefined;
        if (session) {
          session.yolo.on = patch.yolo;
          await session.actor.announce("safety.yolo", json({ on: patch.yolo }));
        }
      }
      return info(record);
    },

    async openSession(id) {
      await opened(id);
      return info(await deps.store.get(id));
    },

    async resumeAll() {
      scheduler.start();
      // the person's other channels bring their messages in as if typed on the page
      for (const channel of channels)
        await Promise.resolve(channel.start?.({ receive: (sessionId, text) => runtime.send(sessionId, text) })).catch((error) =>
          deps.log?.({ module: "session-runtime", level: "error", message: `channel ${channel.name} failed to start`, error: String(error) }),
        );
      const { sessions } = await deps.store.list();
      // A session log's lock names the process that held it by pid only (sakura-agent 0.2.3). After a restart the container hands the
      // same low pids to other processes, so an old lock looks held forever and the session cannot open. This process is the only one
      // that opens these sessions: a lock it does not hold itself is left over from the previous run.
      for (const record of sessions) if (!open.has(record.id)) await rm(`${deps.store.paths(record.id).agentFile}.lock`, { force: true }).catch(() => {});
      const result: { opened: string[]; failed: { id: string; error: string }[] } = { opened: [], failed: [] };
      for (const record of sessions.filter((s) => s.status === "active")) {
        try {
          await opened(record.id);
          result.opened.push(record.id);
        } catch (error) {
          result.failed.push({ id: record.id, error: error instanceof Error ? error.message : String(error) });
          log(record.id, { level: "error", message: "session failed to open", error: String(error) });
        }
      }
      return result;
    },

    async send(sessionId, text, id = newId(), attachments) {
      const session = await opened(sessionId);
      const refs = attachmentRefs(session.filesDir, attachments);
      const told = withAttachmentLine(text, refs);
      // While a take-over is open the person is at the desktop: a message must not wake the agent. It waits in the journal
      // and is delivered when the take-over ends (closeTakeover, its time limit, or a restart).
      if (session.actor.waitingFor.takeover) {
        if (!session.actor.waitingFor.queued.some((q) => q.id === id))
          await session.actor.announce("message.queued", { id, text: told, ...(refs.length > 0 ? { attachments: refs } : {}) } as unknown as JsonValue);
        return;
      }
      await session.actor.message(id, told, "person", refs);
      await deps.store.update(sessionId, { last: { at: now(), who: "person", text: text.slice(0, 200) } }).catch(() => undefined);
    },

    async signal(sessionId, draft) {
      if (draft.source === "user" || draft.source === "system")
        throw new OgbError("denied", `source '${draft.source}' cannot be used for signals from plugins or outside`);
      await (await opened(sessionId)).actor.signal(draft);
    },

    async receiveHook(sessionId, name, token, body, deliveryId) {
      if (!(await hooks.verify(sessionId, name, token))) return false;
      const record = await deps.store.get(sessionId).catch(() => undefined);
      if (!record || record.status !== "active") return false;
      await (await opened(sessionId)).actor.signal(hookSignal(name, body, deliveryId));
      return true;
    },

    async stop(sessionId, id = newId()) {
      await (await opened(sessionId)).actor.stop(id);
    },

    async status(sessionId) {
      return (await opened(sessionId)).actor.status();
    },

    events(sessionId, after = 0) {
      return (async function* () {
        yield* (await opened(sessionId)).journal.subscribe(sessionId, after);
      })();
    },

    async read(sessionId, after = 0) {
      return (await opened(sessionId)).journal.read(sessionId, after);
    },

    async pendingApprovals(sessionId) {
      return (await opened(sessionId)).approvals.pending().map(({ id, tool, args }) => ({ id, tool, args }));
    },

    async decideApproval(sessionId, approvalId, approved) {
      const session = await opened(sessionId);
      if (!session.approvals.has(approvalId))
        throw new OgbError("conflict", `no approval '${approvalId}' is waiting (it may have expired when the server restarted)`);
      const request = session.approvals.decide(approvalId, approved);
      if (!request) return; // already decided: repeating changes nothing
      await session.actor.announce("approval.decided", { id: approvalId, approved });
      await session.actor.signal({
        id: `approval-${approvalId}`,
        source: "system",
        text: approved
          ? `The person approved request ${approvalId} (${request.tool}). Repeat exactly the same call to run it once.`
          : `The person refused request ${approvalId} (${request.tool}). Do not do it; choose another approach or tell them what you need.`,
      });
    },

    async openTakeover(sessionId) {
      const session = await opened(sessionId);
      const current = session.actor.waitingFor.takeover;
      if (current) return { since: current.since, workspaceId: session.workspaceId };
      await session.actor.holdForPerson(newId(), TAKEOVER_SETTLE_MS);
      const since = now();
      await session.actor.announce("takeover.opened", { since, workspaceId: session.workspaceId });
      return { since, workspaceId: session.workspaceId };
    },
    async reportTakeoverViewer(sessionId) {
      const session = await opened(sessionId);
      const current = session.actor.waitingFor.takeover;
      if (current && !current.viewed) await session.actor.announce("takeover.viewer_connected", {});
    },
    async closeTakeover(sessionId, note) {
      const session = await opened(sessionId);
      await endTakeover(session.actor, { ...(note ? { note } : {}) });
    },
    async takeoverState(sessionId) {
      return (await opened(sessionId)).actor.waitingFor.takeover;
    },

    async whenIdle(sessionId) {
      await (await opened(sessionId)).actor.idle();
    },

    async list() {
      return (await deps.store.list()).sessions.map(info);
    },

    closeSession: close,

    async deleteSession(sessionId) {
      await close(sessionId);
      await deps.workspaces.destroy(sessionId);
      await deps.store.delete(sessionId);
    },

    async close() {
      scheduler.stop();
      for (const channel of channels) await Promise.resolve(channel.stop?.()).catch(() => undefined);
      await Promise.all([...open.keys()].map((id) => close(id)));
    },
  };
  return runtime;
}
