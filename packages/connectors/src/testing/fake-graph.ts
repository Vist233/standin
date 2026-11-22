/**
 * A stand-in for Microsoft's sign-in and the part of Graph the Outlook provider uses, as one `fetch` function. Shapes follow the real
 * ones: form-encoded token requests with `authorization_pending` until the person signs in, refresh tokens replaced on every use, mail
 * folders by well-known name, immutable ids kept from draft to sent, `ErrorItemNotFound` for an unknown id.
 */
export interface FakeGraph {
  fetch: typeof fetch;
  authority: string;
  baseUrl: string;
  /** The person signs in with the code that was shown (or declines). */
  signIn(userCode: string): void;
  decline(userCode: string): void;
  deliver(mail: { from: string; subject: string; body: string }): void;
  /** Ends every access token now, as an hour passing would. */
  expireAccessTokens(): void;
  readonly requests: string[];
  readonly address: string;
}

interface Message {
  id: string;
  folder: "inbox" | "sentitems" | "drafts";
  from: string;
  to: string[];
  cc: string[];
  subject: string;
  body: string;
  received: string;
  sent?: string;
  isRead: boolean;
}

export function createFakeGraph(options: { address?: string } = {}): FakeGraph {
  const address = options.address ?? "person@outlook.test";
  const authority = "https://login.example.test";
  const baseUrl = "https://graph.example.test/v1.0";
  const devices = new Map<string, { userCode: string; state: "pending" | "signed" | "declined" }>();
  const access = new Set<string>();
  const refresh = new Set<string>();
  const messages: Message[] = [];
  let counter = 0;
  let clock = Date.UTC(2026, 10, 17, 9);
  const requests: string[] = [];
  const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status, headers: { "content-type": "application/json" } });
  const issue = () => {
    counter += 1;
    const pair = { access_token: `at-${counter}`, refresh_token: `rt-${counter}`, expires_in: 3600, token_type: "Bearer" };
    access.add(pair.access_token);
    refresh.add(pair.refresh_token);
    return pair;
  };
  const folderId = (name: string) => `FOLDER-${name.toUpperCase()}`;
  const view = (m: Message, withBody: boolean) => ({
    id: m.id,
    subject: m.subject,
    from: { emailAddress: { address: m.from, name: m.from } },
    toRecipients: m.to.map((a) => ({ emailAddress: { address: a } })),
    ccRecipients: m.cc.map((a) => ({ emailAddress: { address: a } })),
    receivedDateTime: m.received,
    ...(m.sent ? { sentDateTime: m.sent } : {}),
    isRead: m.isRead,
    parentFolderId: folderId(m.folder),
    ...(withBody ? { body: { contentType: "text", content: m.body } } : {}),
  });

  const fake: FakeGraph = {
    authority,
    baseUrl,
    address,
    requests,
    signIn(code) {
      for (const device of devices.values()) if (device.userCode === code) device.state = "signed";
    },
    decline(code) {
      for (const device of devices.values()) if (device.userCode === code) device.state = "declined";
    },
    deliver(mail) {
      clock = Math.max(clock + 1, Date.now()); // arrival times follow the real clock, as a server's do
      counter += 1;
      messages.push({
        id: `AAMk-${counter}`,
        folder: "inbox",
        from: mail.from,
        to: [address],
        cc: [],
        subject: mail.subject,
        body: mail.body,
        received: new Date(clock).toISOString(),
        isRead: false,
      });
    },
    expireAccessTokens: () => access.clear(),
    fetch: (async (input: string | URL | Request, init?: RequestInit) => {
      const url = new URL(String(input));
      const method = (init?.method ?? "GET").toUpperCase();
      requests.push(`${method} ${url.pathname}`);

      if (url.origin === authority) {
        const form = new URLSearchParams(String(init?.body ?? ""));
        if (url.pathname.endsWith("/devicecode")) {
          counter += 1;
          const device = `dc-${counter}`;
          const userCode = `CODE${counter}`;
          devices.set(device, { userCode, state: "pending" });
          return json({ device_code: device, user_code: userCode, verification_uri: "https://microsoft.com/devicelogin", expires_in: 900, interval: 1 });
        }
        if (form.get("grant_type") === "refresh_token") {
          const token = form.get("refresh_token") ?? "";
          if (!refresh.delete(token)) return json({ error: "invalid_grant" }, 400);
          return json(issue());
        }
        const device = devices.get(form.get("device_code") ?? "");
        if (!device) return json({ error: "expired_token" }, 400);
        if (device.state === "pending") return json({ error: "authorization_pending" }, 400);
        if (device.state === "declined") return json({ error: "authorization_declined" }, 400);
        devices.delete(form.get("device_code") ?? "");
        return json(issue());
      }

      const token = (new Headers(init?.headers).get("authorization") ?? "").replace(/^Bearer /, "");
      if (!access.has(token)) return json({ error: { code: "InvalidAuthenticationToken" } }, 401);
      const path = url.pathname.replace(/^\/v1\.0/, "");
      if (path === "/me") return json({ mail: address, userPrincipalName: address });
      const folder = /^\/me\/mailFolders\/(inbox|sentitems)$/.exec(path);
      if (folder) return json({ id: folderId(folder[1] as string) });
      const list = /^\/me\/mailFolders\/(inbox|sentitems)\/messages$/.exec(path);
      if (list && method === "GET") {
        let found = messages.filter((m) => m.folder === list[1]);
        const search = url.searchParams.get("$search");
        if (search) {
          const words = search.replace(/"/g, "").toLowerCase().split(/\s+/).filter(Boolean);
          found = found.filter((m) => words.every((w) => `${m.subject} ${m.from} ${m.body}`.toLowerCase().includes(w)));
        } else {
          found.sort((a, b) => (b.sent ?? b.received).localeCompare(a.sent ?? a.received));
        }
        const top = Number(url.searchParams.get("$top") ?? "10");
        const skip = Number(url.searchParams.get("$skip") ?? "0");
        const page = found.slice(skip, skip + top);
        const more = !search && skip + top < found.length;
        if (more) url.searchParams.set("$skip", String(skip + top));
        return json({ value: page.map((m) => view(m, false)), ...(more ? { "@odata.nextLink": `${baseUrl}${path}?${url.searchParams}` } : {}) });
      }
      const one = /^\/me\/messages\/([^/]+)$/.exec(path);
      if (one) {
        const message = messages.find((m) => m.id === decodeURIComponent(one[1] as string) && m.folder !== "drafts");
        if (!message) return json({ error: { code: "ErrorItemNotFound" } }, 404);
        if (method === "PATCH") {
          const patch = JSON.parse(String(init?.body ?? "{}")) as { isRead?: boolean };
          if (typeof patch.isRead === "boolean") message.isRead = patch.isRead;
          return json(view(message, false));
        }
        return json(view(message, true));
      }
      if (path === "/me/messages" && method === "POST") {
        const draft = JSON.parse(String(init?.body ?? "{}")) as {
          subject: string;
          body: { content: string };
          toRecipients: { emailAddress: { address: string } }[];
          ccRecipients?: { emailAddress: { address: string } }[];
        };
        counter += 1;
        const id = `AAMk-${counter}`;
        messages.push({
          id,
          folder: "drafts",
          from: address,
          to: draft.toRecipients.map((r) => r.emailAddress.address),
          cc: (draft.ccRecipients ?? []).map((r) => r.emailAddress.address),
          subject: draft.subject,
          body: draft.body.content,
          received: new Date(clock).toISOString(),
          isRead: true,
        });
        return json({ id }, 201);
      }
      const send = /^\/me\/messages\/([^/]+)\/send$/.exec(path);
      if (send && method === "POST") {
        const draft = messages.find((m) => m.id === decodeURIComponent(send[1] as string) && m.folder === "drafts");
        if (!draft) return json({ error: { code: "ErrorItemNotFound" } }, 404);
        clock = Math.max(clock + 1, Date.now());
        draft.folder = "sentitems";
        draft.sent = new Date(clock).toISOString();
        return new Response(null, { status: 202 });
      }
      return json({ error: { code: "BadRequest" } }, 400);
    }) as typeof fetch,
  };
  return fake;
}
