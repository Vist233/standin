// The temp-mail provider against a stand-in of a cloudflare_temp_email deployment: the shared contract, then what is particular to it.
import { isOgbError } from "@vesper/contracts";
import { describe, expect, it } from "vitest";
import { createTempMailAddresses, createTempMailProvider } from "../src/index.ts";
import { createFakeTempMail, providerContract } from "../src/testing/index.ts";

const BASE = "https://mail-api.example.test";

providerContract("temp-mail (cloudflare_temp_email)", async () => {
  const site = createFakeTempMail({ domain: "mail.test" });
  const made = await createTempMailAddresses({ baseUrl: BASE, fetch: site.fetch, adminPassword: site.adminPassword, domain: "mail.test" }).create("bot-1");
  const provider = createTempMailProvider({ baseUrl: BASE, fetch: site.fetch, address: made.address, token: made.credential, pollMs: 10 });
  return {
    provider,
    address: made.address,
    async deliver(mail) {
      site.deliver(made.address, mail);
    },
    settle: () => new Promise((resolve) => setTimeout(resolve, 40)),
    cleanup: async () => {},
  };
});

describe("temp-mail", () => {
  it("makes an address on the domain with the admin password; a wrong password or a bad name is refused", async () => {
    const site = createFakeTempMail({ domain: "mail.test" });
    const addresses = createTempMailAddresses({ baseUrl: `${BASE}/`, fetch: site.fetch, adminPassword: site.adminPassword, domain: "mail.test" });
    const made = await addresses.create("scout");
    expect(made.address).toBe("scout@mail.test");
    expect(made.credential).toBeTruthy();
    const wrong = createTempMailAddresses({ baseUrl: BASE, fetch: site.fetch, adminPassword: "nope", domain: "mail.test" });
    await expect(wrong.create("x")).rejects.toSatisfy((e: unknown) => isOgbError(e, "denied"));
    await expect(addresses.create("Bad Name!")).rejects.toSatisfy((e: unknown) => isOgbError(e, "invalid_input"));
  });

  it("an address sees only its own mail; read state is the caller's; the site password goes on every request", async () => {
    const site = createFakeTempMail({ domain: "mail.test", sitePassword: "site" });
    const opts = { baseUrl: BASE, fetch: site.fetch, sitePassword: "site" };
    const addresses = createTempMailAddresses({ ...opts, adminPassword: site.adminPassword, domain: "mail.test" });
    const a = await addresses.create("a");
    const b = await addresses.create("b");
    site.deliver(a.address, { from: "Ann <ann@x.test>", subject: "for a", body: "hi" });
    site.deliver(b.address, { from: "bob@x.test", subject: "for b", body: "hi" });
    const read = new Set<string>();
    const state = { has: (id: string) => read.has(id), add: (id: string) => void read.add(id) };
    const mailA = createTempMailProvider({ ...opts, address: a.address, token: a.credential, readState: state });
    const [only, ...rest] = await mailA.mail!.reader!.list({});
    expect(rest).toEqual([]);
    expect(only).toMatchObject({ subject: "for a", from: "Ann <ann@x.test>", unread: true });
    await mailA.mail!.reader!.read(only!.id);
    expect([...read]).toEqual([only!.id]);
    const again = createTempMailProvider({ ...opts, address: a.address, token: a.credential, readState: state });
    expect((await again.mail!.reader!.list({}))[0]?.unread).toBe(false); // kept across restarts by whoever keeps the state
  });

  it("a deployment without a sending method fails the send with its own words", async () => {
    const site = createFakeTempMail();
    const made = await createTempMailAddresses({ baseUrl: BASE, fetch: site.fetch, adminPassword: site.adminPassword, domain: "mail.test" }).create("c");
    const provider = createTempMailProvider({ baseUrl: BASE, fetch: site.fetch, address: made.address, token: made.credential });
    site.sendingOff = true;
    await expect(provider.mail!.sender!.send({ to: ["x@y.test"], subject: "s", body: "b" })).rejects.toThrow(/no sending method/);
    await expect(provider.mail!.reader!.read("zzz")).rejects.toSatisfy((e: unknown) => isOgbError(e, "not_found"));
  });
});

describe("the address an owner keeps (openTempMailAccount) and the settings from the environment", () => {
  it("makes the address once; a second open reads the private file; a taken name gets a short suffix", async () => {
    const { mkdtempSync, rmSync, statSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const { openTempMailAccount } = await import("../src/index.ts");
    const dir = mkdtempSync(join(tmpdir(), "ogb-tm-"));
    try {
      const site = createFakeTempMail({ domain: "mail.test" });
      let asked = 0;
      const adminPassword = async () => {
        asked += 1;
        return site.adminPassword;
      };
      const options = { directory: join(dir, "a"), name: "vesper", site: { baseUrl: BASE, fetch: site.fetch }, domain: "mail.test", adminPassword };
      const first = await openTempMailAccount(options);
      const second = await openTempMailAccount(options);
      expect(first.address).toBe("vesper@mail.test");
      expect(second.address).toBe(first.address);
      expect(asked).toBe(1);
      expect(statSync(join(dir, "a", "account.json")).mode & 0o777).toBe(0o600);

      let calls = 0;
      const flaky: typeof fetch = async (input, init) => {
        if (String(input).endsWith("/admin/new_address")) {
          calls += 1;
          if (calls === 1) return new Response("exists", { status: 400 });
        }
        return site.fetch(input, init);
      };
      const other = await openTempMailAccount({ ...options, directory: join(dir, "b"), site: { baseUrl: BASE, fetch: flaky } });
      expect(other.address).toMatch(/^vesper-[0-9a-f]{4}@mail\.test$/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("is on only with both the address and the domain; a bad address is refused by name", async () => {
    const { tempMailSettings, TEMP_MAIL_VARIABLES } = await import("../src/index.ts");
    expect(tempMailSettings({})).toBeUndefined();
    expect(tempMailSettings({ [TEMP_MAIL_VARIABLES.url]: BASE })).toBeUndefined();
    expect(tempMailSettings({ [TEMP_MAIL_VARIABLES.url]: BASE, [TEMP_MAIL_VARIABLES.domain]: "mail.test" })).toEqual({ baseUrl: BASE, domain: "mail.test" });
    expect(() => tempMailSettings({ [TEMP_MAIL_VARIABLES.url]: "ftp://x", [TEMP_MAIL_VARIABLES.domain]: "d" })).toThrow(/OGB_TEMP_MAIL_URL/);
  });
});
