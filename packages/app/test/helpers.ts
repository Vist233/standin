import { existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { WorkspaceHost } from "@standin/contracts";
import { makeWritable } from "@standin/plugin-host";
import { createFakeWorkspaceHost } from "@standin/workspace-client/testing";
import { createApp } from "../src/app.ts";

export const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
export const KEY = "cc-test-key-0123456789abcdef";

/** A model that always answers "pong"; records every request it was sent. */
export function pongModel() {
  const requests: unknown[] = [];
  const clientOptions: { apiKey?: string; compat?: unknown }[] = [];
  return {
    requests,
    clientOptions,
    create: (options?: { apiKey?: string; compat?: unknown }) => ({
      ...(options ? void clientOptions.push(options) : {}),
      model: { id: "fake", contextWindow: 100_000, supportsImages: false },
      async *stream(request: unknown) {
        requests.push(request);
        yield { type: "text_delta" as const, delta: "pong" };
        yield { type: "usage" as const, usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 } };
        yield { type: "done" as const, stop: "stop" as const };
      },
    }),
  };
}

export interface Harness {
  app: ReturnType<typeof createApp>;
  logs: string[];
  parsed(): Record<string, unknown>[];
  dataDir: string;
  closed: string[];
  /** The environment object the application was given. */
  env: Record<string, string | undefined>;
  model: ReturnType<typeof pongModel>;
  base(report: { listening: { port: number } }): string;
  cleanup(): Promise<void>;
}

export function harness(
  env: Record<string, string | undefined> = {},
  options: { deskDown?: boolean; processEnv?: boolean; fetch?: typeof fetch } = {},
): Harness {
  const dataDir = mkdtempSync(join(tmpdir(), "ogb-app-"));
  mkdirSync(join(dataDir, "ws"), { recursive: true });
  const logs: string[] = [];
  const closed: string[] = [];
  const fake = createFakeWorkspaceHost({ root: join(dataDir, "ws") });
  const host: WorkspaceHost & { close(): void } = {
    ensure: (spec) => fake.ensure(spec),
    destroy: (id) => fake.destroy(id),
    health: options.deskDown ? () => Promise.reject(new Error("socket closed")) : (id) => fake.health(id),
    takeover: fake.takeover,
    view: fake.view,
    input: fake.input,
    files: fake.files,
    close: () => void closed.push("workspace client"),
  };
  const model = pongModel();
  const given = { OGB_DATA_DIR: dataDir, OGB_HOST: "127.0.0.1", OGB_PORT: "0", OGB_APP_ROOT: repoRoot, ...env };
  if (options.processEnv) Object.assign(process.env, given);
  const app = createApp({
    env: options.processEnv ? process.env : given,
    write: (line) => void logs.push(line),
    deps: { workspaceHost: host, createClient: model.create, ...(options.fetch ? { fetch: options.fetch } : {}) },
  });
  return {
    app,
    logs,
    parsed: () => logs.map((line) => JSON.parse(line) as Record<string, unknown>),
    dataDir,
    closed,
    env: options.processEnv ? process.env : given,
    model,
    base: (report) => `http://127.0.0.1:${report.listening.port}`,
    async cleanup() {
      await app.stop();
      if (existsSync(join(dataDir, "plugin-cache"))) makeWritable(join(dataDir, "plugin-cache")); // the installed plugins are read-only
      rmSync(dataDir, { recursive: true, force: true });
    },
  };
}
