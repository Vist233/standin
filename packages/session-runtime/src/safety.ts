import type { SafetyPlugin } from "@standin/profiles";
import { type LlmClient, type Plugin, redactionPlugin, reviewPlugin } from "sakura-agent";
import { type ReviewPolicy, VESPER_REVIEW_POLICY } from "./review-policy.ts";

/**
 * The framework's own review and redaction plugins, wired as the safety floor says. Redaction wraps the reviewer's
 * model too, because the reviewer's requests do not pass the agent's own hook. Order: redaction first.
 */
export function defaultSafetyPlugins(floor: readonly SafetyPlugin[], llm: LlmClient, policy: ReviewPolicy = VESPER_REVIEW_POLICY): Plugin[] {
  const plugins: Plugin[] = [];
  const redaction = floor.includes("redaction") ? redactionPlugin() : undefined;
  if (redaction) plugins.push(redaction);
  if (floor.includes("review")) plugins.push(reviewPlugin({ llm: redaction ? redaction.wrap(llm) : llm, policy }));
  return plugins;
}

/**
 * The reviewer, switched off while `off()` is true (yolo): its hooks do nothing and `authorize` allows. Read at every call, so the
 * person's switch takes effect from the next tool call of a running bot. Plugins without `authorize` (redaction) are returned as they are.
 */
export function switchableReview(plugin: Plugin, off: () => boolean): Plugin {
  const reviewer = plugin as Plugin & { authorize?: (...args: unknown[]) => Promise<unknown>; exempt?: (name: string) => void };
  if (typeof reviewer.authorize !== "function") return plugin;
  const authorize = reviewer.authorize.bind(reviewer);
  return {
    ...reviewer,
    setup(api) {
      reviewer.setup({
        ...api,
        on: ((hook: string, handler: (...args: unknown[]) => unknown) =>
          (api.on as (hook: string, handler: (...args: unknown[]) => unknown) => void)(hook, (...args) =>
            off() ? undefined : handler(...args),
          )) as typeof api.on,
      });
    },
    authorize: (...args: unknown[]) => (off() ? Promise.resolve({ kind: "allow" }) : authorize(...args)),
    ...(reviewer.exempt ? { exempt: reviewer.exempt.bind(reviewer) } : {}),
  } as Plugin;
}
