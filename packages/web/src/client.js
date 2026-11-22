// @ts-check
// Everything the page does over the network, with no DOM: the JSON API and the event stream that reconnects by itself.
// It takes `fetch`, a sleep function and an abort signal as parameters, so tests can run it against the real gateway
// from Node and against a broken server, without a browser.

import { createSseParser } from "./sse.js";

/**
 * @typedef {import("./model.js").SessionEvent} SessionEvent
 * @typedef {{ status: number, kind: string, message: string }} ApiFailure
 */

export class ApiError extends Error {
  /** @param {number} status @param {string} kind @param {string} message */
  constructor(status, kind, message) {
    super(message);
    this.name = "ApiError";
    this.status = status;
    this.kind = kind;
  }
}

/**
 * The JSON API. `token()` is read at every call, so a token entered later is used at once.
 * @param {{ base?: string, token?: () => string | undefined, fetch?: typeof fetch }} [options]
 */
export function createApi(options = {}) {
  const base = options.base ?? "";
  const doFetch = options.fetch ?? ((...args) => fetch(...args));
  async function call(/** @type {string} */ method, /** @type {string} */ path, /** @type {unknown} */ body = undefined) {
    /** @type {Record<string, string>} */
    const headers = {};
    const token = options.token?.();
    if (token) headers.authorization = `Bearer ${token}`;
    if (body !== undefined) headers["content-type"] = "application/json";
    let response;
    try {
      response = await doFetch(base + path, { method, headers, ...(body !== undefined ? { body: JSON.stringify(body) } : {}), cache: "no-store" });
    } catch {
      throw new ApiError(0, "unreachable", "The server cannot be reached.");
    }
    /** @type {any} */
    let json = null;
    try {
      json = await response.json();
    } catch {
      json = null;
    }
    if (!response.ok) {
      throw new ApiError(response.status, json?.error?.kind ?? "internal", json?.error?.message ?? `The server answered ${response.status}.`);
    }
    return json;
  }
  return {
    health: () => call("GET", "/api/health"),
    options: () => call("GET", "/api/options"),
    listSessions: () => call("GET", "/api/sessions"),
    createSession: (/** @type {{ title?: string, star?: string, model?: string, profile?: string }} */ request) => call("POST", "/api/sessions", request),
    updateSession: (/** @type {string} */ id, /** @type {{ title?: string, star?: string, yolo?: boolean }} */ patch) =>
      call("PATCH", `/api/sessions/${id}`, patch),
    getSession: (/** @type {string} */ id) => call("GET", `/api/sessions/${id}`),
    resume: (/** @type {string} */ id) => call("POST", `/api/sessions/${id}/resume`),
    send: (
      /** @type {string} */ id,
      /** @type {string} */ text,
      /** @type {string} */ messageId,
      /** @type {{ name: string, size: number }[]} */ attachments = [],
    ) => call("POST", `/api/sessions/${id}/messages`, { text, id: messageId, ...(attachments.length > 0 ? { attachments } : {}) }),
    stop: (/** @type {string} */ id) => call("POST", `/api/sessions/${id}/stop`),
    decide: (/** @type {string} */ id, /** @type {string} */ approvalId, /** @type {boolean} */ approved) =>
      call("POST", `/api/sessions/${id}/approvals/${approvalId}`, { approved }),
    liveView: (/** @type {string} */ id) => call("POST", `/api/sessions/${id}/live-view`, {}),
    /** Types text into the focused field of the page in the desktop (any Unicode); only while the person is in control. */
    insertText: (/** @type {string} */ id, /** @type {string} */ text) => call("POST", `/api/sessions/${id}/text`, { text }),
    listFiles: (/** @type {string} */ id) => call("GET", `/api/sessions/${id}/files`),
    deleteSession: (/** @type {string} */ id) => call("DELETE", `/api/sessions/${id}`),
    takeover: (/** @type {string} */ id) => call("POST", `/api/sessions/${id}/takeover`),
    handback: (/** @type {string} */ id, /** @type {string} */ note) => call("POST", `/api/sessions/${id}/handback`, note ? { note } : {}),
  };
}

/**
 * @typedef {"connecting" | "live" | "reconnecting" | "unauthorized" | "gone"} Connection
 */

/**
 * Follows a session's event stream for ever: connects with the last sequence number it has, hands the events to
 * `onEvents` in batches (one per network chunk), and when the connection drops, ends or goes quiet it waits and
 * connects again from where it was. The caller deduplicates by `seq` (the model does), so overlap is harmless.
 * It stops only when `signal` is aborted, or for an answer that retrying cannot fix (401, 404).
 *
 * @param {{
 *   url: string,
 *   after?: () => number,
 *   token?: () => string | undefined,
 *   onEvents: (events: SessionEvent[]) => void,
 *   onConnection?: (state: Connection, detail?: { attempt: number }) => void,
 *   signal: AbortSignal,
 *   fetch?: typeof fetch,
 *   sleep?: (ms: number, signal: AbortSignal) => Promise<void>,
 *   backoffMs?: { first: number, max: number },
 *   quietMs?: number,
 * }} options
 */
