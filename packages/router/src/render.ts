import type { Signal } from "@standin/contracts";

/**
 * The text a signal becomes when it reaches the model. The user's own words go through unchanged. Everything else
 * gets a one-line header with its source and trust, and its body is quoted line by line with "| ", so text that
 * pretends to be a header or an instruction stays visibly inside the quote. (This is a hint to the model, not a
 * security boundary; the review plugin and the AGENTS.md rules do the enforcing.)
 */
export function renderSignal(signal: Signal): string {
  if (signal.source === "user") return signal.text;
  const body = signal.text
    .split("\n")
    .map((line) => `| ${line}`)
    .join("\n");
  return `[signal source=${signal.source} trust=${signal.trust} id=${signal.id}]\n${body}`;
}

export function renderGroup(signals: Signal[]): string {
  return signals.map(renderSignal).join("\n\n");
}
