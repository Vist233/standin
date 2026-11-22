/**
 * Pulls webhooks from the hook relay (relay/hook-relay, docs/26 3.4) and hands each to the runtime, which checks its token and wakes
 * the bot. Everything pulled is acknowledged, accepted or not: a delivery with a wrong token is junk, not something to retry.
 */
export interface HookRelayOptions {
  url: string;
  key: string;
  receive(bot: string, hook: string, token: string, body: string, delivery?: string): Promise<boolean>;
  log(entry: Record<string, unknown>): void;
  fetch?: typeof fetch | undefined;
  everyMs?: number;
}

interface Item {
  id: string;
  bot: string;
  hook: string;
  token: string;
  body: string;
  delivery?: string;
}

export function createHookRelayPuller(options: HookRelayOptions) {
  const doFetch = options.fetch ?? fetch;
  const base = options.url.replace(/\/+$/, "");
  const headers = { authorization: `Bearer ${options.key}` };
  let timer: NodeJS.Timeout | undefined;
  let stopped = true;

  async function pullOnce(): Promise<number> {
    const response = await doFetch(`${base}/pull`, { headers });
    if (!response.ok) throw new Error(`the hook relay answered ${response.status} to pull`);
    const { items = [] } = (await response.json()) as { items?: Item[] };
    let accepted = 0;
    for (const item of items) {
      const ok = await options.receive(item.bot, item.hook, item.token, item.body, item.delivery).catch(() => false);
      if (ok) accepted += 1;
      else options.log({ level: "warn", message: "a relayed webhook was refused (wrong token, unknown hook or bot)", hook: item.hook });
    }
    if (items.length > 0)
      await doFetch(`${base}/ack`, {
        method: "POST",
        headers: { ...headers, "content-type": "application/json" },
        body: JSON.stringify({ ids: items.map((i) => i.id) }),
      });
    return accepted;
  }

  const loop = () => {
    if (stopped) return;
    pullOnce()
      .catch((error) => options.log({ level: "warn", message: "the hook relay could not be reached", error: String(error) }))
      .finally(() => {
        if (!stopped) timer = setTimeout(loop, options.everyMs ?? 15_000);
      });
  };

  return {
    pullOnce,
    start() {
      if (!stopped) return;
      stopped = false;
      loop();
    },
    stop() {
      stopped = true;
      if (timer) clearTimeout(timer);
    },
  };
}
