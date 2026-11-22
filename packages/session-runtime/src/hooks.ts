import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { OgbError } from "@standin/contracts";

/**
 * Webhooks (docs/26 3.4): a bot's named doors for outside services (GitHub, a calendar, IFTTT). Each has its own token, kept only as a
 * hash; the token is shown once when the hook is made. What comes through is untrusted (`external:<name>`), like mail from a stranger.
 */
export interface HookEntry {
  bot: string;
  name: string;
  /** sha256 of the token, hex. */
  tokenHash: string;
  createdAt: number;
}

export const MAX_HOOKS_PER_BOT = 10;
export const MAX_HOOK_BODY = 64 * 1024;
const NAME = /^[a-z][a-z0-9-]{0,31}$/;
const hash = (token: string) => createHash("sha256").update(token).digest("hex");

/** The hooks of every bot in one file (`<state>/shared/hooks/hooks.json`). */
export function createHookRegistry(file: string, now: () => number = Date.now) {
  let writing: Promise<unknown> = Promise.resolve();
  const load = async (): Promise<HookEntry[]> => {
    try {
      return JSON.parse(await readFile(file, "utf8")) as HookEntry[];
    } catch {
      return [];
    }
  };
  /** One writer at a time; the file is replaced whole. */
  const change = <T>(work: (entries: HookEntry[]) => { entries: HookEntry[]; result: T }): Promise<T> => {
    const run = writing.then(async () => {
      const { entries, result } = work(await load());
      await mkdir(dirname(file), { recursive: true });
      await writeFile(`${file}.tmp`, `${JSON.stringify(entries, null, 2)}\n`, { mode: 0o600 });
      await rename(`${file}.tmp`, file);
      return result;
    });
    writing = run.catch(() => undefined);
    return run;
  };

  return {
    /** Makes a hook; returns its token, which is never stored or shown again. */
    create: (bot: string, name: string) =>
      change((entries) => {
        if (!NAME.test(name)) throw new OgbError("invalid_input", "a hook name is lower-case letters, digits and '-', starting with a letter (at most 32)");
        if (entries.some((e) => e.bot === bot && e.name === name)) throw new OgbError("conflict", `this bot already has a hook '${name}'; delete it first`);
        if (entries.filter((e) => e.bot === bot).length >= MAX_HOOKS_PER_BOT)
          throw new OgbError("invalid_input", `a bot has at most ${MAX_HOOKS_PER_BOT} hooks`);
        const token = randomBytes(24).toString("base64url");
        return { entries: [...entries, { bot, name, tokenHash: hash(token), createdAt: now() }], result: token };
      }),
    list: async (bot: string) => (await load()).filter((e) => e.bot === bot).map(({ name, createdAt }) => ({ name, createdAt })),
    remove: (bot: string, name: string) =>
      change((entries) => ({
        entries: entries.filter((e) => !(e.bot === bot && e.name === name)),
        result: entries.some((e) => e.bot === bot && e.name === name),
      })),
    /** Whether `token` opens this bot's hook (constant time). */
    async verify(bot: string, name: string, token: string): Promise<boolean> {
      const entry = (await load()).find((e) => e.bot === bot && e.name === name);
      if (!entry || token.length === 0 || token.length > 200) return false;
      return timingSafeEqual(Buffer.from(hash(token), "hex"), Buffer.from(entry.tokenHash, "hex"));
    },
  };
}

export type HookRegistry = ReturnType<typeof createHookRegistry>;

/** The signal of one delivery: untrusted, its id from the sender's delivery id or the body, so a retry wakes the bot once. */
export function hookSignal(name: string, body: string, deliveryId: string | undefined) {
  const id = `hook-${name}-${(deliveryId && /^[A-Za-z0-9._:-]{1,100}$/.test(deliveryId) ? deliveryId : hash(body)).slice(0, 100)}`;
  const text = `Webhook '${name}' delivered (${body.length} characters):\n${body.slice(0, MAX_HOOK_BODY)}`;
  return { id, source: `external:${name}` as const, text };
}
