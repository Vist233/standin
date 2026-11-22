import { isJsonObject, OgbError } from "@standin/contracts";
import { SAFETY_FLOOR, type ProfileConfig, type ProfileDefinition } from "./types.ts";

const NAME = /^[a-z0-9][a-z0-9-]*$/;
const PROFILE_KEYS = new Set(["description", "plugins", "optionalPlugins", "model", "alwaysDeclaredTools", "settings"]);

/** Tool names may hold `_` (`ask_human`); plugin and profile names may not. */
const TOOL_NAME = /^[a-z0-9][a-z0-9_-]*$/;

function stringList(value: unknown, pattern: RegExp = NAME): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === "string" && pattern.test(item));
}

/** Validates the profile file and reports every problem by path. */
export function parseProfileConfig(input: unknown): ProfileConfig {
  const problems: string[] = [];
  if (!isJsonObject(input)) throw new OgbError("invalid_input", "profile config: the file must hold a JSON object");
  for (const key of Object.keys(input)) if (!["default", "safetyFloor", "profiles"].includes(key)) problems.push(`${key}: unknown key`);

  const safetyFloor = { review: true, redaction: true };
  if (input.safetyFloor !== undefined) {
    if (!isJsonObject(input.safetyFloor)) problems.push("safetyFloor: must be an object");
    else {
      for (const [key, value] of Object.entries(input.safetyFloor)) {
        if (!(SAFETY_FLOOR as readonly string[]).includes(key)) problems.push(`safetyFloor.${key}: unknown safety plugin`);
        else if (typeof value !== "boolean") problems.push(`safetyFloor.${key}: must be true or false`);
        else safetyFloor[key as keyof typeof safetyFloor] = value;
      }
    }
  }

  const profiles: Record<string, ProfileDefinition> = {};
  if (!isJsonObject(input.profiles) || Object.keys(input.profiles).length === 0) problems.push("profiles: must be an object with at least one profile");
  else {
    for (const [name, raw] of Object.entries(input.profiles)) {
      const profile = checkProfile(`profiles.${name}`, name, raw, problems);
      if (profile) profiles[name] = profile;
    }
  }
  const first = Object.keys(profiles)[0] ?? "";
  let defaultName = first;
  if (input.default !== undefined) {
    if (typeof input.default !== "string" || !(input.default in profiles)) problems.push("default: must name one of the profiles");
    else defaultName = input.default;
  }
  if (problems.length > 0) throw new OgbError("invalid_input", `profile config is invalid:\n- ${problems.join("\n- ")}`);
  return { default: defaultName, safetyFloor, profiles };
}

function checkProfile(path: string, name: string, raw: unknown, problems: string[]): ProfileDefinition | undefined {
  if (!NAME.test(name)) problems.push(`${path}: profile names are lower-case letters, digits and '-'`);
  if (!isJsonObject(raw)) {
    problems.push(`${path}: must be an object`);
    return undefined;
  }
  const before = problems.length;
  for (const key of Object.keys(raw)) if (!PROFILE_KEYS.has(key)) problems.push(`${path}.${key}: unknown key`);
  if (!stringList(raw.plugins)) problems.push(`${path}.plugins: must be a list of plugin names`);
  if (raw.optionalPlugins !== undefined && !stringList(raw.optionalPlugins)) problems.push(`${path}.optionalPlugins: must be a list of names`);
  if (raw.alwaysDeclaredTools !== undefined && !stringList(raw.alwaysDeclaredTools, TOOL_NAME))
    problems.push(`${path}.alwaysDeclaredTools: must be a list of tool names`);
  if (raw.model !== undefined && typeof raw.model !== "string") problems.push(`${path}.model: must be a model name`);
  if (raw.description !== undefined && typeof raw.description !== "string") problems.push(`${path}.description: must be text`);
  if (raw.settings !== undefined && !isJsonObject(raw.settings)) problems.push(`${path}.settings: must be an object`);
  return problems.length === before ? (raw as unknown as ProfileDefinition) : undefined;
}
