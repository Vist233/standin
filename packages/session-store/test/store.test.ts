import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { isOgbError } from "@standin/contracts";
import { afterEach, describe, expect, it } from "vitest";
import { createFileSessionStore } from "../src/index.ts";
import { createTempSessionStore } from "../src/testing/index.ts";

const cleanups: (() => void)[] = [];
function fresh() {
  const made = createTempSessionStore();
  cleanups.push(made.cleanup);
  return made;
}
afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup();
});
const kind = (k: string) => (e: unknown) => isOgbError(e, k as never);

describe("session store", () => {
  it("creates a session with an id, active status and the profile it was given", async () => {
    const { store } = fresh();
    const record = await store.create({ title: "Taxes", profile: { plugins: ["a"] }, model: "main" });
    expect(record).toEqual({ id: "s_test1", title: "Taxes", status: "active", createdAt: 1000, profile: { plugins: ["a"] }, model: "main" });
    expect(await store.get("s_test1")).toEqual(record);
  });

  it("leaves model out when there is none, and accepts a chosen id once", async () => {
    const { store } = fresh();
    const record = await store.create({ id: "mine", title: "t", profile: null });
    expect("model" in record).toBe(false);
    await expect(store.create({ id: "mine", title: "t", profile: null })).rejects.toSatisfy(kind("conflict"));
  });

  it("gives every session paths inside its own directory, and refuses ids that could escape", async () => {
    const { store, root } = fresh();
    const paths = store.paths("abc");
    expect(paths.directory).toBe(join(root, "sessions", "abc"));
    for (const path of [paths.agentFile, paths.journalDirectory, paths.dataDirectory]) expect(path.startsWith(paths.directory)).toBe(true);
    for (const bad of ["../x", "a/b", "", "a b", "x".repeat(129)]) {
      expect(() => store.paths(bad)).toThrow();
      await expect(store.get(bad)).rejects.toSatisfy(kind("invalid_input"));
      await expect(store.create({ id: bad, title: "t", profile: null })).rejects.toSatisfy(kind("invalid_input"));
    }
  });

  it("names a shared directory per owner under the root, outside every session, and refuses names that could escape", async () => {
    const { store, root } = fresh();
    expect(store.sharedDirectory("handoff")).toBe(join(root, "shared", "handoff"));
    for (const bad of ["../x", "a/b", "", "Upper"]) expect(() => store.sharedDirectory(bad)).toThrow();
    const { id } = await store.create({ title: "t", profile: null });
    await store.delete(id);
    expect(store.sharedDirectory("handoff")).toBe(join(root, "shared", "handoff")); // unaffected by deleting a session
  });

  it("lists sessions by creation time and reports damaged ones without failing", async () => {
    const { store, root } = fresh();
    expect(await store.list()).toEqual({ sessions: [], damaged: [] });
    await store.create({ title: "one", profile: null });
    await store.create({ title: "two", profile: null });
    mkdirSync(join(root, "sessions", "broken"));
    writeFileSync(join(root, "sessions", "broken", "session.json"), "{nope");
    mkdirSync(join(root, "sessions", "wrongshape"));
    writeFileSync(join(root, "sessions", "wrongshape", "session.json"), '{"id":"wrongshape"}');
    mkdirSync(join(root, "sessions", "norecord"));
    writeFileSync(join(root, "sessions", "not a session.txt"), "ignored");
    const { sessions, damaged } = await store.list();
    expect(sessions.map((s) => s.title)).toEqual(["one", "two"]);
    expect(damaged).toEqual(["broken", "norecord", "wrongshape"]);
    await expect(store.get("broken")).rejects.toSatisfy(kind("corrupt"));
    await expect(store.get("wrongshape")).rejects.toSatisfy(kind("corrupt"));
    await expect(store.get("nothere")).rejects.toSatisfy(kind("not_found"));
  });

  it("keeps a bot's star, summary and schedules", async () => {
    const { store } = fresh();
    const created = await store.create({ title: "Scout", star: "dawn", profile: {} });
    expect(created.star).toBe("dawn");
    const updated = await store.update(created.id, { summary: "watching flight prices", schedules: [{ id: "j1", when: "every 2h" }] });
    expect(await store.get(created.id)).toEqual(updated);
    expect(updated).toMatchObject({ star: "dawn", summary: "watching flight prices", schedules: [{ id: "j1" }] });
  });

  it("updates title and status and nothing else, and the record is whole JSON afterwards", async () => {
    const { store, root } = fresh();
    const created = await store.create({ title: "old", profile: { p: 1 } });
    const updated = await store.update(created.id, { title: "new", status: "archived" });
    expect(updated).toEqual({ ...created, title: "new", status: "archived" });
    expect(JSON.parse(readFileSync(join(root, "sessions", created.id, "session.json"), "utf8"))).toEqual(updated);
    expect((await store.update(created.id, {})).title).toBe("new");
    await expect(store.update("ghost", { title: "x" })).rejects.toSatisfy(kind("not_found"));
  });

  it("deletes the whole directory, also what other modules put in it, and deleting twice is harmless", async () => {
    const { store } = fresh();
    const { id } = await store.create({ title: "t", profile: null });
    const paths = store.paths(id);
    mkdirSync(paths.journalDirectory, { recursive: true });
    writeFileSync(join(paths.journalDirectory, "x.jsonl"), "{}\n");
    writeFileSync(paths.agentFile, "{}\n");
    await store.delete(id);
    await store.delete(id);
    expect(existsSync(paths.directory)).toBe(false);
    expect((await store.list()).sessions).toEqual([]);
  });

  it("reports an unwritable root as unavailable and leaves no half-made session", async () => {
    const { root } = fresh();
    mkdirSync(join(root, "ro"));
    chmodSync(join(root, "ro"), 0o500);
    const store = createFileSessionStore({ root: join(root, "ro") });
    await expect(store.create({ title: "t", profile: null })).rejects.toSatisfy(kind("unavailable"));
    chmodSync(join(root, "ro"), 0o700);
    expect((await store.list()).sessions).toEqual([]);
  });

  it("makes ids that pass its own check when none is given", async () => {
    const root = fresh().root;
    const store = createFileSessionStore({ root });
    const a = await store.create({ title: "a", profile: null });
    const b = await store.create({ title: "b", profile: null });
    expect(a.id).toMatch(/^s_[0-9a-f]{12}$/);
    expect(a.id).not.toBe(b.id);
  });
});

describe("session store: failures of the disk", () => {
  it("reports an unreadable record as unavailable and an unlistable root as unavailable", async () => {
    const { store, root } = fresh();
    const { id } = await store.create({ title: "t", profile: null });
    chmodSync(join(root, "sessions", id, "session.json"), 0o000);
    await expect(store.get(id)).rejects.toSatisfy(kind("unavailable"));
    chmodSync(join(root, "sessions", id, "session.json"), 0o600);
    chmodSync(join(root, "sessions"), 0o000);
    await expect(store.list()).rejects.toSatisfy(kind("unavailable"));
    chmodSync(join(root, "sessions"), 0o700);
  });

  it("does not change the record when an update cannot be written", async () => {
    const { store, root } = fresh();
    const { id } = await store.create({ title: "before", profile: null });
    chmodSync(join(root, "sessions", id), 0o500);
    await expect(store.update(id, { title: "after" })).rejects.toSatisfy(kind("unavailable"));
    chmodSync(join(root, "sessions", id), 0o700);
    expect((await store.get(id)).title).toBe("before");
  });
});
