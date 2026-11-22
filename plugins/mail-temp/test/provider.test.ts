// The bot's own address: made once with the admin password, kept privately in the session's data directory, reused after a restart.
import { mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createFakeTempMail } from "@standin/connectors/testing";
import { OgbError, type PluginContext } from "@standin/contracts";
import { afterEach, describe, expect, it } from "vitest";
import { mailboxName, providerFor } from "../src/provider.ts";

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function context(admin: string | undefined): PluginContext {
  const dataDir = mkdtempSync(join(tmpdir(), "ogb-mailtemp-"));
  dirs.push(dataDir);
  const asked: string[] = [];
  return {
    workspace: { workspaceId: "S7f3A9-bot", filesDir: dataDir } as PluginContext["workspace"],
    secrets: {
      async resolve(reference) {
        asked.push(reference);
        if (reference === "env:OGB_TEMP_MAIL_ADMIN" && admin) return admin;
        throw new OgbError("not_found", `${reference} is not set`);
      },
    },
    signals: { emit() {} },
    dataDir,
    sharedDataDir: dataDir,
    log: { info() {}, warn() {}, error() {} },
  };
}

const ENV = { OGB_TEMP_MAIL_URL: "https://mail-api.example.test", OGB_TEMP_MAIL_DOMAIN: "mail.test" };

describe("mail-temp", () => {
  it("names the mailbox after the workspace: bot- and letters and digits only", () => {
    expect(mailboxName("S7f3A9-bot")).toBe("bot-s7f3a9bot");
    expect(mailboxName("---")).toBe("bot-x");
  });

  it("makes the address once, keeps the token in a file only its owner reads, and reuses it after a restart", async () => {
    const site = createFakeTempMail({ domain: "mail.test" });
    const ctx = context(site.adminPassword);
    const provider = await providerFor(ctx, ENV, site.fetch);
    expect(provider.address).toBe("bot-s7f3a9bot@mail.test");
    const file = join(ctx.dataDir, "address", "account.json");
    expect(statSync(file).mode & 0o777).toBe(0o600);
    expect(JSON.parse(readFileSync(file, "utf8")).address).toBe(provider.address);

    site.deliver(provider.address as string, { from: "shop@x.test", subject: "Your code is 4711", body: "4711" });
    const restarted = await providerFor({ ...ctx, dataDir: ctx.dataDir }, ENV, site.fetch); // same session: the same promise
    expect(restarted).toBe(provider);
    expect(site.requests.filter((r) => r === "POST /admin/new_address")).toHaveLength(1);
    expect((await provider.mail!.reader!.list({}))[0]?.subject).toBe("Your code is 4711");
  });

  it("without a deployment in the environment it says what is missing; without the admin password it cannot make the address", async () => {
    const site = createFakeTempMail({ domain: "mail.test" });
    await expect(providerFor(context(site.adminPassword), {}, site.fetch)).rejects.toThrow(/OGB_TEMP_MAIL_URL and OGB_TEMP_MAIL_DOMAIN/);
    await expect(providerFor(context(undefined), ENV, site.fetch)).rejects.toThrow(/OGB_TEMP_MAIL_ADMIN/);
  });
});
