import type { IncomingMessage, ServerResponse } from "node:http";
import { checkInsertText, isOgbError, OgbError, type SessionEvent, sanitizeFileName, type TakeoverTicket } from "@standin/contracts";
import { workspaceIdFor } from "@standin/session-runtime";
import { HttpFailure, readJsonObject, readRawBody, sendDownload, sendJson, textField } from "./http.ts";
import { pump } from "./sse.ts";
import type { TicketBook } from "./tickets.ts";
import type { Attachment, Catalog, GatewayLimits, GatewayOptions } from "./types.ts";

/** Bumped when a path or a body changes in a way an old page cannot read. 2: view/takeover tickets, `pending` and `lastRunEnd`, DELETE, `startup`, `text`. */
export const API_VERSION = 2;

const MAX_MESSAGE_CHARS = 100_000;
const MAX_NOTE_CHARS = 2_000;

export interface ApiDeps {
  options: GatewayOptions;
  limits: GatewayLimits;
  tickets: TicketBook;
  now: () => number;
  log: (entry: Record<string, unknown>) => void;
  /** Streams open right now; the API refuses a new one past the limit. */
  streams: { count: number };
}

type Handler = (call: Call) => Promise<void>;
interface Call {
  req: IncomingMessage;
  res: ServerResponse;
  params: string[];
  query: URLSearchParams;
}

/** The JSON API. Each route is a few lines that call one runtime method; nothing here knows how a session works inside. */
export class Api {
  private readonly deps: ApiDeps;
  private readonly routes: { method: string; pattern: RegExp; handler: Handler }[] = [];

