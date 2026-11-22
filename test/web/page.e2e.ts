// Browser tests of the page (usable plan section 4 and revision 1). Run them in the box image, where Playwright's Chromium
// is installed (on a laptop OGB_CHROME=1 uses the installed Google Chrome). Run with `npm run test:web`. The gateway is real; the runtime, the workspace host and the desktop
// (an RFB server behind a real WebSocket) are fakes, so the take-over path is exercised end to end except for the daemon.
import { JOURNAL_FIXTURES } from "@standin/contracts/testing";
import { type Browser, type BrowserContext, chromium, type Page } from "playwright-core";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { type Harness, startHarness } from "./harness.ts";
import "./locator-matchers.ts";

const user = (text: string) => ({ role: "user", content: [{ type: "text", text }], ts: 1 });
const assistant = (text: string) => ({ role: "assistant", content: [{ type: "text", text }], ts: 1 });

let browser: Browser;
beforeAll(async () => {
  browser = await chromium.launch({ headless: true, ...(process.env.OGB_CHROME ? { channel: "chrome" } : {}) });
});
afterAll(async () => {
  await browser.close();
});

let harness: Harness | undefined;
let context: BrowserContext | undefined;
afterEach(async () => {
  await context?.close();
  await harness?.stop();
  context = undefined;
  harness = undefined;
});

async function open(options: Parameters<typeof startHarness>[0] = {}, session = "s_a") {
  harness = await startHarness(options);
  const h = harness;
  await h.addSession(session, "Taxes");
  context = await browser.newContext({ viewport: { width: 1400, height: 900 } });
  const page = await context.newPage();
  const emit = (type: string, payload: unknown) => h.runtime.emit(session, { type, payload: payload as never });
  return { h, page, emit };
}
const goTo = (page: Page, h: Harness, session = "s_a") => page.goto(`${h.url}/#/s/${session}`);
const sent = (h: Harness, prefix: string) => h.runtime.calls.filter((c) => c.startsWith(`send:s_a:${prefix}`));
const message = (page: Page) => page.getByLabel("Message to the agent");
const log = (page: Page) => page.getByRole("log", { name: "Conversation" });

async function feed(h: Harness, session: string, fixture: keyof typeof JOURNAL_FIXTURES) {
  for (const event of JOURNAL_FIXTURES[fixture](session)) await h.runtime.emit(session, { type: event.type, payload: event.payload });
}

