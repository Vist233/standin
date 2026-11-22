import { randomBytes } from "node:crypto";
import { mkdir, readdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { isJsonObject, type JsonValue, OgbError } from "@vesper/contracts";

export type SessionStatus = "active" | "archived";

export interface SessionRecord {
  id: string;
  title: string;
  status: SessionStatus;
  createdAt: number;
  /** The resolved profile as JSON, so a session keeps the plugins and floor it was created with. The store does not look inside. */
  profile: JsonValue;
  /** Name of the model in the model registry, when the profile named one. */
  model?: string;
  /** The bot's avatar: a preset star id chosen by the person (the page draws it). */
  star?: string;
  /** Yolo: the person switched off this bot's approvals and review (switched at run time, on the page; never by the bot). */
  yolo?: boolean;
  /** One line about the person's task, written by the runtime after each run. */
  summary?: string;
  /** Scheduled wake-ups of this bot, owned by the runtime's scheduler; the store keeps them as they are. */
  schedules?: JsonValue[];
  /** The last result of a scheduled run worth telling the person: `{ at, text }` (the page turns it into a notification). */
  notice?: { at: number; text: string };
  /** The last message of the conversation, for the contact list: who wrote it, when, and its first words. */
  last?: { at: number; who: "person" | "bot"; text: string };
}

export type NewSession = Omit<SessionRecord, "id" | "status" | "createdAt" | "summary" | "schedules" | "notice" | "last"> & { id?: string };

export interface SessionPaths {
  directory: string;
  /** The framework's session file (JSONL conversation log). */
  agentFile: string;
  /** Directory for the event journal of this session. */
  journalDirectory: string;
  /** Per-plugin data directories are made under here. */
  dataDirectory: string;
}

export interface SessionStore {
  /** Fails with `conflict` if the id exists. Without an id one is made. */
  create(session: NewSession): Promise<SessionRecord>;
  get(id: string): Promise<SessionRecord>;
  /** Sorted by creation time. Sessions whose record is damaged are reported, not hidden and not fatal. */
  list(): Promise<{ sessions: SessionRecord[]; damaged: string[] }>;
  update(
    id: string,
    patch: Partial<Pick<SessionRecord, "title" | "status" | "star" | "yolo" | "summary" | "schedules" | "notice" | "last">>,
  ): Promise<SessionRecord>;
  /** Removes everything of the session. Harmless when it does not exist. */
  delete(id: string): Promise<void>;
  paths(id: string): SessionPaths;
  /** A directory for data shared by all sessions of the box, named by its owner (a plugin). Not removed when a session is deleted. */
  sharedDirectory(name: string): string;
}

const SESSION_ID = /^[A-Za-z0-9_-]{1,128}$/;
const RECORD_FILE = "session.json";

function assertId(id: string): void {
  if (!SESSION_ID.test(id)) throw new OgbError("invalid_input", "session id must be 1 to 128 characters of letters, digits, '-' or '_'");
}

function isRecord(value: unknown, id: string): value is SessionRecord {
  return (
    isJsonObject(value) &&
    value.id === id &&
    typeof value.title === "string" &&
    (value.status === "active" || value.status === "archived") &&
    typeof value.createdAt === "number" &&
    "profile" in value &&
    (value.model === undefined || typeof value.model === "string") &&
    (value.star === undefined || typeof value.star === "string") &&
    (value.yolo === undefined || typeof value.yolo === "boolean") &&
    (value.summary === undefined || typeof value.summary === "string") &&
    (value.schedules === undefined || Array.isArray(value.schedules)) &&
    (value.notice === undefined || (typeof value.notice === "object" && value.notice !== null)) &&
    (value.last === undefined || (typeof value.last === "object" && value.last !== null))
  );
}

/**
 * One directory per session under `<root>/sessions/<id>/` holds everything of it, so deleting a session is deleting one
 * directory and nothing else can be left behind. There is no separate index: the list is the directories, so the index
 * cannot disagree with the files. The record is written to a temporary file and renamed, so it is whole or absent.
 */
export function createFileSessionStore(options: { root: string; now?: () => number; newId?: () => string }): SessionStore {
  const now = options.now ?? Date.now;
  const newId = options.newId ?? (() => `s_${randomBytes(6).toString("hex")}`);
  const base = join(options.root, "sessions");
  const dir = (id: string) => join(base, id);

  async function writeRecord(record: SessionRecord): Promise<void> {
    const target = join(dir(record.id), RECORD_FILE);
    const temporary = `${target}.tmp-${randomBytes(4).toString("hex")}`;
    try {
      await writeFile(temporary, `${JSON.stringify(record, null, 2)}\n`);
      await rename(temporary, target);
    } catch (cause) {
      await rm(temporary, { force: true }).catch(() => {});
      throw new OgbError("unavailable", `cannot write the record of session '${record.id}'`, { cause });
    }
  }

  async function read(id: string): Promise<SessionRecord> {
    assertId(id);
    let text: string;
    try {
      text = await readFile(join(dir(id), RECORD_FILE), "utf8");
    } catch (cause) {
      if ((cause as NodeJS.ErrnoException).code === "ENOENT") throw new OgbError("not_found", `no session '${id}'`);
      throw new OgbError("unavailable", `cannot read the record of session '${id}'`, { cause });
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch (cause) {
      throw new OgbError("corrupt", `the record of session '${id}' is not JSON`, { cause });
    }
    if (!isRecord(parsed, id)) throw new OgbError("corrupt", `the record of session '${id}' is not a session record`);
    return parsed;
  }

  return {
    sharedDirectory(name) {
      if (!/^[a-z0-9][a-z0-9-]{0,63}$/.test(name)) throw new OgbError("invalid_input", "shared directory name must be lower-case letters, digits and '-'");
      return join(options.root, "shared", name);
    },

    paths(id) {
      assertId(id);
      return { directory: dir(id), agentFile: join(dir(id), "agent.jsonl"), journalDirectory: join(dir(id), "journal"), dataDirectory: join(dir(id), "data") };
    },

    async create(session) {
      const id = session.id ?? newId();
      assertId(id);
      try {
        await mkdir(base, { recursive: true });
        await mkdir(dir(id)); // not recursive: an existing directory is a conflict, found atomically
      } catch (cause) {
        if ((cause as NodeJS.ErrnoException).code === "EEXIST") throw new OgbError("conflict", `session '${id}' already exists`);
        throw new OgbError("unavailable", `cannot create session '${id}'`, { cause });
      }
      const record: SessionRecord = { id, title: session.title, status: "active", createdAt: now(), profile: session.profile };
      if (session.model !== undefined) record.model = session.model;
      if (session.star !== undefined) record.star = session.star;
      try {
        await writeRecord(record);
      } catch (error) {
        await rm(dir(id), { recursive: true, force: true }).catch(() => {});
        throw error;
      }
      return record;
    },

    get: read,

    async list() {
      let names: string[];
      try {
        names = await readdir(base);
      } catch (cause) {
        if ((cause as NodeJS.ErrnoException).code === "ENOENT") return { sessions: [], damaged: [] };
        throw new OgbError("unavailable", "cannot list sessions", { cause });
      }
      const sessions: SessionRecord[] = [];
      const damaged: string[] = [];
      for (const name of names.sort()) {
        if (!SESSION_ID.test(name)) continue;
        try {
          sessions.push(await read(name));
        } catch {
          damaged.push(name);
        }
      }
      sessions.sort((a, b) => a.createdAt - b.createdAt || a.id.localeCompare(b.id));
      return { sessions, damaged };
    },

    async update(id, patch) {
      const current = await read(id);
      const next: SessionRecord = {
        ...current,
        ...(patch.title !== undefined ? { title: patch.title } : {}),
        ...(patch.status !== undefined ? { status: patch.status } : {}),
        ...(patch.star !== undefined ? { star: patch.star } : {}),
        ...(patch.yolo !== undefined ? { yolo: patch.yolo } : {}),
        ...(patch.summary !== undefined ? { summary: patch.summary } : {}),
        ...(patch.schedules !== undefined ? { schedules: patch.schedules } : {}),
        ...(patch.notice !== undefined ? { notice: patch.notice } : {}),
        ...(patch.last !== undefined ? { last: patch.last } : {}),
      };
      await writeRecord(next);
      return next;
    },

    async delete(id) {
      assertId(id);
      try {
        await rm(dir(id), { recursive: true, force: true });
      } catch (cause) {
        throw new OgbError("unavailable", `cannot delete session '${id}'`, { cause });
      }
    },
  };
}
