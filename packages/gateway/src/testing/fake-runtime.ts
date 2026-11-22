import { type EventDraft, OgbError, type SessionEvent } from "@standin/contracts";
import { createMemoryJournal, type MemoryJournal } from "@standin/event-journal/testing";
import type { SessionInfo, SessionStatus } from "@standin/session-runtime";
import type { GatewayRuntime } from "../types.ts";

export interface FakeRuntime extends GatewayRuntime {
  readonly journal: MemoryJournal;
  /** Everything the gateway asked for, in order, as `method:session:detail`. */
  readonly calls: string[];
  /** Appends an event to a session's journal as the real runtime would. */
  emit(sessionId: string, draft: EventDraft): Promise<SessionEvent>;
  /** Adds a session without going through `createSession`. */
  add(id: string, title?: string): SessionInfo;
  setStatus(sessionId: string, status: Partial<SessionStatus>): void;
  setApprovals(sessionId: string, approvals: { id: string; tool: string; args: unknown }[]): void;
  /** The open take-over, as the real runtime derives it from its journal. */
  readonly takeovers: Map<string, { since: number; viewed: boolean }>;
  /** Makes the next call of `method` throw. */
  failNext(method: string, error: unknown): void;
}

/** A runtime that keeps everything in memory and obeys the same contract as the real one for the parts the gateway touches. */
export function createFakeRuntime(): FakeRuntime {
  const journal = createMemoryJournal();
  const sessions = new Map<string, SessionInfo>();
  const states = new Map<string, Partial<SessionStatus>>();
  const approvals = new Map<string, { id: string; tool: string; args: unknown }[]>();
  const failures = new Map<string, unknown>();
  const calls: string[] = [];
  const takeovers = new Map<string, { since: number; viewed: boolean }>();
  let counter = 0;

  const enter = (call: string, method: string) => {
    calls.push(call);
    const failure = failures.get(method);
    if (failure !== undefined) {
      failures.delete(method);
      throw failure;
    }
  };
  const need = (id: string): SessionInfo => {
    const found = sessions.get(id);
    if (!found) throw new OgbError("not_found", `no session '${id}'`);
    return found;
  };
  /** What the real runtime knows from its journal: open questions and approvals, and how the last run ended. setStatus overrides it. */
  const fromJournal = (events: SessionEvent[]): SessionStatus => {
    const open = new Set<string>();
    let lastRunEnd: string | null = null;
    let run: SessionStatus["run"] = "idle";
    for (const event of events) {
      const id = (event.payload as { id?: unknown } | null)?.id;
      if (event.type === "human.question" || event.type === "approval.requested") open.add(String(id));
      if (["human.answered", "human.expired", "approval.decided", "approval.expired"].includes(event.type)) open.delete(String(id));
      if (event.type === "run.started") run = "active";
      if (event.type === "run.finished") {
        run = "idle";
        lastRunEnd = String((event.payload as { reason?: unknown } | null)?.reason ?? "end");
      }
    }
    return { run, held: false, queued: 0, pending: open.size, lastRunEnd };
  };
  const stateOf = (id: string): Partial<SessionStatus> => states.get(id) ?? {};

  const runtime: FakeRuntime = {
    journal,
    calls,
    takeovers,
    emit: (sessionId, draft) => journal.append(sessionId, draft),
    add(id, title = id) {
      const info: SessionInfo = { id, title, status: "active", createdAt: 1_700_000_000_000 + sessions.size };
      sessions.set(id, info);
      return info;
    },
    setStatus(sessionId, status) {
      states.set(sessionId, { ...stateOf(sessionId), ...status });
    },
    setApprovals(sessionId, list) {
      approvals.set(sessionId, list);
    },
    failNext(method, error) {
      failures.set(method, error);
    },
    async createSession(request) {
      enter(`createSession:${JSON.stringify(request ?? null)}`, "createSession");
      counter += 1;
      const title = typeof (request as { title?: unknown } | undefined)?.title === "string" ? (request as { title: string }).title : "general";
      const info = runtime.add(`s_fake${counter}`, title);
      const star = (request as { star?: unknown } | undefined)?.star;
      if (typeof star === "string") sessions.set(info.id, { ...info, star });
      return need(info.id);
    },
    async updateSession(id, patch) {
      enter(`updateSession:${id}:${JSON.stringify(patch)}`, "updateSession");
      const current = need(id);
      const next = {
        ...current,
        ...(patch.title !== undefined ? { title: patch.title } : {}),
        ...(patch.star !== undefined ? { star: patch.star } : {}),
        ...(patch.yolo !== undefined ? { yolo: patch.yolo } : {}),
      };
      sessions.set(id, next);
      return next;
    },
    async openSession(id) {
      enter(`openSession:${id}`, "openSession");
      return need(id);
    },
    async list() {
      enter("list", "list");
      return [...sessions.values()];
    },
    async send(id, text, messageId, attachments) {
      enter(`send:${id}:${text}${messageId ? `:${messageId}` : ""}${attachments ? `:attachments=${JSON.stringify(attachments)}` : ""}`, "send");
      need(id);
      states.set(id, { ...stateOf(id), held: false });
    },
    async stop(id) {
      enter(`stop:${id}`, "stop");
      need(id);
      states.set(id, { ...stateOf(id), held: true });
    },
    async status(id) {
      enter(`status:${id}`, "status");
      need(id);
      return { ...fromJournal(await journal.read(id)), ...states.get(id) };
    },
    events(id, after = 0) {
      calls.push(`events:${id}:${after}`);
      need(id);
      return journal.subscribe(id, after);
    },
    async read(id, after = 0) {
      enter(`read:${id}:${after}`, "read");
      need(id);
      return journal.read(id, after);
    },
    async pendingApprovals(id) {
      enter(`pendingApprovals:${id}`, "pendingApprovals");
      need(id);
      return approvals.get(id) ?? [];
    },
    async deleteSession(id) {
      enter(`deleteSession:${id}`, "deleteSession");
      sessions.delete(id);
      states.delete(id);
      takeovers.delete(id);
    },
    async openTakeover(id) {
      enter(`openTakeover:${id}`, "openTakeover");
      need(id);
      states.set(id, { ...stateOf(id), held: true });
      const since = 1_700_000_000_000 + takeovers.size;
      takeovers.set(id, { since, viewed: false });
      const workspaceId = id.toLowerCase().replaceAll("_", "-");
      await journal.append(id, { type: "takeover.opened", payload: { since, workspaceId } }); // journaled, as the real runtime does
      return { since, workspaceId };
    },
    async reportTakeoverViewer(id) {
      enter(`reportTakeoverViewer:${id}`, "reportTakeoverViewer");
      const open = takeovers.get(id);
      if (open) open.viewed = true;
    },
    async closeTakeover(id, note) {
      enter(`closeTakeover:${id}${note ? `:${note}` : ""}`, "closeTakeover");
      need(id);
      const open = takeovers.get(id);
      if (takeovers.delete(id)) {
        states.set(id, { ...stateOf(id), held: false });
        await journal.append(id, { type: "takeover.closed", payload: { ...(note ? { note } : {}), viewed: open?.viewed ?? false } });
      }
    },
    async takeoverState(id) {
      enter(`takeoverState:${id}`, "takeoverState");
      const open = takeovers.get(id);
      return open ? { ...open } : null;
    },
    /** Accepts the token `good` for any hook of a known bot; records the delivery. */
    async receiveHook(id, name, token, body, deliveryId) {
      enter(`receiveHook:${id}:${name}:${deliveryId ?? "-"}:${body}`, "receiveHook");
      return token === "good" && sessions.has(id);
    },

    async decideApproval(id, approvalId, approved) {
      enter(`decideApproval:${id}:${approvalId}:${approved}`, "decideApproval");
      need(id);
      approvals.set(
        id,
        (approvals.get(id) ?? []).filter((a) => a.id !== approvalId),
      );
    },
  };
  return runtime;
}
