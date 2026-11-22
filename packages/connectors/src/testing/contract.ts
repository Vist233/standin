import { isOgbError } from "@vesper/contracts";
import { describe, expect, it } from "vitest";
import type { CalendarEvent, MailSummary, Provider } from "../types.ts";

export interface ProviderHarness {
  provider: Provider;
  /** The account's own address (what `send` uses as the sender). */
  address: string;
  /** Makes a mail arrive in the inbox from outside the agent, as a real mail server would. Resolves when the provider can see it. */
  deliver(mail: { from: string; subject: string; body: string }): Promise<void>;
  /** Makes an event appear in the calendar from outside. Only needed by providers with a calendar. */
  addExternalEvent?(event: Omit<CalendarEvent, "id">): Promise<void>;
  /** Lets watchers that poll run. A provider that pushes can leave it empty. */
  settle(): Promise<void>;
  cleanup(): Promise<void>;
}

const kind = (k: string) => (e: unknown) => isOgbError(e, k as never);

/**
 * What every provider plugin must do, as tests. Run it against the simulated mailbox now and against each real provider
 * (IMAP and SMTP, CalDAV, Graph...) when it exists: a provider that passes can be used by the tools and the event source unchanged.
 * The suite only tests the parts a provider has (reader, sender, calendar).
 */
