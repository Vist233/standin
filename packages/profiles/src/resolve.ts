import { isJsonObject, OgbError } from "@standin/contracts";
import { SAFETY_FLOOR, type ProfileConfig, type ResolvedProfile, type SafetyPlugin, type SessionRequest } from "./types.ts";

const REQUEST_KEYS = new Set<string>(["profile", "title", "model", "extraPlugins"]);

/** Words that mean someone is trying to touch the safety floor. A request that mentions them is refused outright, not ignored. */
const FLOOR_WORDS = /review|redact|safety|floor|disable|unsafe|bypass/i;

/** Reads what the page sent. Anything outside the four allowed fields is an error, and a field that smells like the safety floor is `denied`. */
export function parseSessionRequest(input: unknown): SessionRequest {
  if (input === undefined || input === null) return {};
  if (!isJsonObject(input)) throw new OgbError("invalid_input", "session request must be an object");
  for (const key of Object.keys(input)) {
    if (REQUEST_KEYS.has(key)) continue;
    if (FLOOR_WORDS.test(key))
      throw new OgbError("denied", `'${key}' cannot be set from the page: the safety floor is controlled by the config file on the box`);
    throw new OgbError("invalid_input", `unknown field '${key}' in session request`);
  }
  const request: SessionRequest = {};
  if (input.profile !== undefined) request.profile = text(input.profile, "profile");
  if (input.title !== undefined) request.title = text(input.title, "title");
  if (input.model !== undefined) request.model = text(input.model, "model");
  if (input.extraPlugins !== undefined) {
    if (!Array.isArray(input.extraPlugins)) throw new OgbError("invalid_input", "extraPlugins must be a list of plugin names");
    request.extraPlugins = input.extraPlugins.map((item) => text(item, "extraPlugins entry"));
  }
  return request;
}

function text(value: unknown, field: string): string {
  if (typeof value !== "string" || value === "" || value.length > 200) throw new OgbError("invalid_input", `${field} must be a short text`);
  return value;
}

/**
 * Builds the profile of one new session. The page's request can name a profile, a title, a model and extra plugins
 * from the profile's own optional list; it cannot remove anything. The result is frozen.
 * The safety plugins come from the config file only, so no page request can lower them.
 */
export function resolveSession(config: ProfileConfig, rawRequest: unknown): ResolvedProfile {
  const request = parseSessionRequest(rawRequest);
  const name = request.profile ?? config.default;
  const definition = config.profiles[name];
  if (!definition) throw new OgbError("not_found", `no profile named '${name}' (known: ${Object.keys(config.profiles).join(", ")})`);

  const optional = new Set(definition.optionalPlugins ?? []);
  for (const extra of request.extraPlugins ?? []) {
    if (!optional.has(extra)) throw new OgbError("denied", `plugin '${extra}' is not offered by profile '${name}'`);
  }
  const floorNames = SAFETY_FLOOR as readonly string[];
  const plugins = [...new Set([...definition.plugins, ...(request.extraPlugins ?? [])])].filter((plugin) => !floorNames.includes(plugin));

  const floor: SafetyPlugin[] = SAFETY_FLOOR.filter((plugin) => config.safetyFloor[plugin]);
  const warnings = SAFETY_FLOOR.filter((plugin) => !config.safetyFloor[plugin]).map((plugin) => `the config file has switched off the ${plugin} plugin`);

  const resolved: ResolvedProfile = {
    profile: name,
    title: request.title ?? name,
    model: request.model ?? definition.model,
    floor: Object.freeze(floor),
    plugins: Object.freeze(plugins),
    alwaysDeclaredTools: Object.freeze([...(definition.alwaysDeclaredTools ?? [])]),
    settings: Object.freeze(structuredClone(definition.settings ?? {})),
    warnings: Object.freeze(warnings),
  };
  return Object.freeze(resolved);
}
