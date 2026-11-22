// Outlook through Microsoft Graph, against a stand-in of Microsoft's sign-in and of Graph: the shared contract, the device-code sign-in,
// and the refresh token that Microsoft replaces on every use.
import { mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { isOgbError } from "@vesper/contracts";
import { afterEach, describe, expect, it } from "vitest";
import { createTokenKeeper, openGraphMailbox, startDeviceLogin } from "../src/index.ts";
import { createFakeGraph, type FakeGraph, providerContract } from "../src/testing/index.ts";

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});
const tempFile = () => {
  const dir = mkdtempSync(join(tmpdir(), "ogb-outlook-"));
  dirs.push(dir);
  return join(dir, "outlook", "tokens.json");
};
const SCOPES = ["offline_access", "Mail.ReadWrite", "Mail.Send", "User.Read"];
const appOf = (graph: FakeGraph) => ({ clientId: "client-1", tenant: "consumers", scopes: SCOPES, fetch: graph.fetch, authority: graph.authority });
const instant = { wait: async () => undefined };

/** Signs in through the device code as the person would, and returns a keeper holding the tokens. */
async function signedIn(graph: FakeGraph, file: string) {
  const login = await startDeviceLogin(appOf(graph), instant);
  graph.signIn(login.userCode);
  const keeper = createTokenKeeper(appOf(graph), file);
  keeper.save(await login.done);
  return keeper;
}

providerContract("outlook (Microsoft Graph)", async () => {
  const graph = createFakeGraph();
  const keeper = await signedIn(graph, tempFile());
  const provider = await openGraphMailbox({ accessToken: keeper.accessToken, fetch: graph.fetch, baseUrl: graph.baseUrl, pollMs: 10 });
  return {
    provider,
    address: graph.address,
    async deliver(mail) {
      graph.deliver(mail);
    },
    settle: () => new Promise((resolve) => setTimeout(resolve, 40)),
    cleanup: async () => {},
  };
});

describe("signing in to Microsoft with the device code", () => {
  it("shows a page and a code, waits while the person has not signed in, then has tokens", async () => {
    const graph = createFakeGraph();
    let polls = 0;
    const login = await startDeviceLogin(appOf(graph), {
      wait: async () => {
        polls += 1;
        if (polls === 3) graph.signIn("CODE1");
      },
    });
    expect(login).toMatchObject({ verificationUri: "https://microsoft.com/devicelogin", userCode: "CODE1" });
    const tokens = await login.done;
    expect(polls).toBe(3);
    expect(tokens.refreshToken).toBeTruthy();
    expect(graph.requests[0]).toBe("POST /consumers/oauth2/v2.0/devicecode");
  });

  it("a declined sign-in is denied", async () => {
    const graph = createFakeGraph();
    const login = await startDeviceLogin(appOf(graph), instant);
    graph.decline(login.userCode);
    await expect(login.done).rejects.toSatisfy((e: unknown) => isOgbError(e, "denied"));
  });
});

describe("the token keeper", () => {
  it("keeps the tokens in a file only its owner reads; when the access token ends it refreshes and writes the new refresh token", async () => {
    const graph = createFakeGraph();
    const file = tempFile();
    let now = Date.now();
    const login = await startDeviceLogin(appOf(graph), instant);
    graph.signIn(login.userCode);
    const keeper = createTokenKeeper(appOf(graph), file, () => now);
    expect(keeper.connected()).toBe(false);
    keeper.save(await login.done);
    expect(statSync(file).mode & 0o777).toBe(0o600);
    const first = JSON.parse(readFileSync(file, "utf8")).refreshToken;
    expect(await keeper.accessToken()).toBe(JSON.parse(readFileSync(file, "utf8")).accessToken);

    now += 2 * 3600_000; // two hours later
    graph.expireAccessTokens();
    const mailbox = await openGraphMailbox({ accessToken: keeper.accessToken, fetch: graph.fetch, baseUrl: graph.baseUrl });
    expect(mailbox.address).toBe(graph.address);
    const second = JSON.parse(readFileSync(file, "utf8")).refreshToken;
    expect(second).not.toBe(first); // Microsoft replaced it, and the new one is the one kept

    const reopened = createTokenKeeper(appOf(graph), file, () => now); // after a restart
    expect(reopened.connected()).toBe(true);
    await expect(reopened.accessToken()).resolves.toBeTruthy();
  });

  it("a refresh token that no longer works says to sign in again", async () => {
    const graph = createFakeGraph();
    const file = tempFile();
    let now = Date.now();
    const keeper = createTokenKeeper(appOf(graph), file, () => now);
    keeper.save({ accessToken: "old", refreshToken: "revoked", expiresAt: now - 1 });
    await expect(keeper.accessToken()).rejects.toThrow(/sign in again/);
    now += 1;
  });
});
