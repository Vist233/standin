import type { PluginContext } from "@standin/contracts";
import { createOutlook } from "./outlook.ts";

const made = new Map<string, ReturnType<typeof createOutlook>>();

/** One Outlook object per session: the tools and the event source share it. */
export function outlookFor(ctx: PluginContext): ReturnType<typeof createOutlook> {
  let outlook = made.get(ctx.dataDir);
  if (!outlook) {
    outlook = createOutlook(ctx);
    made.set(ctx.dataDir, outlook);
  }
  return outlook;
}