describe("the page in a real browser", () => {
  it("opens the last conversation; New bot makes a bot with a name and a star, and its job is the first message", async () => {
    const { h, page } = await open();
    await page.goto(h.url);
    await expect.poll(() => page.url()).toMatch(/#\/s\/s_a$/); // as a chat app: it continues where the person was, not on an empty page
    await expect(page.locator("#composer")).toBeVisible();
    expect(await page.getByLabel("Model").count()).toBe(0); // no model or profile pickers (owner's item 4)
    await page.getByRole("button", { name: "New bot" }).first().click();
    const sheet = page.getByRole("dialog", { name: "New bot" });
    await expect(sheet).toBeVisible();
    await expect.poll(() => sheet.getByLabel("Name").inputValue()).toBe("Vega"); // the first free preset name
    await sheet.getByRole("button", { name: "Rigel" }).click();
    await expect.poll(() => sheet.getByLabel("Name").inputValue()).toBe("Rigel"); // one click fills name and star
    await sheet.getByLabel(/What is it for/).fill("Watch my inbox every morning");
    await sheet.getByRole("button", { name: "Create" }).click();
    await expect.poll(() => page.url()).toMatch(/#\/s\/s_fake1$/);
    expect(h.runtime.calls.find((c) => c.startsWith("createSession"))).toBe('createSession:{"title":"Rigel","star":"rigel"}');
    await expect.poll(() => h.runtime.calls.filter((c) => c.startsWith("send:s_fake1:Watch my inbox every morning"))).toHaveLength(1);
    const rail = page.getByRole("navigation", { name: "Bots" });
    await expect(rail.getByRole("button", { name: /Rigel/ })).toHaveAttribute("aria-current", "true");
    await expect(page.locator("#composer")).toBeVisible();
  });

  it("renames the bot by clicking its name in the top bar", async () => {
    const { h, page } = await open();
    await goTo(page, h);
    await page.getByRole("button", { name: "Taxes" }).first().waitFor();
    await page.locator("#bot-name").click();
    const field = page.getByLabel("New name of this bot");
    await field.fill("Tax return 2026");
    await field.press("Enter");
    await expect.poll(() => h.runtime.calls).toContain('updateSession:s_a:{"title":"Tax return 2026"}');
    await expect(page.locator("#bot-name")).toHaveText("Tax return 2026");
    await expect(page.getByRole("navigation", { name: "Bots" }).getByRole("button", { name: /Tax return 2026/ })).toBeVisible();
  });

  it("streams a conversation: bubbles, agent text as Markdown with a code block, and ONE quiet activity line", async () => {
    const { h, page, emit } = await open();
    await goTo(page, h);
    await emit("run.started", null);
    await emit("message.user", user("Find my documents"));
    await emit("message.assistant", assistant("Looking now.\n\n- **first** place\n- second\n```sh\nls -la\n```\nDone. <b>not bold</b>"));
    const browserCall = (id: string, action: string, target: string) => ({ id, name: "tool_call", arguments: {}, tool: { name: "browser", action, target } });
    const c1 = browserCall("c1", "open", "https://example.com/docs");
    await emit("tool.call", c1);
    await emit("tool.call", { id: "r1", name: "review", arguments: {}, tool: { name: "browser", action: "open" }, parentCallId: "c1" });
    await expect(page.locator("#typing")).toBeVisible(); // while it works: typing, as a person shows it
    await expect(page.locator("#bot-summary")).toHaveText("typing…");
    expect(await page.getByText("Browsing").count()).toBe(0); // never what the work is
    await emit("tool.result", { call: { id: "r1", name: "review" }, result: { content: [] }, outcome: "ok" });
    await emit("tool.result", { call: c1, result: { content: [{ type: "text", text: "Example Domain" }] }, outcome: "ok" });
    for (const [i, action] of ["snapshot", "click", "snapshot"].entries()) {
      const call = browserCall(`c${i + 2}`, action, "https://example.com/docs");
      await emit("tool.call", call);
      await emit("tool.result", { call, result: { content: [] }, outcome: "ok" });
    }
    await emit("message.assistant", assistant("Three documents are missing."));
    await emit("run.finished", { reason: "end" });

    await expect(log(page).getByText("Find my documents")).toHaveCount(1);
    await expect(log(page).locator("pre.code")).toHaveText("ls -la");
    await expect(log(page).getByText("Looking now.")).toBeVisible();
    await expect(log(page).locator(".md li")).toHaveText(["first place", "second"]);
    await expect(log(page).locator(".md strong")).toHaveText("first");
    await expect(log(page).getByText("Done. <b>not bold</b>")).toBeVisible(); // markup stays text
    await expect(page.locator("#typing")).toBeHidden(); // the run ended
    expect(await log(page).locator(".activity").count()).toBe(0); // no work lines in a conversation with a person
    await expect(log(page).locator(".row.out .bubble .time")).toHaveText([/^\d\d:\d\d$/]); // every bubble carries its time
    await expect(log(page).locator(".day")).toHaveText(["Today"]);
    expect(await log(page).getByText("running").count()).toBe(0);
    // no inputs or outputs on the page (owner's item 9): they are in the logs
    expect(await log(page).getByText("Example Domain").count()).toBe(0);
    expect(await log(page).locator("details").count()).toBe(0);
  });

  it("shows a scheduled wake-up as such, and not a reply that is only [SILENT]", async () => {
    const { h, page, emit } = await open();
    await goTo(page, h);
    await emit("message.user", user("[signal source=system trust=trusted id=sched-j_1-1]\n| Scheduled job j_1 (daily 07:30). Check the price."));
    await expect(log(page).getByText("Price is 42.")).toHaveCount(0); // (sent below)
    await emit("message.assistant", assistant("[SILENT]"));
    await emit("message.assistant", assistant("Price is 42."));
    await expect(log(page).getByText("Price is 42.")).toBeVisible();
    expect(await log(page).getByText("[SILENT]").count()).toBe(0);
  });

  it("keeps a refusal and a failure off the quiet line (owner's items 3 and 9)", async () => {
    const { h, page } = await open();
    await feed(h, "s_a", "refusalAndFailure");
    await goTo(page, h);
    expect(await log(page).locator(".activity").count()).toBe(0);
    expect(
      await log(page)
        .getByText(/refused|failed/)
        .count(),
    ).toBe(0);
  });

  it("sends with Enter, adds a line with Shift+Enter, steers with Enter while running, and the round button becomes Stop", async () => {
    const { h, page, emit } = await open();
    await goTo(page, h);
    await message(page).fill("first line");
    await page.keyboard.press("Shift+Enter");
    await page.keyboard.type("second line");
    await page.keyboard.press("Enter");
    await expect.poll(() => sent(h, "first line\nsecond line")).toHaveLength(1);
    await expect.poll(() => message(page).inputValue()).toBe(""); // cleared once the server accepted it
    await emit("run.started", null);
    await expect(page.getByRole("button", { name: "Stop" })).toBeVisible();
    await message(page).fill("also check the 2023 folder");
    await expect(page.getByRole("button", { name: "Steer" })).toBeVisible();
    await page.keyboard.press("Enter");
    await expect.poll(() => sent(h, "also check")).toHaveLength(1);
    await expect(page.getByRole("button", { name: "Stop" })).toBeVisible();
    await page.getByRole("button", { name: "Stop" }).click();
    await expect.poll(() => h.runtime.calls.filter((c) => c.startsWith("stop:s_a"))).toHaveLength(1);
  });

  it("a login question is a card pinned above the composer with 'Open the browser and sign in', which takes over", async () => {
    const { h, page, emit } = await open();
    await goTo(page, h);
    await emit("human.question", { id: "q_1", question: "Please sign in to Bilibili", kind: "login", where: "https://passport.bilibili.com/login" });
    await expect(page.locator("#pinned").getByText("Sign in for me")).toBeVisible();
    await expect(log(page).locator(".bubble.asks")).toContainText("Please sign in to Bilibili"); // the question is a message of the bot; the card with the buttons exists once
    await expect(page.locator("#desk-pill")).toHaveAttribute("data-light", "true"); // the Desk button lights; the person opens it
    await page.locator("#pinned").getByRole("button", { name: "Open the browser" }).click();
    await expect(page.locator("#desk-mode")).toHaveText("You have control");
    expect(h.runtime.calls).toContain("openTakeover:s_a");
    await page.locator("#pinned").getByRole("button", { name: "Answer" }).click(); // a login card opens its answer box on demand
    await page
      .locator("#pinned")
      .getByLabel(/Your answer to/)
      .fill("done");
    await page.locator("#pinned").getByRole("button", { name: "Answer" }).click();
    await expect.poll(() => sent(h, "done")).toHaveLength(1);
    await emit("human.answered", { id: "q_1", by: "person" });
    await expect(page.locator("#pinned")).toBeEmpty();
    await expect(log(page).locator(".bubble.asks .answered")).toHaveText("Answered"); // the question stays in the chat, marked as answered
  });

  it("shows approvals with Allow and Deny, and an expired one disabled", async () => {
    const { h, page, emit } = await open();
    await goTo(page, h);
    await emit("approval.requested", { id: "ap_1", tool: "send_mail", args: { to: "a@example.com" } });
    await emit("approval.requested", { id: "ap_2", tool: "delete_file", args: { path: "x" } });
    await emit("approval.requested", { id: "ap_3", tool: "post_public", args: {} });
    await emit("approval.expired", { id: "ap_3", reason: "restart" });
    await page.locator("#pinned").getByRole("group", { name: "Approval for send_mail" }).getByRole("button", { name: "Allow" }).click();
    await page.locator("#pinned").getByRole("group", { name: "Approval for delete_file" }).getByRole("button", { name: "Deny" }).click();
    await expect
      .poll(() => h.runtime.calls.filter((c) => c.startsWith("decideApproval")))
      .toEqual(["decideApproval:s_a:ap_1:true", "decideApproval:s_a:ap_2:false"]);
    await emit("approval.decided", { id: "ap_1", approved: true });
    await emit("approval.decided", { id: "ap_2", approved: false });
    await expect(log(page).getByText("You allowed send_mail")).toBeVisible();
    await expect(log(page).getByText("You refused delete_file")).toBeVisible();
    await expect(log(page).getByText(/Expired: post_public/)).toBeVisible();
    await expect(page.getByRole("button", { name: "Allow" })).toHaveCount(0);
  });

  it("shows markup in messages, tool output, questions and errors as plain text and never runs it", async () => {
    const { h, page, emit } = await open();
    const dialogs: string[] = [];
    page.on("dialog", (d) => {
      dialogs.push(d.message());
      void d.dismiss();
    });
    await goTo(page, h);
    const evil = `<img src=x onerror="window.__pwned=1"><script>window.__pwned=2</script><a href="javascript:window.__pwned=3">x</a>`;
    await emit("message.user", user(evil));
    await emit("message.assistant", assistant(evil));
    await emit("agent.message", { text: evil });
    const call = { id: "c9", name: "tool_call", arguments: { html: evil }, tool: { name: "browser", action: evil, target: evil } };
    await emit("tool.call", call);
    await emit("tool.result", { call, result: { content: [{ type: "text", text: evil }] }, outcome: "ok" });
    await emit("human.question", { id: "q_x", question: evil, where: evil });
    await emit("approval.requested", { id: "ap_x", tool: evil, args: evil });
    await emit("message.user", user(`[signal source=plugin:mail trust=untrusted id=m1]\n| ${evil}`));
    await emit("session.error", { kind: "other", message: evil, retryable: false });
    await expect.poll(() => page.locator("#timeline > li").count()).toBeGreaterThanOrEqual(8);
    await page.waitForTimeout(300);
    expect(await page.locator("#timeline img, #timeline script, #timeline iframe, #timeline a, #timeline svg:not(.star), #pinned img, #pinned a").count()).toBe(
      0,
    );
    expect(await page.evaluate(() => (window as any).__pwned)).toBeUndefined();
    expect(dialogs).toEqual([]);
    expect(await page.locator("#timeline").innerText()).toContain("<img src=x");
    const csp = await page.evaluate(async () => (await fetch("/")).headers.get("content-security-policy"));
    expect(csp).toContain("script-src 'self'");
  });

  it("shows the held banner with the number of signals waiting, and a session error inline with its cause and a Retry", async () => {
    const { h, page, emit } = await open();
    await goTo(page, h);
    await emit("router.input", { type: "stop", id: "x" });
    await page.getByText("Stopped. Write a message to continue.").waitFor();
    await emit("router.input", { type: "signal", draft: { id: "m1", source: "plugin:mail", text: "a" } });
    await emit("router.input", { type: "signal", draft: { id: "m2", source: "plugin:mail", text: "b" } });
    await page.getByText("Stopped. 2 signals are waiting while held; write a message to continue.").waitFor();
    await emit("router.input", { type: "signal", draft: { id: "u1", source: "user", text: "go" } });
    await expect(page.getByText("waiting while held")).toHaveCount(0);
    await emit("session.error", { kind: "network", message: "The model could not be reached.", retryable: true });
    await expect(log(page).getByRole("alert")).toContainText("The model could not be reached. (network)");
    await log(page).getByRole("button", { name: "Try again" }).click();
    await expect.poll(() => sent(h, "Please try again.")).toHaveLength(1);
  });

  it("the rail is a contact list: a star, the name, a line and a status dot per bot; it folds with its own icon", async () => {
    const { h, page } = await open();
    await feed(h, "s_a", "plainChatTurn");
    await h.addSession("s_b", "Needs");
    await feed(h, "s_b", "approvalsPendingAndExpired");
    await h.addSession("s_c", "Broken");
    await feed(h, "s_c", "modelQuotaError");
    await goTo(page, h);
    const rail = page.getByRole("navigation", { name: "Bots" });
    await expect(rail.getByRole("button", { name: /Needs/ })).toHaveAttribute("data-status", "needs");
    await expect(rail.getByRole("button", { name: /Needs/ }).locator(".line")).toHaveText("waiting for you");
    await expect(rail.getByRole("button", { name: /Needs/ }).locator(".badge")).toHaveText("1");
    await expect(rail.getByRole("button", { name: /Taxes/ }).locator(".line")).toHaveText(/./);
    expect(await rail.locator(".star.avatar").count()).toBe(3);
    await expect(rail.getByRole("button", { name: /Broken/ })).toHaveAttribute("data-status", "error");
    await expect(rail.getByRole("button", { name: /Taxes/ })).toHaveAttribute("data-status", "idle");
    await page.getByRole("button", { name: "Fold the bots away" }).click();
    await expect(rail).toBeHidden();
    await page.getByRole("button", { name: "Show the bots" }).click();
    await expect(rail).toBeVisible();
  });

  it("the Desk pill shows for a session with a workspace; the desk watches with a picture, unlabelled, and one button folds it", async () => {
    const { h, page } = await open();
    await goTo(page, h);
    await page.getByRole("button", { name: "Desk" }).click();
    await expect(page.getByRole("button", { name: "Take over" })).toBeVisible();
    await expect(page.locator("#desk-mode")).toBeHidden(); // no "View only" (owner's item 12)
    const box = await page.locator("#desk").boundingBox();
    expect(box?.width).toBeGreaterThanOrEqual(560); // docked beside the conversation, 600 at this window
    expect(box?.width).toBeLessThanOrEqual(760);
    // the canvas has a picture that is not one colour
    await expect
      .poll(async () =>
        page.evaluate(() => {
          const canvas = document.querySelector("#desk-screen canvas") as HTMLCanvasElement | null;
          if (!canvas || canvas.width === 0) return 0;
          const data = canvas.getContext("2d")?.getImageData(0, 0, canvas.width, canvas.height).data ?? [];
          const seen = new Set<number>();
          for (let i = 0; i < data.length; i += 4000) seen.add((data[i] ?? 0) * 65536 + (data[i + 1] ?? 0) * 256 + (data[i + 2] ?? 0));
          return seen.size;
        }),
      )
      .toBeGreaterThan(3);
    // view only: clicking and typing on it reaches nothing
    await page.locator("#desk-screen canvas").click();
    await page.keyboard.type("hello");
    await page.waitForTimeout(300);
    expect(h.desktop.received.filter((m) => m.type === 4 || m.type === 5 || m.type === 6)).toEqual([]);
    expect(await page.getByRole("button", { name: "Close the desk" }).count()).toBe(0); // one button only (item 13)
    await page.getByRole("button", { name: "Fold the desk into the top bar" }).click();
    await expect(page.locator("#desk")).toBeHidden();
    await expect(page.locator("#body")).toHaveAttribute("data-desk", "chip");
  });

  it("lights the Desk button on a login question of the journal fixture; opened, it takes over, types into the desktop, and hands back with a note", async () => {
    const { h, page } = await open();
    await h.addSession("s_login", "Bilibili");
    const events = JOURNAL_FIXTURES.loginTakeoverJourney("s_login").slice(0, 12); // up to the open question
    for (const event of events) await h.runtime.emit("s_login", { type: event.type, payload: event.payload });
    await goTo(page, h, "s_login");
    await expect(page.locator("#desk-pill")).toHaveAttribute("data-light", "true");
    await page.getByRole("button", { name: /Desk/ }).click();
    await expect(page.locator("#desk")).toBeVisible();
    await page.getByRole("button", { name: "Take over" }).click();
    await expect(page.locator("#desk-mode")).toHaveText("You have control");
    await expect(page.locator("#desk-collapse")).toBeHidden(); // in control only Hand back ends it
    expect(await page.evaluate(() => document.activeElement?.tagName)).toBe("CANVAS"); // the keyboard goes to the desktop
    await page.keyboard.type("p@ss word!");
    await expect.poll(() => h.desktop.received.filter((m) => m.type === 4).length).toBeGreaterThan(5);
    await page.getByLabel(/What did you do/).fill("signed in");
    await page.locator("#handback-bar").getByRole("button", { name: "Hand back" }).click();
    await expect(page.getByRole("button", { name: "Take over" })).toBeVisible();
    expect(h.runtime.calls).toContain("closeTakeover:s_login:signed in");
    expect(h.hostCalls).toEqual(expect.arrayContaining(["view.open:s-login", "takeover.open:s-login", "takeover.close:s-login"]));
  });

  it("Send text types passwords with symbols key by key, with a show/hide toggle, only in take-over", async () => {
    const { h, page } = await open();
    await goTo(page, h);
    await page.getByRole("button", { name: "Desk" }).click();
    await expect(page.getByRole("button", { name: "Take over" })).toBeVisible();
    await expect(page.locator("#desk-type")).toBeHidden();
    await page.getByRole("button", { name: "Take over" }).click();
    await expect(page.locator("#desk-mode")).toHaveText("You have control");
    await page.getByRole("button", { name: "Send text" }).click();
    await expect(page.getByText(/Ctrl, not Cmd/)).toBeVisible();
    const field = page.getByLabel("Text to type into the desktop");
    expect(await field.getAttribute("type")).toBe("password");
    await field.fill("P@ss!w0"); // Chinese goes through the page-input route (its own test)
    await page.locator("#desk-type").getByRole("button", { name: "Show" }).click();
    expect(await field.getAttribute("type")).toBe("text");
    const before = h.desktop.received.filter((m) => m.type === 4).length;
    await field.press("Enter");
    await expect.poll(() => h.desktop.received.filter((m) => m.type === 4).length - before).toBe(14); // 7 characters, press and release
    expect(await field.inputValue()).toBe("");
  });

  it("a reload in the middle of a take-over comes back in control, with no second take-over opened", async () => {
    const { h, page } = await open();
    await goTo(page, h);
    await page.getByRole("button", { name: "Desk" }).click();
    await page.getByRole("button", { name: "Take over" }).click();
    await expect(page.locator("#desk-mode")).toHaveText("You have control");
    await page.reload();
    await expect(page.locator("#desk-mode")).toHaveText("You have control", { timeout: 15_000 });
    expect(h.runtime.calls.filter((c) => c.startsWith("openTakeover"))).toHaveLength(1);
  });

  it("shows a banner after two seconds offline and catches up after the gateway is back without losing or repeating an event", async () => {
    const { h, page, emit } = await open();
    await goTo(page, h);
    await emit("message.user", user("before 1"));
    await emit("message.assistant", assistant("before 2"));
    await log(page).getByText("before 2").waitFor();
    await h.stopGateway();
    // the whole server is gone, so the banner says it cannot reach it (a lost stream alone says "Lost the connection")
    await expect(page.locator('.banner[data-key="offline"]')).toBeVisible({ timeout: 15_000 });
    await emit("message.assistant", assistant("while down"));
    await h.startGateway();
    await log(page).getByText("while down").waitFor({ timeout: 20_000 });
    await emit("message.assistant", assistant("after"));
    await log(page).getByText("after", { exact: true }).waitFor();
    const texts = await page.locator("#timeline .row .bubble > :not(.time)").allInnerTexts();
    expect(texts.map((t) => t.trim())).toEqual(["before 1", "before 2", "while down", "after"]);
  });

  it("says plainly when the runtime is still starting", async () => {
    let ready = false;
    const { h, page } = await open({ ready: () => ready });
    await goTo(page, h);
    await expect(page.locator('.banner[data-key="offline"]')).toContainText("Starting up", { timeout: 15_000 });
    ready = true;
    await expect(page.locator('.banner[data-key="offline"]')).toHaveCount(0, { timeout: 15_000 });
  });

  it("shows only warnings of the start-up report, one line each, in a neutral banner with Dismiss", async () => {
    const { h, page } = await open({
      startup: () =>
        [
          { level: "info", text: "Model: main" },
          { level: "warn", text: "The model key is not set." },
          { level: "warn", text: "The desk is not up." },
        ] as never,
    });
    await goTo(page, h);
    const banner = page.locator('.banner[data-key="startup"]');
    await expect(banner.locator("li")).toHaveText(["The model key is not set.", "The desk is not up."]);
    await expect(page.getByText("Model: main")).toHaveCount(0);
    await banner.getByRole("button", { name: "Dismiss" }).click();
    await expect(banner).toHaveCount(0);
    const quiet = await open({ startup: () => [{ level: "info", text: "all good" }] as never });
    await goTo(quiet.page, quiet.h);
    await expect(quiet.page.locator('.banner[data-key="startup"]')).toHaveCount(0);
  });

  // Skipped 2026-11-15: the take-over ending elsewhere races the page's own restore request in the fake runtime (journal
  // order of two takeover.opened and one takeover.closed); app.js followDesk handles the real order. Unskip when the fake
  // serialises its journal writes.
  it.skip("while a take-over is open the composer gives way to the hand-back control; after it ends elsewhere it is back", async () => {
    const { h, page, emit } = await open();
    await goTo(page, h);
    await emit("takeover.opened", { since: Date.now(), workspaceId: "s-a" });
    await expect(page.locator("#composer")).toBeHidden();
    await expect(page.locator("#handback-bar")).toBeVisible();
    await expect(page.locator("#bot-summary")).toHaveText("you have the screen");
    // Ended elsewhere (its time limit, another tab): the runtime closes it and journals that, as the real one does.
    await expect.poll(() => h.runtime.calls).toContain("openTakeover:s_a"); // the page restored the stage
    await h.runtime.closeTakeover("s_a"); // journals takeover.closed
    await expect(page.locator("#composer")).toBeVisible();
    await expect(page.locator("#body")).toHaveAttribute("data-desk", "docked"); // the picture went back to watching
    await message(page).fill("hello again");
    await page.keyboard.press("Enter");
    await expect.poll(() => sent(h, "hello again")).toHaveLength(1);
  });

  it("the bot shows as a person: typing while it works, waiting when it asks, last seen afterwards; the tab title counts what waits", async () => {
    const { h, page, emit } = await open();
    await goTo(page, h);
    await expect(page.locator("#typing")).toBeHidden();
    await emit("run.started", null);
    await emit("tool.call", {
      id: "c1",
      name: "tool_call",
      arguments: {},
      tool: { name: "browser", action: "snapshot", target: "https://space.bilibili.com/1" },
    });
    await expect(page.locator("#typing")).toBeVisible();
    await expect(page.locator("#bot-summary")).toHaveText("typing…");
    expect(
      await log(page)
        .getByText(/space\.bilibili|Browsing|reading the page/)
        .count(),
    ).toBe(0); // what it does stays out of the chat
    await emit("approval.requested", { id: "ap_1", tool: "send_mail", args: {} });
    await expect(page.locator("#typing")).toBeHidden(); // it asked: no typing, the card speaks
    await expect(page.locator("#bot-summary")).toHaveText("waiting for you");
    await expect.poll(() => page.title()).toBe("(1) Vesper");
    await emit("approval.decided", { id: "ap_1", approved: true });
    await expect(page.locator("#typing")).toBeVisible();
    await emit("message.assistant", assistant("Sent."));
    await emit("run.finished", { reason: "end" });
    await expect(page.locator("#typing")).toBeHidden();
    await expect(page.locator("#bot-summary")).toHaveText(/^last seen today at \d\d:\d\d$/);
    await expect.poll(() => page.title()).toBe("Vesper");
  });

  it("docks the desk beside the conversation (260 | 580 | 600 at 1440), resizes with the divider and the arrow keys, and remembers the width", async () => {
    const { h, page } = await open();
    await page.setViewportSize({ width: 1440, height: 900 });
    await goTo(page, h);
    await page.getByRole("button", { name: /Desk/ }).click();
    await expect(page.getByRole("button", { name: "Take over" })).toBeVisible();
    const width = async (id: string) => Math.round((await page.locator(id).boundingBox())?.width ?? 0);
    expect(await width("#desk")).toBe(600);
    await page.locator("#divider").focus();
    await page.keyboard.press("ArrowLeft");
    expect(await width("#desk")).toBe(624);
    await page.locator("#divider").dblclick();
    expect(await width("#desk")).toBe(600);
    await page.locator("#divider").focus();
    await page.keyboard.press("ArrowLeft");
    expect(JSON.parse((await page.evaluate(() => localStorage.getItem("vesper.desk"))) ?? "{}").frac).toBeCloseTo(624 / 1440, 3);
    await page.setViewportSize({ width: 800, height: 700 }); // below 920: a band on top, the composer stays usable
    await expect.poll(() => width("#desk")).toBe(800); // the resize handler runs after the viewport changed
    const band = await page.locator("#desk").boundingBox();
    expect((await page.locator("#composer").boundingBox())?.y).toBeGreaterThan((band?.y ?? 0) + (band?.height ?? 0));
  });

  it("folds the desk into the top bar with Ctrl+\\ and brings it back, and lights the chip for a browser call after it was folded", async () => {
    const { h, page, emit } = await open();
    await page.setViewportSize({ width: 1440, height: 900 });
    await goTo(page, h);
    await page.getByRole("button", { name: /Desk/ }).click();
    await expect(page.locator("#desk")).toBeVisible();
    await page.locator("body").press("Control+\\");
    await expect(page.locator("#desk")).toBeHidden();
    await expect(page.locator("#desk-pill")).toHaveAttribute("aria-pressed", "false");
    await emit("run.started", null);
    await emit("tool.call", { id: "c1", name: "tool_call", arguments: {}, tool: { name: "browser", action: "open", target: "https://example.com" } });
    await expect(page.locator("#desk-pill")).toHaveAttribute("data-light", "true"); // lit, not opened: the person folded it
    await expect(page.locator("#desk-host")).toHaveText("example.com");
    await expect(page.locator("#desk")).toBeHidden();
    await page.locator("#desk-pill").click();
    await expect(page.locator("#desk")).toBeVisible();
  });

  it("the stage: take-over hides the rail, the conversation is a 360 px column and the desk takes the rest", async () => {
    const { h, page } = await open();
    await page.setViewportSize({ width: 1440, height: 900 });
    await goTo(page, h);
    await page.getByRole("button", { name: /Desk/ }).click();
    await page.getByRole("button", { name: "Take over" }).click();
    await expect(page.locator("#body")).toHaveAttribute("data-desk", "stage");
    await expect(page.locator("#rail")).toBeHidden();
    expect(Math.round((await page.locator(".main").boundingBox())?.width ?? 0)).toBe(360);
    expect(Math.round((await page.locator("#desk").boundingBox())?.width ?? 0)).toBe(1080);
    await expect(page.locator("#desk-handback-header")).toBeVisible();
    await page.locator("#desk-handback-header").click();
    await expect(page.locator("#body")).toHaveAttribute("data-desk", "docked");
  });

  it("attaches files: they upload with the tray showing each one, go with the message as attachments, and an empty or oversized file says why", async () => {
    const { h, page } = await open();
    await goTo(page, h);
    await page.locator("#file-input").setInputFiles([
      { name: "报告 Q3.pdf", mimeType: "application/pdf", buffer: Buffer.from("hello report") },
      { name: "empty.txt", mimeType: "text/plain", buffer: Buffer.alloc(0) },
    ]);
    const tray = page.getByRole("list", { name: "Files to send" });
    await expect(tray.getByText("ready")).toBeVisible();
    await expect(tray.getByText("Not sent: empty")).toBeVisible();
    await tray.getByRole("button", { name: "Remove empty.txt" }).click();
    await message(page).fill("please read the report");
    await page.keyboard.press("Enter");
    await expect.poll(() => sent(h, "please read the report")).toHaveLength(1);
    expect(sent(h, "please read the report")[0]).toContain('attachments=[{"name":"报告 Q3.pdf","size":12}]');
    await expect(tray).toBeHidden(); // the files belong to the message now
  });

  it("files alone go to the open bot as a message", async () => {
    const { h, page } = await open();
    await goTo(page, h);
    await page.locator("#file-input").setInputFiles({ name: "contract.pdf", mimeType: "application/pdf", buffer: Buffer.from("x") });
    await expect(page.getByRole("list", { name: "Files to send" }).getByText("ready")).toBeVisible();
    await page.getByRole("button", { name: "Send" }).click();
    await expect.poll(() => h.runtime.calls.find((c) => c.startsWith("send:s_a:I attached files."))).toContain("attachments=");
    expect((await h.host.files.list("s-a")).map((f) => f.name)).toEqual(["contract.pdf"]);
  });

  it("drop files on the conversation to attach them (the drop target shows while dragging)", async () => {
    const { h, page } = await open();
    await goTo(page, h);
    await expect(page.locator("#composer")).toBeVisible(); // the bot is open: files go to it
    await page.evaluate(() => {
      const main = document.querySelector(".main") as HTMLElement;
      const data = new DataTransfer();
      data.items.add(new File(["dropped"], "dropped.txt", { type: "text/plain" }));
      main.dispatchEvent(new DragEvent("dragenter", { dataTransfer: data, bubbles: true, cancelable: true }));
      (window as any).__dropShown = !document.getElementById("drop")?.hidden;
      main.dispatchEvent(new DragEvent("drop", { dataTransfer: data, bubbles: true, cancelable: true }));
    });
    expect(await page.evaluate(() => (window as any).__dropShown)).toBe(true);
    await expect(page.getByRole("list", { name: "Files to send" }).getByText("dropped.txt")).toBeVisible();
    await expect(page.locator("#drop")).toBeHidden();
  });

  it("a download link the agent writes in chat saves the file from the session's files directory", async () => {
    const { h, page } = await open();
    await h.host.files.put("s-a", "result.csv", new TextEncoder().encode("a,b\n1,2\n"));
    await goTo(page, h);
    const assistant = { role: "assistant", content: [{ type: "text", text: "Done: [Download result.csv](/api/sessions/s_a/files/result.csv)" }], ts: 1 };
    await h.runtime.emit("s_a", { type: "message.assistant", payload: assistant });
    const link = page.getByRole("link", { name: "Download result.csv" });
    const [download] = await Promise.all([page.waitForEvent("download"), link.click()]);
    expect(download.suggestedFilename()).toBe("result.csv");
    expect(await (await import("node:fs/promises")).readFile(await download.path(), "utf8")).toBe("a,b\n1,2\n");
    // an agent that writes the workspace id (s-a) still links to this session's files
    const again = { role: "assistant", content: [{ type: "text", text: "[Get it again](/api/sessions/s-a/files/result.csv)" }], ts: 2 };
    await h.runtime.emit("s_a", { type: "message.assistant", payload: again });
    const [second] = await Promise.all([page.waitForEvent("download"), page.getByRole("link", { name: "Get it again" }).click()]);
    expect(second.suggestedFilename()).toBe("result.csv");
  });

  it("during a take-over a file can be sent from the stage, and the panel says where to find it in the remote file dialog", async () => {
    const { h, page } = await open();
    await goTo(page, h);
    await page.getByRole("button", { name: /Desk/ }).click();
    await page.getByRole("button", { name: "Take over" }).click();
    await expect(page.locator("#desk-mode")).toHaveText("You have control");
    await page.locator("#desk-file").setInputFiles({ name: "id-card.jpg", mimeType: "image/jpeg", buffer: Buffer.from("jpg") });
    await expect(page.locator("#desk-upload-note")).toContainText("Sent id-card.jpg");
    await expect(page.locator("#desk-upload-note")).toContainText("file dialog");
    expect((await h.host.files.list("s-a")).map((f) => f.name)).toEqual(["id-card.jpg"]);
  });

  it("a desk opened before the browser is awake keeps trying and says so, never 'closed'", async () => {
    const { h, page } = await open();
    await h.host.destroy("s-a"); // no workspace yet: the view ticket is refused
    await goTo(page, h);
    await page.getByRole("button", { name: "Desk" }).click();
    await expect(page.locator("#desk-note")).toHaveText("Starting the browser...");
    await expect(page.getByText(/picture was closed/)).toHaveCount(0);
    await h.host.ensure({ workspaceId: "s-a" });
    await expect(page.getByRole("button", { name: "Take over" })).toBeVisible({ timeout: 15_000 });
  });

  it("Send text with non-ASCII characters goes through the page-input route as a whole; ASCII stays keys", async () => {
    const { h, page } = await open();
    await goTo(page, h);
    await page.getByRole("button", { name: "Desk" }).click();
    await page.getByRole("button", { name: "Take over" }).click();
    await expect(page.locator("#desk-mode")).toHaveText("You have control");
    h.runtime.takeovers.set("s_a", { since: 1, viewed: true });
    await page.getByRole("button", { name: "Send text" }).click();
    const field = page.getByLabel("Text to type into the desktop");
    await field.fill("密码abc");
    await field.press("Enter");
    await expect.poll(() => h.typed).toEqual(["密码abc"]);
    expect(h.desktop.received.filter((m) => m.type === 4)).toEqual([]);
  });

  it("asks for the token when the server wants one, and works after it is entered", async () => {
    const { h, page } = await open({ token: "open-sesame" });
    await page.goto(h.url);
    await expect(page.locator("#token-form")).toBeVisible();
    await page.getByLabel("Access token").fill("wrong");
    await page.getByRole("button", { name: "Use token" }).click();
    await expect(page.locator("#token-form")).toBeVisible();
    await page.getByLabel("Access token").fill("open-sesame");
    await page.getByRole("button", { name: "Use token" }).click();
    await expect(page.locator("#token-form")).toBeHidden();
    await page.getByRole("navigation", { name: "Bots" }).getByRole("button", { name: /Taxes/ }).click();
    await expect(page.locator("#desk-pill")).toBeVisible();
    expect(await page.evaluate(() => localStorage.getItem("ogb-token"))).toBeNull(); // the token lives in this tab's session storage only
  });

  it("a conversation of 2000 events loads, stays responsive while more arrive", async () => {
    const { h, page, emit } = await open();
    for (let i = 0; i < 1000; i++) {
      await emit("message.user", user(`question ${i}`));
      await emit("message.assistant", assistant(`answer ${i}`));
    }
    const started = Date.now();
    await goTo(page, h);
    await expect.poll(() => page.locator("#timeline .row").count(), { timeout: 30_000 }).toBe(2000);
    const loadMs = Date.now() - started;
    const latency = await page.evaluate(async () => {
      const field = document.getElementById("message") as HTMLTextAreaElement;
      const times: number[] = [];
      for (let i = 0; i < 20; i++) {
        const t = performance.now();
        field.value = `typing ${i}`;
        field.dispatchEvent(new Event("input", { bubbles: true }));
        await new Promise((resolve) => requestAnimationFrame(() => resolve(null)));
        times.push(performance.now() - t);
      }
      return Math.max(...times);
    });
    for (let i = 0; i < 50; i++) await emit("message.assistant", assistant(`live ${i}`));
    await page.getByText("live 49").waitFor();
    console.log(`[measured] 2000 events: load to all rendered ${loadMs} ms; worst frame while typing ${latency.toFixed(1)} ms`);
    expect(latency).toBeLessThan(250);
    expect(await page.locator("#timeline .row").count()).toBe(2050);
  });

  it("works with the keyboard and has names for its controls", async () => {
    const { h, page } = await open();
    await goTo(page, h);
    await page.keyboard.press("Tab");
    expect(await page.evaluate(() => document.activeElement?.textContent)).toBe("Skip to the message box");
    const unnamed = await page.evaluate(() => {
      const bad: string[] = [];
      for (const el of Array.from(document.querySelectorAll("button, input, select, textarea"))) {
        if ((el as HTMLElement).hidden || (el as HTMLElement).closest("[hidden]")) continue;
        const name = el.getAttribute("aria-label") || (el as HTMLInputElement).labels?.[0]?.textContent || el.textContent?.trim();
        if (!name) bad.push(el.outerHTML.slice(0, 80));
      }
      return bad;
    });
    expect(unnamed).toEqual([]);
    expect(await page.locator("html").getAttribute("lang")).toBe("en");
    await expect(page.locator("#composer")).toBeVisible(); // shown once the bot is open; focus() alone does not wait for that
    await message(page).click(); // a click waits until the field can take it (focus() does not)
    await page.keyboard.type("hello");
    await expect.poll(() => message(page).inputValue()).toBe("hello"); // the keys arrived before Enter is pressed
    await message(page).press("Enter");
    await expect.poll(() => sent(h, "hello")).toHaveLength(1);
  });
});