export async function followEvents(options) {
  const doFetch = options.fetch ?? ((...args) => fetch(...args));
  const sleep = options.sleep ?? defaultSleep;
  const backoff = options.backoffMs ?? { first: 500, max: 8000 };
  const quietMs = options.quietMs ?? 45_000; // the server pings every 15 s
  let attempt = 0;
  let retryAfter = 0;

  while (!options.signal.aborted) {
    options.onConnection?.(attempt === 0 ? "connecting" : "reconnecting", { attempt });
    const attemptAbort = new AbortController();
    const stop = () => attemptAbort.abort();
    options.signal.addEventListener("abort", stop, { once: true });
    let watchdog = setTimeout(stop, quietMs);
    const alive = () => {
      clearTimeout(watchdog);
      watchdog = setTimeout(stop, quietMs);
    };
    try {
      /** @type {Record<string, string>} */
      const headers = { accept: "text/event-stream" };
      const after = options.after?.() ?? 0;
      if (after > 0) headers["last-event-id"] = String(after);
      const token = options.token?.();
      if (token) headers.authorization = `Bearer ${token}`;
      const response = await doFetch(options.url, { headers, cache: "no-store", signal: attemptAbort.signal });
      if (response.status === 401) return options.onConnection?.("unauthorized");
      if (response.status === 404) return options.onConnection?.("gone");
      if (!response.ok || !response.body) {
        retryAfter = Number(response.headers.get("retry-after")) * 1000 || 0;
        throw new Error(`status ${response.status}`);
      }
      alive();
      options.onConnection?.("live");
      attempt = 0;
      /** @type {SessionEvent[]} */
      let batch = [];
      const parser = createSseParser((frame) => {
        try {
          batch.push(JSON.parse(frame.data));
        } catch {
          // A frame that is not JSON is not ours; skipping it is safer than stopping.
        }
      });
      const decoder = new TextDecoder();
      const reader = response.body.getReader();
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        alive();
        parser.feed(decoder.decode(value, { stream: true }));
        if (batch.length > 0) {
          const out = batch;
          batch = [];
          options.onEvents(out);
        }
      }
    } catch {
      // dropped, refused, or quiet for too long: fall through to the wait below
    } finally {
      clearTimeout(watchdog);
      options.signal.removeEventListener("abort", stop);
    }
    if (options.signal.aborted) return;
    attempt += 1;
    const wait = Math.max(retryAfter, Math.min(backoff.max, backoff.first * 2 ** Math.min(attempt - 1, 10)));
    retryAfter = 0;
    options.onConnection?.("reconnecting", { attempt });
    await sleep(wait, options.signal).catch(() => {});
  }
}

function defaultSleep(/** @type {number} */ ms, /** @type {AbortSignal} */ signal) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(resolve, ms);
    signal.addEventListener(
      "abort",
      () => {
        clearTimeout(timer);
        reject(new Error("aborted"));
      },
      { once: true },
    );
  });
}

/**
 * Sends one file into the session's files directory with progress (fetch cannot report upload progress, XMLHttpRequest can).
 * The file name travels in a header, percent-encoded; the body is the raw bytes. `xhr` is a parameter so tests need no browser.
 * @param {{ session: string, file: Blob & { name: string }, token?: () => string | undefined, onProgress?: (fraction: number) => void, base?: string, xhr?: () => XMLHttpRequest }} options
 * @returns {Promise<{ file: { name: string, size: number, modifiedAt: number, path?: string } }>}
 */
export function uploadFile(options) {
  return new Promise((resolve, reject) => {
    const request = (options.xhr ?? (() => new XMLHttpRequest()))();
    request.open("POST", `${options.base ?? ""}/api/sessions/${options.session}/files`);
    request.setRequestHeader("x-file-name", encodeURIComponent(options.file.name));
    request.setRequestHeader("content-type", options.file.type || "application/octet-stream");
    const token = options.token?.();
    if (token) request.setRequestHeader("authorization", `Bearer ${token}`);
    request.upload.onprogress = (event) => {
      if (event.lengthComputable) options.onProgress?.(event.loaded / event.total);
    };
    request.onerror = () => reject(new ApiError(0, "unreachable", "The server cannot be reached."));
    request.onload = () => {
      /** @type {any} */
      let json = null;
      try {
        json = JSON.parse(request.responseText);
      } catch {
        json = null;
      }
      if (request.status >= 200 && request.status < 300 && json?.file) resolve(json);
      else reject(new ApiError(request.status, json?.error?.kind ?? "internal", json?.error?.message ?? `The server answered ${request.status}.`));
    };
    request.send(options.file);
  });
}

/** Fetches a file of the session as a Blob (with the token, which a plain link could not send) so the page can save it. */
export async function downloadFile(
  /** @type {{ session: string, name: string, token?: () => string | undefined, base?: string, fetch?: typeof fetch }} */ options,
) {
  const doFetch = options.fetch ?? ((...args) => fetch(...args));
  /** @type {Record<string, string>} */
  const headers = {};
  const token = options.token?.();
  if (token) headers.authorization = `Bearer ${token}`;
  let response;
  try {
    response = await doFetch(`${options.base ?? ""}/api/sessions/${options.session}/files/${encodeURIComponent(options.name)}`, { headers, cache: "no-store" });
  } catch {
    throw new ApiError(0, "unreachable", "The server cannot be reached.");
  }
  if (!response.ok) {
    /** @type {any} */
    let json = null;
    try {
      json = await response.json();
    } catch {
      json = null;
    }
    throw new ApiError(response.status, json?.error?.kind ?? "internal", json?.error?.message ?? `The server answered ${response.status}.`);
  }
  return response.blob();
}
