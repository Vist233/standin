import { JOURNAL_FIXTURES } from "@standin/contracts/testing";
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { applyEvent, createState, foldEvents, visible } from "../src/model.js";
import { parsePrefs } from "../src/prefs.js";
import { fmtDuration, greeting, hostOf, needsInsert, splitFences, startupWarnings, textToKeysyms } from "../src/text.js";
import { chatTimeline } from "../src/chat.js";
import { composerButton, deskIntent, needsYou, questionMarker, railStatus, titleBadge } from "../src/timeline.js";

const T0 = 1_800_000_000_000;
const fold = (name: keyof typeof JOURNAL_FIXTURES) => foldEvents(JOURNAL_FIXTURES[name]() as any[]);

describe("needsYou", () => {
  it("lists open login questions and pending approvals, not expired or answered ones", () => {
    const login = fold("loginTakeoverJourney");
    expect(needsYou(login)).toEqual([]); // answered by the take-over
    const approvals = fold("approvalsPendingAndExpired");
    expect(needsYou(approvals).map((i: any) => i.id)).toEqual(["a_2"]); // a_1 expired
    const open = foldEvents((JOURNAL_FIXTURES.loginTakeoverJourney() as any[]).slice(0, 12));
    expect(needsYou(open).map((i: any) => i.id)).toEqual(["q_1"]);
  });
});

describe("deskIntent", () => {
  const login = (n = 12) => foldEvents((JOURNAL_FIXTURES.loginTakeoverJourney() as any[]).slice(0, n));

  it("a take-over left open goes straight to the stage", () => {
    expect(deskIntent(login(15), T0 + 130_000)).toEqual({ intent: "stage", key: -1 });
  });
  it("an open login question highlights the Desk button without opening the panel", () => {
    expect(deskIntent(login(), T0 + 10 * 3_600_000)).toEqual({ intent: "light-chip", key: 11 });
  });
  it("a recent browser call highlights the Desk button, and an old call does nothing", () => {
    const early = login(3);
    expect(deskIntent(early, T0 + 5000)).toMatchObject({ intent: "light-chip" });
    expect(deskIntent(early, T0 + 5 * 60_000)).toBeNull();
  });
  it("nothing for a chat without a browser", () => {
    expect(deskIntent(fold("plainChatTurn"), T0)).toBeNull();
  });
  it("the key is the run for a browser call, so it acts once per run, and the question for a login", () => {
    const a = deskIntent(login(3), T0 + 1000);
    const b = deskIntent(login(9), T0 + 10_000);
    expect(a?.key).toBe(b?.key); // the same run
    expect(deskIntent(login(), T0 + 20_000)?.key).not.toBe(a?.key);
  });
});

describe("railStatus", () => {
  it("orders the dots: needs you, working, error, idle", () => {
    expect(railStatus({ state: { run: "active" }, pending: 1 })).toBe("needs");
    expect(railStatus({ state: { run: "idle" }, takeover: true })).toBe("needs");
    expect(railStatus({ state: { run: "active" }, pending: 0, lastRunEnd: "error" })).toBe("working");
    expect(railStatus({ state: { run: "idle" }, lastRunEnd: "error" })).toBe("error");
    expect(railStatus({ state: { run: "idle" }, lastRunEnd: "end" })).toBe("idle");
    expect(railStatus({ state: null })).toBe("idle");
    expect(railStatus({})).toBe("idle");
  });
});

describe("composerButton", () => {
  it("is Send, Steer or Stop, and disabled only when there is nothing to do", () => {
    expect(composerButton(false, false)).toMatchObject({ label: "Send", disabled: true, stops: false });
    expect(composerButton(false, true)).toMatchObject({ label: "Send", disabled: false });
    expect(composerButton(true, false)).toMatchObject({ label: "Stop", disabled: false, stops: true });
    expect(composerButton(true, true)).toMatchObject({ label: "Steer", disabled: false, stops: false });
  });
  it("cannot send at all while the person is in control of the desktop", () => {
    for (const [running, text] of [
      [false, true],
      [true, true],
      [true, false],
      [false, false],
    ] as const)
      expect(composerButton(running, text, true)).toMatchObject({ disabled: true, stops: false });
  });
});

