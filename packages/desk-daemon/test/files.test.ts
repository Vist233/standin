import { mkdirSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { MAX_FILE_BYTES } from "@standin/contracts";
import { WorkspaceFiles } from "../src/files.ts";
import { tempRoot } from "./helpers.ts";

let root: ReturnType<typeof tempRoot>;
let dir: string;
let lines: string[];
const log = {
  info: (m: string, f?: object) => void lines.push(m + JSON.stringify(f ?? {})),
  warn: (m: string, f?: object) => void lines.push(m + JSON.stringify(f ?? {})),
  error: (m: string, f?: object) => void lines.push(m + JSON.stringify(f ?? {})),
};
beforeEach(() => {
  root = tempRoot();
  dir = join(root.dir, "files");
  lines = [];
});
afterEach(() => root.remove());
const bytes = (text: string) => new TextEncoder().encode(text);

describe("WorkspaceFiles", () => {
  it("creates the directory on the first put and stores the bytes unchanged", async () => {
    const files = new WorkspaceFiles(dir, log);
    const entry = await files.put("note.txt", bytes("hello"));
    expect(entry).toMatchObject({ name: "note.txt", size: 5, path: join(dir, "note.txt") });
    expect((await files.list())[0]?.path).toBe(join(dir, "note.txt"));
    expect(readFileSync(join(dir, "note.txt"), "utf8")).toBe("hello");
    expect(Array.from(await files.get("note.txt"))).toEqual(Array.from(bytes("hello")));
  });

  it("never overwrites: a taken name, also one made by the agent, gets a number; concurrent puts get different names", async () => {
    mkdirSync(dir);
    writeFileSync(join(dir, "report.pdf"), "agent's");
    const files = new WorkspaceFiles(dir, log);
    const stored = await Promise.all([1, 2, 3, 4].map((i) => files.put("report.pdf", bytes(`v${i}`))));
    expect(new Set(stored.map((e) => e.name)).size).toBe(4);
    expect(stored.map((e) => e.name)).not.toContain("report.pdf");
    expect(readFileSync(join(dir, "report.pdf"), "utf8")).toBe("agent's");
  });

  it("cleans names, and refuses what is left empty", async () => {
    const files = new WorkspaceFiles(dir, log);
    expect((await files.put("../../x/y.txt", bytes("a"))).name).toBe("y.txt");
    expect((await files.put(".bashrc", bytes("a"))).name).toBe("bashrc");
    await expect(files.put("..", bytes("a"))).rejects.toMatchObject({ kind: "invalid_input" });
  });

  it("refuses a file over the limit and stores nothing", async () => {
    const files = new WorkspaceFiles(dir, log);
    await expect(files.put("big", new Uint8Array(MAX_FILE_BYTES + 1))).rejects.toMatchObject({ kind: "invalid_input" });
    expect(await files.list()).toEqual([]);
  });

  it("lists regular files only, newest first: no symlinks, directories, dot-files or half-written uploads", async () => {
    mkdirSync(join(dir, "sub"), { recursive: true });
    writeFileSync(join(dir, ".secret"), "x");
    writeFileSync(join(dir, ".upload-abc"), "half");
    writeFileSync(join(root.dir, "outside.txt"), "outside");
    symlinkSync(join(root.dir, "outside.txt"), join(dir, "link.txt"));
    const files = new WorkspaceFiles(dir, log);
    await files.put("a.txt", bytes("a"));
    expect((await files.list()).map((e) => e.name)).toEqual(["a.txt"]);
    expect(await new WorkspaceFiles(join(root.dir, "nothing"), log).list()).toEqual([]);
  });

  it("get refuses a symlink (also to a file outside), a directory and a hidden name, and says not_found for a missing file", async () => {
    mkdirSync(join(dir, "sub"), { recursive: true });
    writeFileSync(join(root.dir, "outside.txt"), "outside");
    symlinkSync(join(root.dir, "outside.txt"), join(dir, "link.txt"));
    writeFileSync(join(dir, ".secret"), "x");
    const files = new WorkspaceFiles(dir, log);
    await expect(files.get("link.txt")).rejects.toMatchObject({ kind: "denied" });
    await expect(files.get("sub")).rejects.toMatchObject({ kind: "denied" });
    await expect(files.get(".secret")).rejects.toMatchObject({ kind: "not_found" });
    await expect(files.get("../outside.txt")).rejects.toMatchObject({ kind: "not_found" }); // cleaned to "outside.txt", which is not in the directory
    await expect(files.get("missing.txt")).rejects.toMatchObject({ kind: "not_found" });
  });

  it("refuses to put into a directory that has been replaced by a link", async () => {
    mkdirSync(join(root.dir, "elsewhere"));
    symlinkSync(join(root.dir, "elsewhere"), dir);
    await expect(new WorkspaceFiles(dir, log).put("a.txt", bytes("a"))).rejects.toMatchObject({ kind: "unavailable" });
  });

  it("refuses to read a file larger than the transfer limit", async () => {
    mkdirSync(dir);
    writeFileSync(join(dir, "huge.bin"), Buffer.alloc(MAX_FILE_BYTES + 1));
    await expect(new WorkspaceFiles(dir, log).get("huge.bin")).rejects.toMatchObject({ kind: "denied" });
  });

  it("logs names and sizes, never content", async () => {
    const files = new WorkspaceFiles(dir, log);
    await files.put("secret-plan.txt", bytes("TOP-SECRET-CONTENT"));
    await files.get("secret-plan.txt");
    const logged = lines.join("\n");
    expect(logged).toContain("secret-plan.txt");
    expect(logged).toContain('"size":18');
    expect(logged).not.toContain("TOP-SECRET-CONTENT");
  });
});
