import type { Tool, ToolEffect, ToolResult } from "sakura-agent";
export interface RunReply {
    id: number;
    ok: boolean;
    /** What the code returned, as text (the runner cuts it and says so). */
    value?: string;
    /** What the code printed. */
    logs: string[];
    /** Paths of the pictures the code took, in order: shown to the model. */
    images: string[];
    error?: string;
    /** Where the agent is after the code (the browser's tab), shown first. */
    where?: string;
    /** Set by the session when it had to kill the runner (timeout, cancel, crash). */
    restarted?: boolean;
}
/** A started child; `child_process.spawn`'s result fits. */
export interface Child {
    stdin: NodeJS.WritableStream | null;
    stdout: NodeJS.ReadableStream | null;
    stderr: NodeJS.ReadableStream | null;
    kill(signal?: NodeJS.Signals): boolean;
    once(event: "exit", listener: (code: number | null) => void): unknown;
}
/** Starts a runner. The host decides where it runs (here, in a container, in a workspace); `env` is its whole environment. */
export type Spawn = (program: string, args: string[], env: Record<string, string>) => Child;
export interface CodeToolOptions {
    name: string;
    description: string;
    /** The language, for the parameter's description. */
    language: string;
    effect: ToolEffect;
    runner: {
        program: string;
        args: string[];
    };
    /** The runner's whole environment, asked for whenever a runner starts. Nothing of the host's own environment is passed. */
    env: () => Promise<Record<string, string>> | Record<string, string>;
    spawn?: Spawn | undefined;
    /** All agents share one device (one desktop, one pointer): their calls run one at a time. Otherwise each agent's session runs on its own. */
    oneAtATime?: boolean | undefined;
    /** Said after a restart: what outlives the runner. */
    survives: string;
    /** Default limit of one call in seconds (60); the agent may ask for up to maxTimeoutSeconds (300). */
    timeoutSeconds?: number | undefined;
    maxTimeoutSeconds?: number | undefined;
    /** Called by close() after every runner has ended (the browser tool closes the browser it started). */
    onClose?: () => Promise<void> | undefined;
}
/**
 * Each agent (told apart by its conversation log, which a sub-agent has of its own) gets its own runner, started on first use and kept. A call that
 * runs too long or is cancelled cannot be stopped inside the runner, so the runner is killed and the next call starts a fresh one; the reply says so.
 */
export declare function createCodeTool(options: CodeToolOptions): Tool & {
    close(): Promise<void>;
};
/** What the model reads: where it is, what was printed, the value or the error, what a restart lost, then the pictures. */
export declare function render(reply: RunReply, survives: string): ToolResult;