  constructor(deps: ApiDeps) {
    this.deps = deps;
    const { runtime } = deps.options;
    const route = (method: string, pattern: string, handler: Handler) =>
      this.routes.push({
        method,
        pattern: new RegExp(
          `^${pattern.replace(/:id/g, "([A-Za-z0-9_-]{1,64})").replace(/:aid/g, "([A-Za-z0-9_-]{1,64})").replace(/:name/g, "([^/]{1,400})")}$`,
        ),
        handler,
      });
    const json = (call: Call, value: unknown, status = 200) => sendJson(call.res, status, value);
    const body = (call: Call) => readJsonObject(call.req, deps.limits.maxBodyBytes);

    route("GET", "/api/health", async (call) => json(call, { ok: true, api: API_VERSION, ready: deps.options.ready?.() ?? true }));

    route("GET", "/api/options", async (call) => {
      const catalog: Catalog = (await deps.options.catalog?.()) ?? { profiles: [], models: [] };
      json(call, {
        ...catalog,
        takeover: deps.options.workspaces !== undefined,
        liveView: deps.options.workspaces !== undefined,
        files: deps.options.workspaces !== undefined,
        limits: { fileBytes: deps.limits.maxFileBytes, files: deps.limits.maxFiles },
        startup: deps.options.startup?.() ?? [],
      });
    });

    route("GET", "/api/sessions", async (call) => {
      const sessions = await runtime.list();
      const rows = await Promise.all(
        sessions.map(async (session) => {
          const active = session.status === "active";
          const [state, takeover] = active
            ? await Promise.all([runtime.status(session.id).catch(() => null), runtime.takeoverState(session.id).catch(() => null)])
            : [null, null];
          return { ...session, state, pending: state?.pending ?? 0, lastRunEnd: state?.lastRunEnd ?? null, takeover: takeover !== null };
        }),
      );
      json(call, { sessions: rows });
    });

    route("POST", "/api/sessions", async (call) => {
      // The request goes to the runtime unchanged: the profiles module decides what the page may ask, and a field it
      // does not know (or one that smells like the safety floor) is refused there, loudly.
      const created = await runtime.createSession(await body(call));
      json(call, { session: created }, 201);
    });

    route("GET", "/api/sessions/:id", async (call) => json(call, await this.describe(call.params[0] as string)));

    route("POST", "/api/sessions/:id/resume", async (call) => {
      const session = await runtime.openSession(call.params[0] as string);
      json(call, { session });
    });

    // One door for the person's words. Whether it steers a running agent, starts a run, or answers an `ask_human` is the
    // router's decision, not a thing the page chooses; an answer to a question is simply a message.
    route("POST", "/api/sessions/:id/messages", async (call) => {
      const fields = await body(call);
      const text = textField(fields, "text", MAX_MESSAGE_CHARS) as string;
      const id = textField(fields, "id", 100, false);
      const sessionId = call.params[0] as string;
      const attachments = await this.checkAttachments(sessionId, fields.attachments);
      await runtime.send(sessionId, text, id, ...(attachments.length > 0 ? [attachments] : []));
      json(call, { ok: true }, 202);
    });

    route("POST", "/api/sessions/:id/stop", async (call) => {
      const fields = await body(call);
      await runtime.stop(call.params[0] as string, textField(fields, "id", 100, false));
      json(call, { ok: true }, 202);
    });

    route("GET", "/api/sessions/:id/approvals", async (call) => json(call, { approvals: await runtime.pendingApprovals(call.params[0] as string) }));

    route("POST", "/api/sessions/:id/approvals/:aid", async (call) => {
      const fields = await body(call);
      if (typeof fields.approved !== "boolean") throw new HttpFailure(400, "invalid_input", "'approved' must be true or false");
      await runtime.decideApproval(call.params[0] as string, call.params[1] as string, fields.approved);
      json(call, { ok: true });
    });

    route("GET", "/api/sessions/:id/history", async (call) => {
      const events: SessionEvent[] = await runtime.read(call.params[0] as string, afterOf(call));
      json(call, { events });
    });

    route("GET", "/api/sessions/:id/events", async (call) => {
      const id = call.params[0] as string;
      const after = afterOf(call);
      if (deps.streams.count >= deps.limits.maxStreams) {
        call.res.setHeader("retry-after", "5");
        throw new HttpFailure(503, "unavailable", "too many open event streams");
      }
      await runtime.status(id); // fails with not_found before any header is sent
      deps.streams.count += 1;
      try {
        await pump(runtime.events(id, after), call.req, call.res, {
          heartbeatMs: deps.limits.heartbeatMs,
          slowClientMs: deps.limits.slowClientMs,
          log: deps.log,
        });
      } finally {
        deps.streams.count -= 1;
      }
    });

    // The page's ticket is one-time and ours; behind it the desk-daemon issues its own ticket for the mode, asked for now so
    // that every page ticket has a daemon ticket of its own (the daemon returns the same one while valid, never a shared page).
    route("POST", "/api/sessions/:id/live-view", async (call) => {
      const id = call.params[0] as string;
      await body(call);
      await runtime.status(id);
      const ticket = await this.viewTicket(id);
      json(call, { url: this.socketUrl(id, "view", ticket) });
    });

    route("POST", "/api/sessions/:id/takeover", async (call) => {
      const id = call.params[0] as string;
      const host = this.host();
      await runtime.status(id);
      // The runtime owns take-over state (journal). A page that reloads in the middle asks again and must not open a second one.
      const open = await runtime.takeoverState(id);
      const since = open ? open.since : (await runtime.openTakeover(id)).since;
      let ticket: TakeoverTicket;
      try {
        ticket = await host.takeover.open(workspaceIdFor(id));
      } catch (error) {
        if (!open) await runtime.closeTakeover(id).catch(() => {}); // nobody can see the desktop: release the hold again
        throw error;
      }
      deps.log({ level: "info", message: "take-over ticket issued", session: id });
      json(call, { url: this.socketUrl(id, "takeover", ticket), since });
    });

    route("POST", "/api/sessions/:id/handback", async (call) => {
      const id = call.params[0] as string;
      const host = this.host();
      const note = textField(await body(call), "note", MAX_NOTE_CHARS, false);
      await runtime.status(id);
      const wasOpen = (await runtime.takeoverState(id)) !== null;
      await runtime.closeTakeover(id, note);
      await host.takeover
        .close(workspaceIdFor(id))
        .catch((error) => deps.log({ level: "warn", message: "take-over close failed", session: id, error: String(error) }));
      json(call, { ok: true, wasOpen });
    });

    // Text the person typed into the page's field, for what the keyboard path of the picture cannot carry (Chinese, emoji).
    // It is a secret (it may be a password): it is never logged and never put in an error.
    route("POST", "/api/sessions/:id/text", async (call) => {
      const id = call.params[0] as string;
      const host = this.host();
      const fields = await body(call);
      const text = checkInsertText(fields.text);
      await runtime.status(id);
      if ((await runtime.takeoverState(id)) === null) throw new HttpFailure(409, "conflict", "text can only be typed while you are in control of the desktop");
      const result = await host.input.insertText(workspaceIdFor(id), text);
      json(call, { inserted: result.inserted });
    });

    // Files between the person's machine and the workspace's files directory. The content is never logged, only name and size.
    route("POST", "/api/sessions/:id/files", async (call) => {
      const id = call.params[0] as string;
      const host = this.host();
      await runtime.status(id);
      const name = fileNameOf(call.req.headers["x-file-name"]);
      const workspaceId = workspaceIdFor(id);
      if ((await host.files.list(workspaceId)).length >= deps.limits.maxFiles)
        throw new HttpFailure(409, "conflict", `a session holds at most ${deps.limits.maxFiles} files; remove some or ask the agent to`);
      const bytes = await readRawBody(call.req, deps.limits.maxFileBytes);
      const file = await host.files.put(workspaceId, name, bytes);
      deps.log({ level: "info", message: "file stored", session: id, name: file.name, size: file.size });
      json(call, { file }, 201);
    });

    route("GET", "/api/sessions/:id/files", async (call) => {
      const id = call.params[0] as string;
      const host = this.host();
      await runtime.status(id);
      json(call, { files: await host.files.list(workspaceIdFor(id)) });
    });

    route("GET", "/api/sessions/:id/files/:name", async (call) => {
      const id = call.params[0] as string;
      const host = this.host();
      await runtime.status(id);
      let name: string;
      try {
        name = decodeURIComponent(call.params[1] as string);
      } catch {
        throw new HttpFailure(404, "not_found", "no such file");
      }
      // Only a name that is already clean exists: no path, no dot-file, nothing that sanitising would change.
      if (sanitizeFileName(name) !== name) throw new HttpFailure(404, "not_found", "no such file");
      sendDownload(call.res, name, await host.files.get(workspaceIdFor(id), name));
    });

    route("PATCH", "/api/sessions/:id", async (call) => {
      // A bot's name and star, and yolo (its approvals and review off); the runtime checks them.
      const fields = await body(call);
      if (fields.yolo !== undefined && typeof fields.yolo !== "boolean") throw new HttpFailure(400, "invalid_input", "yolo is true or false");
      const patch = {
        ...(fields.title !== undefined ? { title: textField(fields, "title", 80) as string } : {}),
        ...(fields.star !== undefined ? { star: textField(fields, "star", 24) as string } : {}),
        ...(typeof fields.yolo === "boolean" ? { yolo: fields.yolo } : {}),
      };
      json(call, { session: await runtime.updateSession(call.params[0] as string, patch) });
    });

    route("DELETE", "/api/sessions/:id", async (call) => {
      const id = call.params[0] as string;
      await runtime.deleteSession(id);
      json(call, { ok: true });
    });
  }