describe("text helpers", () => {
  it("keeps plain text and fenced code apart", () => {
    expect(splitFences("Before\n```js\nlet a = 1;\n```\nAfter")).toEqual([
      { type: "text", text: "Before\n", lang: "" },
      { type: "code", text: "let a = 1;", lang: "js" },
      { type: "text", text: "After", lang: "" },
    ]);
    expect(splitFences("```\nopen")).toEqual([{ type: "code", text: "open", lang: "" }]);
    expect(splitFences("")).toEqual([]);
    expect(splitFences("no fences\nat all")).toEqual([{ type: "text", text: "no fences\nat all", lang: "" }]);
  });
  it("never throws and loses no character outside the fence lines (property)", () => {
    fc.assert(
      fc.property(fc.string({ maxLength: 200 }), (text) => {
        const parts = splitFences(text);
        const rebuilt = parts.map((p) => p.text).join("");
        const withoutFences = text.replace(/^```[ \t]*[^\n`]*\n?/gm, "").replace(/\n(?=$)/g, "");
        expect(rebuilt.replace(/\n/g, "")).toBe(withoutFences.replace(/\n/g, ""));
      }),
      { numRuns: 300 },
    );
  });
  it("host, title", () => {
    expect(hostOf("https://space.bilibili.com/1/video")).toBe("space.bilibili.com");
    expect(hostOf("/files/a.txt")).toBe("/files/a.txt");
    expect(hostOf("")).toBe("");
  });
});

describe("properties of the folded view", () => {
  const events = (fixture: keyof typeof JOURNAL_FIXTURES) => JOURNAL_FIXTURES[fixture]() as any[];
  const names = Object.keys(JOURNAL_FIXTURES) as (keyof typeof JOURNAL_FIXTURES)[];

  it("folding in halves equals folding at once, for the chat too (every fixture, every cut)", () => {
    for (const name of names) {
      const all = events(name);
      for (let cut = 0; cut <= all.length; cut++) {
        const halves = foldEvents(all.slice(0, cut));
        foldEvents(all.slice(cut), halves);
        const whole = foldEvents(all);
        expect(visible(halves)).toEqual(visible(whole));
        expect(chatTimeline(halves.items, T0)).toEqual(chatTimeline(whole.items, T0));
      }
    }
  });

  it("a resent overlap does not change the chat (every fixture)", () => {
    for (const name of names) {
      const all = events(name);
      const state = createState();
      for (let i = 0; i < all.length; i++) {
        applyEvent(state, all[i]);
        if (i % 3 === 2) for (const e of all.slice(Math.max(0, i - 2), i + 1)) applyEvent(state, e); // the connection dropped and the last events came again
      }
      expect(chatTimeline(state.items, T0)).toEqual(chatTimeline(foldEvents(all).items, T0));
    }
  });

  it("the chat never shows the work, keeps the order, and ends every group with a tail (random prefixes of random fixtures)", () => {
    fc.assert(
      fc.property(fc.constantFrom(...names), fc.nat(40), (name, cut) => {
        const state = foldEvents(events(name).slice(0, cut));
        const entries = chatTimeline(state.items, T0);
        const messages = entries.filter((e) => e.type === "msg");
        for (const entry of messages) if (entry.type === "msg") expect(entry.item.kind).not.toBe("tool");
        const seqs = messages.map((e) => (e.type === "msg" ? e.item.seq : 0));
        expect(seqs).toEqual([...seqs].sort((a, b) => a - b));
        const last = messages.at(-1);
        if (last?.type === "msg") expect(last.tail).toBe(true);
        for (let i = 1; i < entries.length; i++) expect(entries[i - 1]?.type === "day" && entries[i]?.type === "day").toBe(false);
      }),
      { numRuns: 200 },
    );
  });
});

describe("textToKeysyms", () => {
  it("ASCII is its own code point, newline is Return, tab is Tab", () => {
    expect(textToKeysyms("aZ09 ")).toEqual([0x61, 0x5a, 0x30, 0x39, 0x20]);
    expect(textToKeysyms("a\nb\tc")).toEqual([0x61, 0xff0d, 0x62, 0xff09, 0x63]);
    expect(textToKeysyms("a\r\nb")).toEqual([0x61, 0xff0d, 0x62]);
    expect(textToKeysyms("a\rb")).toEqual([0x61, 0xff0d, 0x62]);
  });
  it("keeps symbols as they are", () => {
    const symbols = "!@#$%^&*()_+-=[]{}\\|;:'\",.<>/?`~";
    expect(textToKeysyms(symbols)).toEqual([...symbols].map((c) => c.codePointAt(0)));
  });
  it("other characters use the Unicode keysym range", () => {
    expect(textToKeysyms("你好")).toEqual([0x01004f60, 0x0100597d]);
    expect(textToKeysyms("é")).toEqual([0x010000e9]);
  });
  it("an emoji in two UTF-16 halves is one character", () => {
    expect("😀".length).toBe(2);
    expect(textToKeysyms("😀")).toEqual([0x01000000 + 0x1f600]);
    expect(textToKeysyms("a😀b")).toHaveLength(3);
  });
  it("drops control characters and never throws", () => {
    expect(textToKeysyms("a\u0000\u001b\u007fb")).toEqual([0x61, 0x62]);
    expect(textToKeysyms("")).toEqual([]);
    expect(textToKeysyms(undefined as unknown as string)).toEqual([]);
  });
  it("one keysym per code point for any text (property)", () => {
    fc.assert(
      fc.property(fc.string({ unit: "binary", maxLength: 60 }), (text) => {
        const printable = [...text].filter((c) => {
          const code = c.codePointAt(0) ?? 0;
          return (code >= 0x20 && code <= 0x7e) || code >= 0xa0;
        });
        const newlines = [...text.replace(/\r\n/g, "\n")].filter((c) => c === "\n" || c === "\r" || c === "\t").length;
        expect(textToKeysyms(text)).toHaveLength(printable.length + newlines);
      }),
      { numRuns: 300 },
    );
  });
});

