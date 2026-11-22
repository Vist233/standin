// The person's Outlook belongs to one bot: the first one the person signs in with. Against stand-ins of Microsoft's sign-in and Graph.
import { mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createFakeGraph } from "@vesper/connectors/testing";
import { isOgbError, type PluginContext, type SignalDraft } from "@vesper/contracts";
import { afterEach, describe, expect, it } from "vitest";
import { createOutlook } from "../src/outlook.ts";
import { outlookFor } from "../src/shared.ts";

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});
const shared = () => {
  const dir = mkdtempSync(join(tmpdir(), "ogb-outlook-plugin-"));
  dirs.push(dir);
  return dir;
};

function bot(workspaceId: string, sharedDataDir: string, signals: SignalDraft[]): PluginContext {
  return {
    workspace: { workspaceId, filesDir: sharedDataDir } as PluginContext["workspace"],
    secrets: { resolve: async () => Promise.reject(new Error("no secrets here")) },
    signals: { emit: (_target, draft) => void signals.push(draft) },
    dataDir: join(sharedDataDir, workspaceId),
    sharedDataDir,
    log: { info() {}, warn() {}, error() {} },
  };
}

const ENV = { OGB_OUTLOOK_CLIENT_ID: "client-1", OGB_OUTLOOK_TENANT: "consumers" };

describe("mail-outlook", () => {
  it("before the sign-in the tools say how to connect; the first bot signed in holds it; another bot is refused", async () => {
    const graph = createFakeGraph();
    const dir = shared();
    const signalsA: SignalDraft[] = [];
    const options = { env: ENV, fetch: graph.fetch, authority: graph.authority, graphUrl: graph.baseUrl, wait: async () => undefined, pollMs: 10 };
    const a = createOutlook(bot("bot-a", dir, signalsA), options);
    const b = createOutlook(bot("bot-b", dir, []), options);

    await expect(a.provider.mail!.reader!.list({})).rejects.toThrow(/outlook_connect/);
    const said = await a.connect();
    expect(said).toMatch(/open https:\/\/microsoft\.com\/devicelogin and enter the code CODE\d+/);
    expect(await a.connect()).toMatch(/already waiting/);
    graph.signIn(/code (CODE\d+)/.exec(said)?.[1] as string);
    await a.waitForSignIn();
    expect(signalsA.map((s) => s.text)).toEqual([`Outlook connected: ${graph.address}`]);
    expect(statSync(join(dir, "tokens.json")).mode & 0o777).toBe(0o600);

    graph.deliver({ from: "boss@work.test", subject: "Budget", body: "numbers" });
    expect((await a.provider.mail!.reader!.list({}))[0]?.subject).toBe("Budget");
    expect(await b.connect()).toMatch(/belongs to another bot/);
    await expect(b.provider.mail!.reader!.list({})).rejects.toSatisfy((e: unknown) => isOgbError(e, "denied"));
  });

  it("watch waits for the sign-in and then reports new mail", async () => {
    const graph = createFakeGraph();
    const dir = shared();
    const options = { env: ENV, fetch: graph.fetch, authority: graph.authority, graphUrl: graph.baseUrl, wait: async () => undefined, pollMs: 10 };
    const a = createOutlook(bot("bot-a", dir, []), options);
    const seen: string[] = [];
    const stop = a.provider.mail!.reader!.watch((mail) => void seen.push(mail.subject));
    const said = await a.connect();
    graph.signIn(/code (CODE\d+)/.exec(said)?.[1] as string);
    await a.waitForSignIn();
    await new Promise((resolve) => setTimeout(resolve, 50));
    graph.deliver({ from: "x@y.test", subject: "After", body: "b" });
    await new Promise((resolve) => setTimeout(resolve, 80));
    stop();
    expect(seen).toEqual(["After"]);
  });

  it("without OGB_OUTLOOK_CLIENT_ID it says the box is not set up", async () => {
    const a = createOutlook(bot("bot-a", shared(), []), { env: {} });
    expect(await a.connect()).toMatch(/OGB_OUTLOOK_CLIENT_ID/);
  });

  it("the tools and the event source of one session share one Outlook object (outlookFor)", () => {
    const dir = shared();
    const ctx = bot("bot-a", dir, []);
    expect(outlookFor(ctx)).toBe(outlookFor(ctx));
    expect(outlookFor(bot("bot-b", dir, []))).not.toBe(outlookFor(ctx));
  });
});
