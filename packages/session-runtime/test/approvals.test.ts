import { describe, expect, it } from "vitest";
import { ApprovalBook } from "../src/approvals.ts";
import { pauseOf, runReasonOf } from "../src/events.ts";

describe("ApprovalBook", () => {
  it("a grant lets the same call run once, and only that call", () => {
    const book = new ApprovalBook();
    const { request, isNew } = book.request("mail_send", { to: "a" });
    expect(isNew).toBe(true);
    expect(book.consume("mail_send", { to: "a" })).toBe(false); // not approved yet
    expect(book.decide(request.id, true)?.status).toBe("approved");
    expect(book.consume("mail_send", { to: "b" })).toBe(false); // other arguments
    expect(book.consume("mail_send", { to: "a" })).toBe(true);
    expect(book.consume("mail_send", { to: "a" })).toBe(false); // consumed
  });

  it("asking again for the same call shows the same pending request; a refusal grants nothing; a second decision changes nothing", () => {
    const book = new ApprovalBook();
    const first = book.request("t", { x: 1 });
    expect(book.request("t", { x: 1 })).toMatchObject({ isNew: false, request: { id: first.request.id } });
    expect(book.pending().map((r) => r.id)).toEqual([first.request.id]);
    expect(book.decide(first.request.id, false)?.status).toBe("denied");
    expect(book.decide(first.request.id, true)).toBeUndefined();
    expect(book.consume("t", { x: 1 })).toBe(false);
    expect(book.pending()).toEqual([]);
    expect(book.has(first.request.id)).toBe(true);
    expect(book.has("ap_unknown")).toBe(false);
  });
});

describe("ApprovalBook: the same call whatever the order of its arguments", () => {
  it("an approved call repeated with its keys in another order runs; different content does not", () => {
    const book = new ApprovalBook();
    const { request } = book.request("mail_send", { to: ["li.wei@partner.test"], subject: "notes", body: "hi", meta: { a: 1, b: 2 } });
    book.decide(request.id, true);
    expect(book.consume("mail_send", { body: "hi", subject: "notes", meta: { b: 2, a: 1 }, to: ["li.wei@partner.test"] })).toBe(true);
    expect(ApprovalBook.keyOf("mail_send", { to: ["a@x.test", "b@x.test"] })).not.toBe(ApprovalBook.keyOf("mail_send", { to: ["b@x.test", "a@x.test"] }));
  });
});

describe("how a run's end is told to the page", () => {
  it("maps the framework's reasons to the page's words", () => {
    expect([runReasonOf("done"), runReasonOf("paused"), runReasonOf("cancelled"), runReasonOf("error")]).toEqual(["end", "pause", "cancelled", "error"]);
  });

  it("maps pauses: an approval is blocked, a budget that ran out of time is time, the rest keep their name", () => {
    expect(pauseOf("approval", 0, undefined)).toMatchObject({ reason: "blocked" });
    expect(pauseOf("input", 0, 900_000)).toEqual({ reason: "input" });
    expect(pauseOf("quota", 0, undefined)).toEqual({ reason: "quota" });
    expect(pauseOf("budget", 100_000, 900_000)).toEqual({ reason: "budget" });
    expect(pauseOf("budget", 900_000, 900_000)).toMatchObject({ reason: "time" });
    expect(pauseOf("budget", 5_000_000, undefined)).toEqual({ reason: "budget" });
  });
});
