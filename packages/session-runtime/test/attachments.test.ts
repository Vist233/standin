import { join } from "node:path";
import { JOURNAL_FIXTURES } from "@standin/contracts/testing";
import { afterEach, describe, expect, it } from "vitest";
import { attachmentRefs, withAttachmentLine } from "../src/attachments.ts";
import { waitingFrom } from "../src/waiting.ts";
import { createRig, type Rig } from "../src/testing/index.ts";
import { userTexts } from "./helpers.ts";

const rigs: Rig[] = [];
function rig(options: Parameters<typeof createRig>[0] = {}) {
  const made = createRig(options);
  rigs.push(made);
  return made;
}
afterEach(async () => {
  for (const r of rigs.splice(0)) await r.cleanup();
});

describe("attachments", () => {
  it("gives each file the path the agent's tools see, and refuses a name that is not a plain file name or a bad size", () => {
    expect(attachmentRefs("/files", [{ name: "a b.pdf", size: 5 }])).toEqual([{ name: "a b.pdf", size: 5, path: join("/files", "a b.pdf") }]);
    expect(attachmentRefs("/files", undefined)).toEqual([]);
    for (const name of ["../x", "a/b", ".hidden", ""]) expect(() => attachmentRefs("/files", [{ name, size: 1 }])).toThrow();
    expect(() => attachmentRefs("/files", [{ name: "a", size: -1 }])).toThrow();
    expect(() => attachmentRefs("/files", [{ name: "a", size: 1.5 }])).toThrow();
  });

  it("adds one line to the person's words, or is the whole text when there are none", () => {
    const a = { name: "report.pdf", size: 12_288, path: "/f/report.pdf" };
    const b = { name: "b.png", size: 900, path: "/f/b.png" };
    expect(withAttachmentLine("Look", [])).toBe("Look");
    expect(withAttachmentLine("Look", [a])).toBe("Look\n\nThe person attached 1 file: report.pdf (12.0 KB) at /f/report.pdf");
    expect(withAttachmentLine("", [a, b])).toBe("The person attached 2 files: report.pdf (12.0 KB) at /f/report.pdf; b.png (900 B) at /f/b.png");
  });

  it("a message with a file: the agent reads the line with the path, and the journal's message.user carries the attachments", async () => {
    const { runtime, faux, root } = rig();
    const { id } = await runtime.createSession();
    await runtime.send(id, "Summarise this", undefined, [{ name: "report.pdf", size: 2048 }]);
    await runtime.whenIdle(id);
    const path = join(root, "workspaces", id, "files", "report.pdf");
    expect(userTexts(faux.requests[0] as never).join("\n")).toContain(`The person attached 1 file: report.pdf (2.0 KB) at ${path}`);
    const message = (await runtime.read(id)).find((e) => e.type === "message.user" && JSON.stringify(e.payload).includes("Summarise this"));
    expect(message?.payload).toMatchObject({ attachments: [{ name: "report.pdf", size: 2048, path }] });
  });

  it("a message without files has no attachments field; a bad name is refused before anything is written", async () => {
    const { runtime } = rig();
    const { id } = await runtime.createSession();
    await runtime.send(id, "plain");
    await runtime.whenIdle(id);
    const events = await runtime.read(id);
    expect(events.find((e) => e.type === "message.user")?.payload).not.toHaveProperty("attachments");
    const before = events.length;
    await expect(runtime.send(id, "x", undefined, [{ name: "../etc/passwd", size: 1 }])).rejects.toThrow();
    expect((await runtime.read(id)).length).toBe(before);
  });

  it("a message with a file written during a take-over is queued with it, and arrives with it after the hand-back", async () => {
    const { runtime, faux, root } = rig();
    const { id } = await runtime.createSession();
    await runtime.openTakeover(id);
    await runtime.send(id, "use this one", "m_f", [{ name: "data.csv", size: 10 }]);
    const queued = waitingFrom(await runtime.read(id)).queued;
    expect(queued[0]?.attachments).toEqual([{ name: "data.csv", size: 10, path: join(root, "workspaces", id, "files", "data.csv") }]);
    expect(faux.requests).toHaveLength(0);
    await runtime.closeTakeover(id);
    await runtime.whenIdle(id);
    const delivered = (await runtime.read(id)).find((e) => e.type === "message.user" && JSON.stringify(e.payload).includes("use this one"));
    expect(delivered?.payload).toMatchObject({ attachments: [{ name: "data.csv" }] });
  });

  it("the shared fixture has the shape the runtime writes", () => {
    const message = JOURNAL_FIXTURES.messageWithAttachments().find((e) => e.type === "message.user");
    expect(message?.payload).toMatchObject({ attachments: [{ name: "report.pdf", size: 12_288, path: expect.stringContaining("report.pdf") }] });
  });
});