describe("startupWarnings", () => {
  it("shows warnings only, one entry per line; information is not shown", () => {
    expect(
      startupWarnings([
        { level: "info", text: "model: main" },
        { level: "warn", text: "The model key is not set." },
        { level: "warn", text: "Desk is down." },
      ]),
    ).toEqual(["The model key is not set.", "Desk is down."]);
    expect(startupWarnings([{ level: "info", text: "all good" }])).toEqual([]);
  });
  it("a plain string (the older shape) counts as a warning; junk is ignored", () => {
    expect(startupWarnings(["old line", "", null, 5, { level: "warn" }, { text: "x" }, { level: "warn", text: 7 }])).toEqual(["old line"]);
    expect(startupWarnings(undefined)).toEqual([]);
  });
});

describe("needsInsert", () => {
  it("is true for any non-ASCII character and false for ASCII, symbols and newlines", () => {
    expect(["你好", "é", "a😀", "pass!word", "!@#$%^&*()", "line\nbreak\ttab", ""].map(needsInsert)).toEqual([true, true, true, false, false, false, false]);
    expect(needsInsert(undefined as unknown as string)).toBe(false);
  });
});

describe("greeting", () => {
  it("greets by the hour", () => {
    expect([0, 4, 5, 11, 12, 17, 18, 23].map(greeting)).toEqual([
      "Good evening.",
      "Good evening.",
      "Good morning.",
      "Good morning.",
      "Good afternoon.",
      "Good afternoon.",
      "Good evening.",
      "Good evening.",
    ]);
    expect(greeting(Number.NaN)).toBe("Good afternoon.");
  });
});

describe("parsePrefs", () => {
  it("reads what was stored and clamps the fraction to the window", () => {
    expect(parsePrefs(JSON.stringify({ frac: 0.5, collapsed: true }), 1440)).toEqual({ frac: expect.closeTo(0.5), collapsed: true });
    expect(parsePrefs(JSON.stringify({ frac: 5 }), 1440).frac).toBeCloseTo(760 / 1440);
  });
  it("damaged, missing or odd storage gives the defaults", () => {
    for (const raw of [null, undefined, "", "{", "[]", "null", "5", JSON.stringify({ frac: "x", collapsed: "yes" })])
      expect(parsePrefs(raw, 1440)).toEqual({ frac: null, collapsed: false });
  });
});

describe("questionMarker and titleBadge", () => {
  it("keeps one line for a question or approval, with how long it took once it is over", () => {
    const journey = fold("loginTakeoverJourney");
    const question = journey.items.find((i) => i.kind === "question") as any;
    expect(questionMarker({ ...question, answered: false })).toBe("Asked you to sign in");
    expect(questionMarker(question)).toBe("You signed in · 3 min 8 s");
    expect(questionMarker({ ...question, ask: "info", answered: false })).toBe("Asked you a question");
    const [expired, pending] = fold("approvalsPendingAndExpired").items.filter((i) => i.kind === "approval") as any[];
    expect(questionMarker(expired)).toBe("Expired: mail_send");
    expect(questionMarker(pending)).toBe("Asked you to allow post_public");
    expect(questionMarker({ ...pending, status: "approved" })).toBe("You allowed post_public");
    expect(questionMarker({ ...pending, status: "denied" })).toBe("You refused post_public");
    expect(questionMarker({ kind: "user", seq: 1, at: 1, text: "x" } as any)).toBe("");
  });
  it("puts the count in the tab title only when something waits", () => {
    expect([0, 1, 12, -1, Number.NaN, 1.5].map(titleBadge)).toEqual(["StandIn", "(1) StandIn", "(12) StandIn", "StandIn", "StandIn", "StandIn"]);
  });
});
