/**
 * A stand-in for a cloudflare_temp_email deployment, as a `fetch` function: the routes the temp-mail provider uses, with the same
 * shapes (rows with numeric ids, SQLite UTC dates, `{ results, count }` pages, `null` for an unknown mail). It answers in the same
 * tick it is called, as a real server sees requests in the order they are sent.
 */
export interface FakeTempMail {
  fetch: typeof fetch;
  /** Mail arriving from outside to an address of the deployment. */
  deliver(to: string, mail: { from: string; subject: string; body: string; at?: number }): void;
  /** Every request made, as `METHOD path`. */
  readonly requests: string[];
  readonly adminPassword: string;
  /** Set to make every send fail as a deployment without a sending method does. */
  sendingOff: boolean;
}

interface Row {
  id: number;
  address: string;
  created_at: string;
}

const sqliteDate = (ms: number) => new Date(ms).toISOString().replace("T", " ").slice(0, 19);

export function createFakeTempMail(options: { domain?: string; adminPassword?: string; sitePassword?: string } = {}): FakeTempMail {
  const domain = options.domain ?? "mail.test";
  const adminPassword = options.adminPassword ?? "admin-pass";
  const tokens = new Map<string, string>();
  const inbox: (Row & { sender: string; subject: string; text: string })[] = [];
  const sendbox: (Row & { raw: string })[] = [];
  let nextId = 1;
  let clock = Date.UTC(2026, 10, 17, 9);
  const requests: string[] = [];
  const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status, headers: { "content-type": "application/json" } });

  const fake: FakeTempMail = {
    requests,
    adminPassword,
    sendingOff: false,
    deliver(to, mail) {
      clock += 1000;
      inbox.push({ id: nextId++, address: to, created_at: sqliteDate(mail.at ?? clock), sender: mail.from, subject: mail.subject, text: mail.body });
    },
    fetch: (async (input: string | URL | Request, init?: RequestInit) => {
      const url = new URL(String(input));
      const method = (init?.method ?? "GET").toUpperCase();
      const headers = new Headers(init?.headers);
      requests.push(`${method} ${url.pathname}`);
      if (options.sitePassword && headers.get("x-custom-auth") !== options.sitePassword) return new Response("site password", { status: 401 });

      if (url.pathname === "/admin/new_address" && method === "POST") {
        if (headers.get("x-admin-auth") !== adminPassword) return new Response("admin", { status: 401 });
        const body = JSON.parse(String(init?.body ?? "{}")) as { name?: string; domain?: string };
        const address = `${body.name}@${body.domain ?? domain}`;
        const token = `jwt-${address}`;
        tokens.set(token, address);
        return json({ address, jwt: token, address_id: tokens.size });
      }

      const address = tokens.get((headers.get("authorization") ?? "").replace(/^Bearer /, ""));
      if (!address) return new Response("token", { status: 401 });
      const limit = Number(url.searchParams.get("limit") ?? "20");
      const offset = Number(url.searchParams.get("offset") ?? "0");
      const pageOf = <T extends Row>(rows: T[]) => {
        const mine = rows.filter((row) => row.address === address).sort((a, b) => b.id - a.id);
        return json({ results: mine.slice(offset, offset + limit), count: mine.length });
      };

      if (url.pathname === "/api/parsed_mails" && method === "GET") return pageOf(inbox.map((row) => ({ ...row, html: "", attachments: [] })));
      const one = /^\/api\/parsed_mail\/(\d+)$/.exec(url.pathname);
      if (one && method === "GET") {
        const row = inbox.find((mail) => mail.id === Number(one[1]) && mail.address === address);
        return json(row ? { ...row, html: "", attachments: [] } : null);
      }
      if (url.pathname === "/api/sendbox" && method === "GET") return pageOf(sendbox);
      if (url.pathname === "/api/send_mail" && method === "POST") {
        if (fake.sendingOff) return new Response("no sending method", { status: 400 });
        const body = JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;
        clock += 1000;
        sendbox.push({ id: nextId++, address, created_at: sqliteDate(clock), raw: JSON.stringify({ version: "v2", ...body }) });
        return json({ status: "ok" });
      }
      return new Response("not found", { status: 404 });
    }) as typeof fetch,
  };
  return fake;
}
