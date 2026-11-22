/**
 * The tools the runtime owns. A plugin cannot take one of these names (the plugin host refuses it); the runtime declares
 * `original` and `search` to every session and finds `session` through search unless a profile declares them.
 */
export const CORE_TOOL_NAMES = {
  /** The framework's own four. */
  original: ["read", "write", "edit", "bash"],
  /** Finding and running every other tool. */
  search: ["tool_search", "tool_call"],
  /** Tools of the session itself (speaking to the person, asking them, describing the workspace). */
  session: ["send_to_user", "ask_human", "workspace_info", "schedule", "hook", "remember_person", "session_search"],
} as const;
