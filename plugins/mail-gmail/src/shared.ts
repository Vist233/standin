import type { PluginContext } from "@standin/contracts";
import { createGmail } from "./gmail.ts";

const made = new Map<string, ReturnType<typeof createGmail>>();

/** One Gmail object per session: the tools and the event source share it. */
export function gmailFor(ctx: PluginContext): ReturnType<typeof createGmail> {
  let gmail = made.get(ctx.dataDir);
  if (!gmail) {
    gmail = createGmail(ctx);
    made.set(ctx.dataDir, gmail);
  }
  return gmail;
}
