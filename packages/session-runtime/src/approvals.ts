import { createHash, randomBytes } from "node:crypto";
import type { ApprovalMode } from "@vesper/plugin-host";
import type { Tool } from "sakura-agent";
import { text } from "./tool-result.ts";

export interface ApprovalRequest {
  id: string;
  tool: string;
  args: unknown;
  status: "pending" | "approved" | "denied";
}

/**
 * Approvals of one session. An action that needs the person's approval is refused once, the request is shown to the
 * person, and when they approve, the SAME call (same tool, same arguments) may run once. The agent cannot approve for
 * itself: there is no argument that carries an approval, only this book, which the person's page writes to.
 */
export class ApprovalBook {
  private readonly requests = new Map<string, ApprovalRequest & { key: string }>();
  private readonly granted = new Set<string>();

  /**
   * The same call is the same request whatever order the model writes the arguments in: after an approval the agent repeats the call,
   * and a model rarely keeps key order (owner case tasks-and-people, 2026-11-17: the repeat opened a second request and nothing was sent).
   */
  static keyOf(tool: string, args: unknown): string {
    const stable = (value: unknown): unknown =>
      Array.isArray(value)
        ? value.map(stable)
        : value !== null && typeof value === "object"
          ? Object.fromEntries(
              Object.entries(value as Record<string, unknown>)
                .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
                .map(([k, v]) => [k, stable(v)]),
            )
          : value;
    return createHash("sha256")
      .update(JSON.stringify([tool, stable(args ?? null)]))
      .digest("hex");
  }

  /** The existing pending request for this exact call, or a new one. */
  request(tool: string, args: unknown): { request: ApprovalRequest; isNew: boolean } {
    const key = ApprovalBook.keyOf(tool, args);
    for (const existing of this.requests.values()) if (existing.key === key && existing.status === "pending") return { request: existing, isNew: false };
    const request = { id: `ap_${randomBytes(4).toString("hex")}`, tool, args, status: "pending" as const, key };
    this.requests.set(request.id, request);
    return { request, isNew: true };
  }

  /** Returns the request when it was pending, otherwise undefined (a repeated decision changes nothing). */
  decide(id: string, approved: boolean): ApprovalRequest | undefined {
    const request = this.requests.get(id);
    if (request?.status !== "pending") return undefined;
    request.status = approved ? "approved" : "denied";
    if (approved) this.granted.add(request.key);
    return request;
  }

  /** True once per grant: the approved call may run one time. */
  consume(tool: string, args: unknown): boolean {
    return this.granted.delete(ApprovalBook.keyOf(tool, args));
  }

  has(id: string): boolean {
    return this.requests.has(id);
  }

  pending(): ApprovalRequest[] {
    return [...this.requests.values()].filter((r) => r.status === "pending").map(({ id, tool, args, status }) => ({ id, tool, args, status }));
  }
}

export interface GateOptions {
  mode: ApprovalMode;
  book: ApprovalBook;
  /** Tells the person (journal event) that approval is needed. */
  announce(type: string, payload: unknown): Promise<void>;
  /** Yolo: while true, an `ask` tool runs without asking (`never` still refuses: it is not offered here at all). */
  bypass?: () => boolean;
}

/**
 * Wraps a tool with the approval mode its plugin's manifest gives it. `auto` runs; `never` refuses; `ask` refuses
 * the first time, asks the person, and runs once after they approve. The wrapper keeps the tool's name, schema and effect.
 */
export function gate(tool: Tool, options: GateOptions): Tool {
  if (options.mode === "auto") return tool;
  return {
    ...tool,
    async execute(args, context) {
      if (options.mode === "never") return { ...text(`The tool '${tool.name}' is not allowed here.`, true), details: { outcome: "refused" } };
      if (options.bypass?.() || options.book.consume(tool.name, args)) return tool.execute(args, context);
      const { request, isNew } = options.book.request(tool.name, args);
      if (isNew) await options.announce("approval.requested", { id: request.id, tool: tool.name, args });
      return {
        ...text(
          `This action needs the person's approval (request ${request.id}). They have been asked. Do not repeat it now; carry on with other work or end your turn. You will be told when they decide.`,
          true,
        ),
        details: { outcome: "needs_approval" },
      };
    },
  };
}