export function providerContract(name: string, create: () => Promise<ProviderHarness>): void {
  describe(`provider contract: ${name}`, () => {
    async function withHarness(body: (h: ProviderHarness) => Promise<void>) {
      const harness = await create();
      try {
        await body(harness);
      } finally {
        await harness.cleanup();
      }
    }

    it("lists mail newest first, with the filters, a limit, and unread flags that reading clears", async () => {
      await withHarness(async (h) => {
        const reader = h.provider.mail?.reader;
        if (!reader) return;
        await h.deliver({ from: "ann@a.test", subject: "Invoice March", body: "please pay" });
        await h.deliver({ from: "bob@b.test", subject: "Lunch", body: "noon?" });
        await h.deliver({ from: "ann@a.test", subject: "Re: Invoice March", body: "reminder to pay" });
        await h.settle();
        const all = await reader.list({});
        expect(all.map((m) => m.subject)).toEqual(["Re: Invoice March", "Lunch", "Invoice March"]);
        expect(all.every((m) => m.unread && m.folder === "inbox")).toBe(true);
        expect((await reader.list({ from: "bob" })).map((m) => m.subject)).toEqual(["Lunch"]);
        expect((await reader.list({ text: "invoice pay" })).map((m) => m.subject)).toEqual(["Re: Invoice March", "Invoice March"]);
        expect((await reader.list({ limit: 2 })).length).toBe(2);
        expect(await reader.list({ folder: "sent" })).toEqual([]);
        await reader.read(all[0]?.id as string);
        expect((await reader.list({ unreadOnly: true })).map((m) => m.subject)).toEqual(["Lunch", "Invoice March"]);
      });
    });

    it("reads a whole message, and an unknown id is not_found", async () => {
      await withHarness(async (h) => {
        const reader = h.provider.mail?.reader;
        if (!reader) return;
        await h.deliver({ from: "ann@a.test", subject: "Hello", body: "line one\nline two" });
        await h.settle();
        const [summary] = await reader.list({});
        const full = await reader.read(summary?.id as string);
        expect(full).toMatchObject({ from: "ann@a.test", subject: "Hello", body: "line one\nline two", folder: "inbox" });
        expect(full.to.length).toBeGreaterThan(0);
        await expect(reader.read("no-such-id")).rejects.toSatisfy(kind("not_found"));
      });
    });

    it("watch reports each new mail once and never mail that was already there; stop ends it", async () => {
      await withHarness(async (h) => {
        const reader = h.provider.mail?.reader;
        if (!reader) return;
        await h.deliver({ from: "old@a.test", subject: "Already here", body: "x" });
        await h.settle();
        const seen: MailSummary[] = [];
        const stop = reader.watch((m) => void seen.push(m));
        await h.deliver({ from: "new1@a.test", subject: "First", body: "x" });
        await h.deliver({ from: "new2@a.test", subject: "Second", body: "x" });
        await h.settle();
        await h.settle();
        expect(seen.map((m) => m.subject)).toEqual(["First", "Second"]);
        stop();
        stop();
        await h.deliver({ from: "late@a.test", subject: "After stop", body: "x" });
        await h.settle();
        expect(seen.map((m) => m.subject)).toEqual(["First", "Second"]);
      });
    });

    it("a watch that starts again from its cursor reports, once each, the mail that came while it was stopped", async () => {
      await withHarness(async (h) => {
        const reader = h.provider.mail?.reader;
        if (!reader) return;
        await h.deliver({ from: "old@a.test", subject: "Before", body: "x" });
        await h.settle();
        let cursor: string | undefined;
        const keep = (c: string) => {
          cursor = c;
        };
        const first: string[] = [];
        const stopFirst = reader.watch((m) => void first.push(m.subject), { onCursor: keep });
        await h.settle();
        await h.deliver({ from: "a@a.test", subject: "While up", body: "x" });
        await h.settle();
        await h.settle();
        stopFirst();
        expect(first).toEqual(["While up"]);
        expect(cursor).toBeDefined();

        await h.deliver({ from: "b@a.test", subject: "While down 1", body: "x" }); // the box is down
        await h.deliver({ from: "c@a.test", subject: "While down 2", body: "x" });
        await h.settle();
        const second: string[] = [];
        const stopSecond = reader.watch((m) => void second.push(m.subject), { after: cursor, onCursor: keep });
        await h.settle();
        await h.settle();
        await h.deliver({ from: "d@a.test", subject: "After restart", body: "x" });
        await h.settle();
        await h.settle();
        stopSecond();
        expect(second).toEqual(["While down 1", "While down 2", "After restart"]);
      });
    });

    it("send puts a copy in the sent folder, from the account's own address", async () => {
      await withHarness(async (h) => {
        const { reader, sender } = h.provider.mail ?? {};
        if (!sender) return;
        const result = await sender.send({ to: ["ann@a.test"], subject: "Re: Hello", body: "thanks" });
        expect(result.id).toBeTruthy();
        if (!reader) return;
        const sent = await reader.list({ folder: "sent" });
        expect(sent).toHaveLength(1);
        expect(sent[0]).toMatchObject({ subject: "Re: Hello", from: h.address, unread: false });
        const full = await reader.read(sent[0]?.id as string);
        expect(full.to).toEqual(["ann@a.test"]);
        expect(full.body).toBe("thanks");
      });
    });

    it("calendar: creates, lists a range by start time, reads, updates, and an unknown id is not_found", async () => {
      await withHarness(async (h) => {
        const calendar = h.provider.calendar;
        if (!calendar) return;
        const hour = 3_600_000;
        const base = Date.UTC(2026, 11, 1, 9);
        const lunch = await calendar.create({ title: "Lunch", start: base + 3 * hour, end: base + 4 * hour, attendees: ["ann@a.test"] });
        const standup = await calendar.create({ title: "Standup", start: base, end: base + hour / 2, attendees: [] });
        expect(lunch.id).not.toBe(standup.id);
        expect((await calendar.list({ from: base, to: base + 5 * hour })).map((e) => e.title)).toEqual(["Standup", "Lunch"]);
        expect((await calendar.list({ from: base + 5 * hour, to: base + 6 * hour })).map((e) => e.title)).toEqual([]);
        expect(await calendar.read(lunch.id)).toMatchObject({ title: "Lunch", attendees: ["ann@a.test"] });
        const moved = await calendar.update(lunch.id, { start: base + 4 * hour, end: base + 5 * hour, location: "Cafe" });
        expect(moved).toMatchObject({ id: lunch.id, title: "Lunch", location: "Cafe", start: base + 4 * hour });
        expect(await calendar.read(lunch.id)).toMatchObject({ location: "Cafe" });
        await expect(calendar.read("nope")).rejects.toSatisfy(kind("not_found"));
        await expect(calendar.update("nope", { title: "x" })).rejects.toSatisfy(kind("not_found"));
      });
    });

    it("calendar: watch reports an event that appears from outside, once, and stop ends it", async () => {
      await withHarness(async (h) => {
        const calendar = h.provider.calendar;
        if (!calendar || !h.addExternalEvent) return;
        const seen: string[] = [];
        const stop = calendar.watch((e) => void seen.push(e.title));
        await h.addExternalEvent({ title: "Invitation", start: 1_000, end: 2_000, attendees: [] });
        await h.settle();
        await h.settle();
        expect(seen).toEqual(["Invitation"]);
        stop();
        await h.addExternalEvent({ title: "Later", start: 3_000, end: 4_000, attendees: [] });
        await h.settle();
        expect(seen).toEqual(["Invitation"]);
      });
    });
  });
}
