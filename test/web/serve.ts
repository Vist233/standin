// Run by hand to look at the page: OGB_MANUAL=1 PORT=8099 npx vitest run --config vitest.web.config.ts test/web/manual.e2e.ts
// (the fake journal imports vitest, so it only loads inside vitest)
import { JOURNAL_FIXTURES } from "@standin/contracts/testing";
import { startHarness } from "./harness.ts";

export async function serveDemo(port: number) {
  const harness = await startHarness({ port });
  const sessions = [
    ["s_login", "Read my play counts on Bilibili", "loginTakeoverJourney"],
    ["s_fail", "Clean up, then read missing.txt", "refusalAndFailure"],
    ["s_quota", "Summarise the news", "modelQuotaError"],
    ["s_approve", "Send the report to Sam", "approvalsPendingAndExpired"],
    ["s_chat", "What is 2 + 2?", "plainChatTurn"],
  ] as const;
  for (const [id, title, fixture] of sessions) {
    await harness.addSession(id, title);
    for (const event of JOURNAL_FIXTURES[fixture](id)) await harness.runtime.emit(id, { type: event.type, payload: event.payload });
  }
  await harness.addSession("s_empty", "Empty");
  // A session in the middle of a run, with the clock of the real now, to look at the Now line and the live work log.
  await harness.addSession("s_live", "Find the cheapest flight to Lisbon");
  const live = (type: string, payload: unknown) => harness.runtime.emit("s_live", { type, payload: payload as never });
  await live("run.started", null);
  await live("message.user", { role: "user", content: [{ type: "text", text: "Find the cheapest flight to Lisbon next month." }] });
  await live("message.assistant", {
    role: "assistant",
    content: [{ type: "text", text: "I'll check a few sites.\n\n```\nskyscanner, kayak, google flights\n```" }],
  });
  const open = { id: "c1", name: "tool_call", arguments: {}, tool: { name: "browser", action: "open", target: "https://www.kayak.com/flights/LIS" } };
  await live("tool.call", open);
  await live("tool.result", { call: open, result: { content: [] }, outcome: "ok" });
  await live("tool.call", {
    id: "c2",
    name: "tool_call",
    arguments: {},
    tool: { name: "browser", action: "snapshot", target: "https://www.kayak.com/flights/LIS" },
  });
  console.log(`Page: ${harness.url}/#/s/s_login`);
  return harness;
}
