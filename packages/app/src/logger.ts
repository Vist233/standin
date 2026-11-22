import { workspaceIdFor } from "@standin/session-runtime";

export type Level = "debug" | "info" | "warn" | "error";
const ORDER: Record<Level, number> = { debug: 0, info: 1, warn: 2, error: 3 };

export interface LoggerOptions {
  /** Receives one finished JSON line without the newline. */
  write(line: string): void;
  /** Values that must never be written; read at every line so a key added later is covered. */
  secrets(): readonly string[];
  level?: Level;
  now?: () => number;
}

export type Entry = Record<string, unknown>;

/**
 * One JSON object per line with `at`, `level`, `module`, and, when known, `session` and `workspace` (derived from the
 * session) and `seq`. Any secret value in the line is replaced before it is written, whatever field it was in: the
 * runtime logs errors and arguments of modules that know nothing about secrets.
 */
export function createLogger(options: LoggerOptions) {
  const threshold = ORDER[options.level ?? "info"];
  const now = options.now ?? Date.now;
  return (entry: Entry): void => {
    const level = (typeof entry.level === "string" && entry.level in ORDER ? entry.level : "info") as Level;
    if (ORDER[level] < threshold) return;
    const line: Entry = { at: new Date(now()).toISOString(), level, module: "app", ...entry };
    line.level = level;
    if (typeof line.session === "string" && line.workspace === undefined) {
      try {
        line.workspace = workspaceIdFor(line.session);
      } catch {
        // a session id that is not a valid workspace id has no workspace field
      }
    }
    let text: string;
    try {
      text = JSON.stringify(line, (_key, value) =>
        value instanceof Error ? { name: value.name, message: value.message } : typeof value === "bigint" ? String(value) : value,
      );
    } catch {
      text = JSON.stringify({ at: line.at, level: "error", module: "app", message: "a log entry could not be written" });
    }
    for (const secret of options.secrets()) if (secret.length >= 8) text = text.split(secret).join("[redacted]");
    options.write(text);
  };
}
