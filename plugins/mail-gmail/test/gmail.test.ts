// Gmail over IMAP and SMTP: the shared contract (over a memory IMAP account, both for Gmail, which files sent mail itself, and for other
// servers, where the copy is appended), then the claiming by one bot with the person's approval.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { providerContract } from "@vesper/connectors/testing";
import { isOgbError, type PluginContext } from "@vesper/contracts";
import { afterEach, describe, expect, it } from "vitest";
import { createGmail, GMAIL_VARIABLES, serversOf } from "../src/gmail.ts";
import { createImapProvider } from "../src/provider.ts";
import { gmailFor } from "../src/shared.ts";
import { createMemoryImap } from "./memory-store.ts";

for (const gmail of [true, false]) {
  providerContract(`imap-smtp (${gmail ? "Gmail files sent mail" : "the copy is appended"})`, async () => {
    const imap = createMemoryImap({ gmail });
    const provider = createImapProvider({ store: imap.store, transport: imap.transport, address: "me@gmail.test", appendSent: !gmail, pollMs: 10, retryMs: 5 });
    return {
      provider,
      address: "me@gmail.test",
      async deliver(mail) {
        imap.deliver(mail);
      },
      settle: () => new Promise((resolve) => setTimeout(resolve, 40)),
      cleanup: async () => {},
    };
  });
}

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});
function bot(workspaceId: string, sharedDataDir: string, password = "app-pass-1234"): PluginContext {
  return {
    workspace: { workspaceId, filesDir: sharedDataDir } as PluginContext["workspace"],
    secrets: { resolve: async (reference) => (reference === "env:OGB_GMAIL_APP_PASSWORD" ? password : Promise.reject(new Error("no"))) },
    signals: { emit() {} },
    dataDir: join(sharedDataDir, workspaceId),
    sharedDataDir,
    log: { info() {}, warn() {}, error() {} },
  };
}

describe("mail-gmail", () => {
  it("is nobody's until a bot connects it (the person approves that call); then only that bot may use it", async () => {
    const dir = mkdtempSync(join(tmpdir(), "ogb-gmail-"));
    dirs.push(dir);
    const imap = createMemoryImap({ gmail: true });
    const logins: string[] = [];
    const options = {
      env: { OGB_GMAIL_ADDRESS: "me@gmail.test" },
      pollMs: 10,
      connect: async (account: { address: string; password: string }) => {
        logins.push(`${account.address}:${account.password}`);
        return { store: imap.store, transport: imap.transport };
      },
    };
    const a = createGmail(bot("bot-a", dir), options);
    const b = createGmail(bot("bot-b", dir), options);
    imap.deliver({ from: "boss@work.test", subject: "Plan", body: "draft" });
    await expect(a.provider.mail!.reader!.list({})).rejects.toThrow(/gmail_connect/);
    expect(await a.connect()).toBe("Gmail is connected: me@gmail.test.");
    expect(logins).toEqual(["me@gmail.test:app-pass-1234"]);
    expect((await a.provider.mail!.reader!.list({}))[0]?.subject).toBe("Plan");
    expect(await b.connect()).toMatch(/belongs to another bot/);
    await expect(b.provider.mail!.reader!.list({})).rejects.toSatisfy((e: unknown) => isOgbError(e, "denied"));
  });

  it("without the address it says what is missing; servers default to Gmail's, others are given as host:port", async () => {
    const dir = mkdtempSync(join(tmpdir(), "ogb-gmail-"));
    dirs.push(dir);
    expect(await createGmail(bot("bot-a", dir), { env: {} }).connect()).toContain(GMAIL_VARIABLES.address);
    expect(serversOf({})).toEqual({ imap: { host: "imap.gmail.com", port: 993 }, smtp: { host: "smtp.gmail.com", port: 465 }, appendSent: false });
    expect(serversOf({ OGB_GMAIL_IMAP_HOST: "mail.example.test:1993", OGB_GMAIL_SMTP_HOST: "mail.example.test:587" })).toEqual({
      imap: { host: "mail.example.test", port: 1993 },
      smtp: { host: "mail.example.test", port: 587 },
      appendSent: true,
    });
    expect(gmailFor(bot("bot-a", dir))).toBe(gmailFor(bot("bot-a", dir)));
  });
});
