import type { IncomingMessage, ServerResponse } from "node:http";
import { isOgbError, type ErrorKind } from "@standin/contracts";

/** A failure the client caused or can fix, with the status that says so. */
export class HttpFailure extends Error {
  readonly status: number;
  readonly kind: ErrorKind;
  constructor(status: number, kind: ErrorKind, message: string) {
    super(message);
    this.status = status;
    this.kind = kind;
  }
}

const STATUS_OF_KIND: Record<ErrorKind, number> = {
  invalid_input: 400,
  not_found: 404,
  conflict: 409,
  unavailable: 503,
  corrupt: 500,
  unsupported_version: 500,
  denied: 403,
  internal: 500,
};

/** Maps any thrown value to a status and a body. An unexpected exception never leaks its text. */
export function describeFailure(error: unknown): { status: number; body: { error: { kind: ErrorKind; message: string } } } {
  if (error instanceof HttpFailure) return { status: error.status, body: { error: { kind: error.kind, message: error.message } } };
  if (isOgbError(error)) {
    const hide = error.kind === "internal" || error.kind === "corrupt";
    return { status: STATUS_OF_KIND[error.kind], body: { error: { kind: error.kind, message: hide ? "the server failed; see its log" : error.message } } };
  }
  return { status: 500, body: { error: { kind: "internal", message: "the server failed; see its log" } } };
}

export const SECURITY_HEADERS = {
  "x-content-type-options": "nosniff",
  "referrer-policy": "no-referrer",
  "cross-origin-resource-policy": "same-origin",
  "x-frame-options": "DENY",
} as const;

export function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const text = JSON.stringify(body);
  res.writeHead(status, {
    ...SECURITY_HEADERS,
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(text),
    "cache-control": "no-store",
  });
  res.end(text);
}

/**
 * Reads a JSON object body. No body means `{}`. A body must say it is JSON (a plain HTML form cannot) and may not
 * exceed `max` bytes; the limit is checked on the declared length and again while reading.
 */
export async function readJsonObject(req: IncomingMessage, max: number): Promise<Record<string, unknown>> {
  const declared = Number(req.headers["content-length"] ?? 0);
  if (declared > max) throw new HttpFailure(413, "invalid_input", `body is larger than ${max} bytes`);
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of req) {
    total += (chunk as Buffer).length;
    if (total > max) throw new HttpFailure(413, "invalid_input", `body is larger than ${max} bytes`);
    chunks.push(chunk as Buffer);
  }
  if (total === 0) return {};
  if (!/^application\/json\s*(;|$)/i.test(req.headers["content-type"] ?? ""))
    throw new HttpFailure(415, "invalid_input", "content-type must be application/json");
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw new HttpFailure(400, "invalid_input", "body is not valid JSON");
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) throw new HttpFailure(400, "invalid_input", "body must be a JSON object");
  return parsed as Record<string, unknown>;
}

/** Reads a raw body (a file) up to `max` bytes: the declared length is checked first, then what actually arrives. An empty body is refused. */
export async function readRawBody(req: IncomingMessage, max: number): Promise<Buffer> {
  const declared = Number(req.headers["content-length"] ?? 0);
  if (declared > max) throw new HttpFailure(413, "invalid_input", `the file is larger than ${max} bytes`);
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of req) {
    total += (chunk as Buffer).length;
    if (total > max) throw new HttpFailure(413, "invalid_input", `the file is larger than ${max} bytes`);
    chunks.push(chunk as Buffer);
  }
  if (total === 0) throw new HttpFailure(400, "invalid_input", "the file is empty");
  return Buffer.concat(chunks);
}

/** Sends bytes as a download: always an attachment, never sniffed, never cached, whatever the file claims to be. */
export function sendDownload(res: ServerResponse, name: string, bytes: Uint8Array): void {
  res.writeHead(200, {
    ...SECURITY_HEADERS,
    "content-type": "application/octet-stream",
    "content-length": bytes.length,
    "content-disposition": `attachment; filename="download"; filename*=UTF-8''${encodeURIComponent(name).replace(/['()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`)}`,
    "cache-control": "no-store",
  });
  res.end(bytes);
}

export function textField(body: Record<string, unknown>, name: string, maxLength: number, required = true): string | undefined {
  const value = body[name];
  if (value === undefined && !required) return undefined;
  if (typeof value !== "string" || value.trim() === "") throw new HttpFailure(400, "invalid_input", `'${name}' must be a non-empty text`);
  if (value.length > maxLength) throw new HttpFailure(400, "invalid_input", `'${name}' is longer than ${maxLength} characters`);
  return value;
}