  /** The attachments a message claims must be files that are really there, with the size the page was told. */
  private async checkAttachments(sessionId: string, raw: unknown): Promise<Attachment[]> {
    if (raw === undefined) return [];
    if (!Array.isArray(raw) || raw.length > this.deps.limits.maxFiles)
      throw new HttpFailure(400, "invalid_input", `'attachments' must be a list of at most ${this.deps.limits.maxFiles} files`);
    if (raw.length === 0) return [];
    const present = new Map((await this.host().files.list(workspaceIdFor(sessionId))).map((file) => [file.name, file.size]));
    return raw.map((item) => {
      const entry = item as { name?: unknown; size?: unknown } | null;
      if (typeof entry?.name !== "string" || typeof entry.size !== "number" || present.get(entry.name) !== entry.size)
        throw new HttpFailure(400, "invalid_input", "an attachment is not a file of this session");
      return { name: entry.name, size: entry.size };
    });
  }

  private host() {
    const host = this.deps.options.workspaces;
    if (!host) throw new OgbError("unavailable", "the desktop is not available in this setup");
    return host;
  }

  private async viewTicket(sessionId: string): Promise<TakeoverTicket> {
    const host = this.host();
    try {
      return await host.view.open(workspaceIdFor(sessionId));
    } catch (error) {
      // No workspace for this session (not started, or destroyed): the page shows "no desktop", not a fault.
      if (isOgbError(error, "not_found")) throw new OgbError("unavailable", "this session has no desktop yet");
      throw error;
    }
  }

  private socketUrl(sessionId: string, kind: "view" | "takeover", ticket: TakeoverTicket): string {
    const mine = this.deps.tickets.mint({ sessionId, kind, upstream: { port: ticket.port, token: ticket.token } });
    return `/ws/${sessionId}/${kind}?ticket=${mine}`;
  }

  private async describe(id: string) {
    const { runtime } = this.deps.options;
    const session = (await runtime.list()).find((candidate) => candidate.id === id);
    if (!session) throw new OgbError("not_found", `no session '${id}'`);
    const [state, approvals, takeover] = await Promise.all([runtime.status(id), runtime.pendingApprovals(id), runtime.takeoverState(id)]);
    return { session, state, approvals, takeover, pending: state.pending, lastRunEnd: state.lastRunEnd };
  }

  /** Runs the route for this request, or returns false when there is none (the caller answers 404 or 405). */
  async handle(req: IncomingMessage, res: ServerResponse, path: string, query: URLSearchParams): Promise<"done" | "no-route" | "wrong-method"> {
    let pathMatched = false;
    for (const route of this.routes) {
      const match = route.pattern.exec(path);
      if (!match) continue;
      pathMatched = true;
      if (route.method !== req.method) continue;
      await route.handler({ req, res, params: match.slice(1), query });
      return "done";
    }
    return pathMatched ? "wrong-method" : "no-route";
  }
}

/** `Last-Event-ID` (what a browser or our page sends on reconnect) or `?after=`, a whole number from 0. */
function afterOf(call: Call): number {
  const raw = call.req.headers["last-event-id"] ?? call.query.get("after") ?? "0";
  const text = Array.isArray(raw) ? raw[0] : raw;
  if (!/^\d{1,15}$/.test(text ?? "")) throw new HttpFailure(400, "invalid_input", "Last-Event-ID / after must be a whole number");
  return Number(text);
}

/** The file name from the `x-file-name` header (percent-encoded UTF-8), made safe. Never quotes the name in an error. */
function fileNameOf(header: string | string[] | undefined): string {
  const raw = Array.isArray(header) ? header[0] : header;
  if (!raw) throw new HttpFailure(400, "invalid_input", "the x-file-name header is missing");
  let decoded: string;
  try {
    decoded = decodeURIComponent(raw);
  } catch {
    throw new HttpFailure(400, "invalid_input", "the x-file-name header is not valid percent-encoding");
  }
  return sanitizeFileName(decoded);
}
