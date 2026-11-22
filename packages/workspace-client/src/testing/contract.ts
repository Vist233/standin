import { DEFAULT_SCREEN, isOgbError, MAX_FILE_BYTES, MAX_INSERT_TEXT_CHARS, type WorkspaceHost } from "@standin/contracts";
import { describe, expect, it } from "vitest";

export interface HostHarness {
  host: WorkspaceHost;
  /** Moves the clock the host uses for ticket expiry forward (a host on the real clock may wait instead). */
  advance(ms: number): void | Promise<void>;
  /** Puts the workspace in the stopped state, as a daemon restart does (a real daemon is restarted; the host keeps working through the same client). */
  stop(workspaceId: string): void | Promise<void>;
  cleanup(): Promise<void>;
}

const kind = (k: string) => (e: unknown) => isOgbError(e, k as never);

/** The rules of `WorkspaceHost` (contracts/workspace-host.ts) as tests; run against the fake and against the client talking to a server over a socket. */
export function workspaceHostContract(name: string, create: () => Promise<HostHarness>): void {
  describe(`workspace host contract: ${name}`, () => {
    async function withHost(body: (h: HostHarness) => Promise<void>) {
      const harness = await create();
      try {
        await body(harness);
      } finally {
        await harness.cleanup();
      }
    }

    it("ensure fills the defaults and returns where the workspace lives; a repeat is the same answer", async () => {
      await withHost(async ({ host }) => {
        const first = await host.ensure({ workspaceId: "ws-1" });
        expect(first.spec).toEqual({ workspaceId: "ws-1", screen: DEFAULT_SCREEN });
        expect(first.display).toMatch(/^:\d+$/);
        expect(first.cdpUrl).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
        expect(first.filesDir).toContain("ws-1");
        expect(await host.ensure({ workspaceId: "ws-1" })).toEqual(first);
        expect(await host.ensure({ workspaceId: "ws-1", screen: DEFAULT_SCREEN })).toEqual(first);
      });
    });

    it("a different spec for an existing workspace is a conflict", async () => {
      await withHost(async ({ host }) => {
        await host.ensure({ workspaceId: "ws-1" });
        await expect(host.ensure({ workspaceId: "ws-1", screen: { width: 800, height: 600 } })).rejects.toSatisfy(kind("conflict"));
      });
    });

    it("refuses bad specs with invalid_input", async () => {
      await withHost(async ({ host }) => {
        await expect(host.ensure({ workspaceId: "Bad Id" })).rejects.toSatisfy(kind("invalid_input"));
        await expect(host.ensure({ workspaceId: "ok", screen: { width: 1, height: 1 } })).rejects.toSatisfy(kind("invalid_input"));
        await expect(host.ensure({ workspaceId: "ok", extra: 1 } as never)).rejects.toSatisfy(kind("invalid_input"));
        await expect(host.health("../x")).rejects.toSatisfy(kind("invalid_input"));
        await expect(host.destroy("")).rejects.toSatisfy(kind("invalid_input"));
        await expect(host.takeover.open("x/y")).rejects.toSatisfy(kind("invalid_input"));
        await expect(host.view.open("A B")).rejects.toSatisfy(kind("invalid_input"));
        await expect(host.input.insertText("x/y", "hi")).rejects.toSatisfy(kind("invalid_input"));
      });
    });

    it("concurrent ensures of one workspace give one answer", async () => {
      await withHost(async ({ host }) => {
        const results = await Promise.all([1, 2, 3, 4, 5].map(() => host.ensure({ workspaceId: "ws-1" })));
        for (const result of results) expect(result).toEqual(results[0]);
        expect((await host.health("ws-1")).state).toBe("running");
      });
    });

    it("two workspaces get different displays, browser ports, profiles and files", async () => {
      await withHost(async ({ host }) => {
        const [a, b] = await Promise.all([host.ensure({ workspaceId: "a" }), host.ensure({ workspaceId: "b" })]);
        expect(a.display).not.toBe(b.display);
        expect(a.cdpUrl).not.toBe(b.cdpUrl);
        expect(a.profileDir).not.toBe(b.profileDir);
        expect(a.appDataDir).toBe(b.appDataDir); // desktop programs share one set of settings and sign-ins
        expect(a.filesDir).not.toBe(b.filesDir);
      });
    });

    it("a stopped workspace keeps its numbers and is woken by ensure, take-over and view, and by nothing else", async () => {
      await withHost(async ({ host, stop }) => {
        const before = await host.ensure({ workspaceId: "ws-1" });
        for (const wake of [() => host.ensure({ workspaceId: "ws-1" }), () => host.takeover.open("ws-1"), () => host.view.open("ws-1")]) {
          await stop("ws-1");
          expect((await host.health("ws-1")).state).toBe("stopped");
          await wake();
          expect((await host.health("ws-1")).state).toBe("running");
        }
        expect(await host.ensure({ workspaceId: "ws-1" })).toEqual(before);
      });
    });

    it("health reports absent, running and stopped, and never wakes anything", async () => {
      await withHost(async ({ host, stop }) => {
        expect(await host.health("ws-1")).toEqual({ workspaceId: "ws-1", state: "absent" });
        await host.ensure({ workspaceId: "ws-1" });
        const running = await host.health("ws-1");
        expect(running.state).toBe("running");
        expect(running.processes?.display.state).toBe("running");
        expect(running.processes?.windowManager.state).toBe("running");
        expect(running.processes?.browser.state).toBe("running");
        await stop("ws-1");
        expect(await host.health("ws-1")).toEqual({ workspaceId: "ws-1", state: "stopped" });
        expect(await host.health("ws-1")).toEqual({ workspaceId: "ws-1", state: "stopped" }); // still stopped: health did not wake it
        await host.ensure({ workspaceId: "ws-1" });
        expect((await host.health("ws-1")).state).toBe("running"); // ensure did
      });
    });

    it("destroy removes what is, and a repeat says nothing was there", async () => {
      await withHost(async ({ host }) => {
        await host.ensure({ workspaceId: "ws-1" });
        expect(await host.destroy("ws-1")).toEqual({ existed: true });
        expect(await host.destroy("ws-1")).toEqual({ existed: false });
        expect((await host.health("ws-1")).state).toBe("absent");
        await host.ensure({ workspaceId: "ws-1", screen: { width: 800, height: 600 } }); // a new spec is fine once it is gone
      });
    });

    it("take-over tickets are reused while valid and replaced after they expire; close says whether one was open", async () => {
      await withHost(async ({ host, advance }) => {
        await host.ensure({ workspaceId: "ws-1" });
        const first = await host.takeover.open("ws-1");
        expect(first).toMatchObject({ workspaceId: "ws-1", host: "127.0.0.1" });
        expect(first.token.length).toBeGreaterThan(8);
        expect(await host.takeover.open("ws-1")).toEqual(first);
        expect(await host.takeover.close("ws-1")).toEqual({ wasOpen: true });
        expect(await host.takeover.close("ws-1")).toEqual({ wasOpen: false });
        const second = await host.takeover.open("ws-1");
        await advance(10 * 60_000);
        const third = await host.takeover.open("ws-1");
        expect(third.token).not.toBe(second.token);
        expect(third.expiresAt).toBeGreaterThan(second.expiresAt);
      });
    });

    it("view tickets have mode view, their own token, and closing take-over leaves the view ticket", async () => {
      await withHost(async ({ host }) => {
        await host.ensure({ workspaceId: "ws-1" });
        const view = await host.view.open("ws-1");
        const control = await host.takeover.open("ws-1");
        expect(view).toMatchObject({ workspaceId: "ws-1", mode: "view", host: "127.0.0.1" });
        expect(control.mode).toBe("control");
        expect(view.token).not.toBe(control.token);
        expect(await host.view.open("ws-1")).toEqual(view);
        expect(await host.takeover.close("ws-1")).toEqual({ wasOpen: true });
        expect(await host.view.open("ws-1")).toEqual(view); // closing take-over leaves the view ticket alone
      });
    });

    it("input.insertText needs an open take-over and counts characters", async () => {
      await withHost(async ({ host }) => {
        await expect(host.input.insertText("ws-1", "hi")).rejects.toSatisfy(kind("not_found"));
        await host.ensure({ workspaceId: "ws-1" });
        await expect(host.input.insertText("ws-1", "hi")).rejects.toSatisfy(kind("denied"));
        await host.takeover.open("ws-1");
        await expect(host.input.insertText("ws-1", "")).rejects.toSatisfy(kind("invalid_input"));
        await expect(host.input.insertText("ws-1", "x".repeat(MAX_INSERT_TEXT_CHARS + 1))).rejects.toSatisfy(kind("invalid_input"));
        expect(await host.input.insertText("ws-1", "你好🙂")).toEqual({ inserted: 3 });
        expect(await host.input.insertText("ws-1", "x".repeat(MAX_INSERT_TEXT_CHARS))).toEqual({ inserted: MAX_INSERT_TEXT_CHARS });
        await host.takeover.close("ws-1");
        await expect(host.input.insertText("ws-1", "hi")).rejects.toSatisfy(kind("denied"));
      });
    });

    it("files: put, list and get round trip; a taken name gets a number; names are cleaned; nothing wakes the workspace", async () => {
      await withHost(async ({ host, stop }) => {
        await expect(host.files.put("ws-1", "a.txt", new Uint8Array([1]))).rejects.toSatisfy(kind("not_found"));
        await expect(host.files.list("ws-1")).rejects.toSatisfy(kind("not_found"));
        const info = await host.ensure({ workspaceId: "ws-1" });
        expect(await host.files.list("ws-1")).toEqual([]);
        const bytes = Uint8Array.from({ length: 5000 }, (_, i) => i % 256);
        const first = await host.files.put("ws-1", "report.pdf", bytes);
        expect(first).toMatchObject({ name: "report.pdf", size: 5000 });
        expect(first.path?.endsWith("/report.pdf")).toBe(true);
        expect(first.path?.startsWith(info.filesDir)).toBe(true);
        expect((await host.files.put("ws-1", "report.pdf", new Uint8Array([9]))).name).toBe("report-2.pdf");
        expect((await host.files.put("ws-1", "../../etc/.passwd", new Uint8Array([1]))).name).toBe("passwd");
        expect((await host.files.put("ws-1", "你好 报告.txt", new Uint8Array([1]))).name).toBe("你好 报告.txt");
        expect(Array.from(await host.files.get("ws-1", "report.pdf"))).toEqual(Array.from(bytes)); // the first file was not overwritten
        expect((await host.files.list("ws-1")).map((f) => f.name).sort()).toEqual(["passwd", "report-2.pdf", "report.pdf", "你好 报告.txt"]);
        await stop("ws-1");
        expect((await host.files.list("ws-1")).length).toBe(4); // still there, and listing did not wake the workspace
        expect((await host.health("ws-1")).state).toBe("stopped");
      });
    });

    it("files: refuses empty names and too large files, and a missing file is not_found", async () => {
      await withHost(async ({ host }) => {
        await host.ensure({ workspaceId: "ws-1" });
        for (const bad of ["", "   ", "..", "/", "\\", ".hidden"]) {
          if (bad === ".hidden") continue; // a leading dot is removed, not refused
          await expect(host.files.put("ws-1", bad, new Uint8Array([1]))).rejects.toSatisfy(kind("invalid_input"));
        }
        await expect(host.files.put("ws-1", "big.bin", new Uint8Array(MAX_FILE_BYTES + 1))).rejects.toSatisfy(kind("invalid_input"));
        await expect(host.files.get("ws-1", "nothing.txt")).rejects.toSatisfy(kind("not_found"));
        await expect(host.files.put("x/y", "a", new Uint8Array([1]))).rejects.toSatisfy(kind("invalid_input"));
      });
    });

    it("take-over for a workspace that does not exist is not_found", async () => {
      await withHost(async ({ host }) => {
        await expect(host.takeover.open("nothing")).rejects.toSatisfy(kind("not_found"));
        await expect(host.view.open("nothing")).rejects.toSatisfy(kind("not_found"));
        expect(await host.takeover.close("nothing")).toEqual({ wasOpen: false }); // closing what is not there is harmless
      });
    });
  });
}
