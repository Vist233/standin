/**
 * Every failure that crosses a module boundary has one of these kinds, so callers branch on the kind
 * and never on message text. The kinds say what the caller can do next, not where the failure came from.
 */
export const ERROR_KINDS = [
  "invalid_input", // the caller sent something malformed: fix the call
  "not_found", // the thing asked for does not exist
  "conflict", // the state does not allow it now (for example a second writer)
  "unavailable", // an environment problem (disk full, no permission, a dependency down): retry or tell a person
  "corrupt", // stored data does not parse and cannot be repaired automatically
  "unsupported_version", // stored or received data is from a newer schema than this code knows
  "denied", // a policy refused it (review, approval, trust)
  "internal", // a bug: the code reached a state it was written to rule out
] as const;

export type ErrorKind = (typeof ERROR_KINDS)[number];

export class OgbError extends Error {
  readonly kind: ErrorKind;

  constructor(kind: ErrorKind, message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "OgbError";
    this.kind = kind;
  }
}

export function isOgbError(value: unknown, kind?: ErrorKind): value is OgbError {
  // `instanceof` is not enough: a bundled plugin carries its own copy of this class, so the name tag is the identity that survives bundling.
  const ours = value instanceof OgbError || (typeof value === "object" && value !== null && (value as { name?: unknown }).name === "OgbError");
  return ours && (kind === undefined || (value as OgbError).kind === kind);
}
