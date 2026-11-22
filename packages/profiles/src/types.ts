import type { JsonValue } from "@standin/contracts";

/** The review and redaction plugins of the framework. Every session has them unless the config file on the box says otherwise. */
export const SAFETY_FLOOR = ["review", "redaction"] as const;
export type SafetyPlugin = (typeof SAFETY_FLOOR)[number];

export interface ProfileDefinition {
  description?: string;
  /** Plugins every session of this profile gets. */
  plugins: string[];
  /** Plugins the page may add to a new session of this profile. Nothing outside this list can be added from the page. */
  optionalPlugins?: string[];
  /** Name of a model in the model registry. */
  model?: string;
  /** Tools declared to the model on every turn in addition to the original tools and `tool_search`. */
  alwaysDeclaredTools?: string[];
  /** Free settings for the runtime. Written in the config file only. */
  settings?: Record<string, JsonValue>;
}

/** The profile file on the box. Only someone who can edit this file can change the safety floor. */
export interface ProfileConfig {
  default: string;
  safetyFloor: Record<SafetyPlugin, boolean>;
  profiles: Record<string, ProfileDefinition>;
}

/** What the page may send when it creates a session. This is the whole list: nothing else is read. */
export interface SessionRequest {
  profile?: string;
  title?: string;
  /** Must be a model that exists; the runtime checks it against the model registry. */
  model?: string;
  /** Must be listed in the profile's `optionalPlugins`. */
  extraPlugins?: string[];
}

export interface ResolvedProfile {
  readonly profile: string;
  readonly title: string;
  readonly model: string | undefined;
  /** Safety plugins that are on. Always at the front of the plugin list the runtime builds. */
  readonly floor: readonly SafetyPlugin[];
  /** Plugins of the profile plus the page's extras, in a fixed order without repeats; never contains a safety plugin name. */
  readonly plugins: readonly string[];
  readonly alwaysDeclaredTools: readonly string[];
  readonly settings: Readonly<Record<string, JsonValue>>;
  /** Things the owner should see, for example that the config file has switched a safety plugin off. */
  readonly warnings: readonly string[];
}
