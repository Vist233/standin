import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { SessionEvent } from "@standin/contracts";
import { writeFixturePlugin } from "@standin/plugin-host/testing";

/** A plugin with one tool, `gated`, that stays inside its call until the test opens the gate. */
export function gatedPlugin(root = mkdtempSync(join(tmpdir(), "ogb-gated-")), name = "demo", approval?: Record<string, string>) {
  const toolsSource = `
    export function createTools() {
      return [{
        name: "gated", description: "waits for the test", parameters: { type: "object", properties: {} }, effect: "write", replay: "never",
        async execute() {
          globalThis.__ogbCalls = (globalThis.__ogbCalls ?? 0) + 1;
          globalThis.__ogbStarted?.();
          await globalThis.__ogbGate;
          return { content: [{ type: "text", text: "gate opened" }] };
        },
      }];
    }`;
  return writeFixturePlugin(root, { name, toolsSource, effects: ["write"], ...(approval ? { approval } : {}) });
}

export interface Gate {
  /** Resolves when the tool has been called. */
  started: Promise<void>;
  open(): void;
}

export function installGate(): Gate {
  let open!: () => void;
  let started!: () => void;
  const g = globalThis as Record<string, unknown>;
  g.__ogbGate = new Promise<void>((resolve) => {
    open = resolve;
  });
  const startedPromise = new Promise<void>((resolve) => {
    started = resolve;
  });
  g.__ogbStarted = started;
  return { started: startedPromise, open };
}

export const types = (events: SessionEvent[]) => events.map((e) => e.type);

export { userTexts } from "../src/testing/index.ts";

export function callCount(): number {
  return ((globalThis as Record<string, unknown>).__ogbCalls as number | undefined) ?? 0;
}

export function resetCalls(): void {
  (globalThis as Record<string, unknown>).__ogbCalls = 0;
}
