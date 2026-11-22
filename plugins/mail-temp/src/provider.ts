import { join } from "node:path";
import { openTempMailAccount, type Provider, TEMP_MAIL_VARIABLES, tempMailSettings } from "@standin/connectors";
import { isOgbError, OgbError, type PluginContext } from "@standin/contracts";

const open = new Map<string, Promise<Provider>>();

/** `bot-` and the start of the workspace id: unique on the box, stable for the bot. */
export function mailboxName(workspaceId: string): string {
  const core = workspaceId
    .toLowerCase()
    .replace(/[^a-z0-9]/g, "")
    .slice(0, 10);
  return `bot-${core || "x"}`;
}

async function optionalSecret(ctx: PluginContext, name: string): Promise<string | undefined> {
  try {
    return await ctx.secrets.resolve(`env:${name}`);
  } catch (error) {
    if (isOgbError(error, "not_found") || isOgbError(error, "denied")) return undefined;
    throw error;
  }
}

/** The bot's address, made the first time and kept in the plugin's data directory of this session (tools and sources share it). */
export function providerFor(ctx: PluginContext, env: Readonly<Record<string, string | undefined>> = process.env, fetchImpl?: typeof fetch): Promise<Provider> {
  const known = open.get(ctx.dataDir);
  if (known) return known;
  const made = (async () => {
    const settings = tempMailSettings(env);
    if (!settings) throw new OgbError("unavailable", `mail-temp needs ${TEMP_MAIL_VARIABLES.url} and ${TEMP_MAIL_VARIABLES.domain}`);
    const pollMs = Number(env.OGB_TEMP_MAIL_POLL_MS) > 0 ? Number(env.OGB_TEMP_MAIL_POLL_MS) : undefined;
    return openTempMailAccount({
      directory: join(ctx.dataDir, "address"),
      name: mailboxName(ctx.workspace.workspaceId),
      site: { baseUrl: settings.baseUrl, sitePassword: await optionalSecret(ctx, TEMP_MAIL_VARIABLES.sitePassword), fetch: fetchImpl },
      domain: settings.domain,
      adminPassword: () => ctx.secrets.resolve(`env:${TEMP_MAIL_VARIABLES.admin}`),
      pollMs,
    });
  })();
  open.set(ctx.dataDir, made);
  made.catch(() => open.delete(ctx.dataDir)); // a failure is tried again at the next session start
  return made;
}
