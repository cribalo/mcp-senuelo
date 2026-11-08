import { createMcpHandler } from "agents/mcp/server";
import { createServer } from "./tools";
import { renderHome } from "./page";
import { handleDash } from "./dash";

type Row = {
  kind: "mcp" | "http" | "rejected";
  ip_hash: string;
  country: string | null;
  asn: number | null;
  as_org: string | null;
  user_agent: string | null;
  http_method: string;
  path: string;
  status: number | null;
  body_bytes: number;
  protocol_version: string | null;
  rpc_method: string | null;
  rpc_id: string | null;
  client_name: string | null;
  client_version: string | null;
  client_info: string | null;
  tool: string | null;
  args: string | null;
  purpose: string | null;
  note: string | null;
};

const COLUMNS = [
  "ts", "kind", "ip_hash", "country", "asn", "as_org", "user_agent", "http_method", "path", "status",
  "body_bytes", "protocol_version", "rpc_method", "rpc_id", "client_name", "client_version",
  "client_info", "tool", "args", "purpose", "note"
] as const;
const INSERT_SQL = `INSERT INTO events (${COLUMNS.join(", ")}) VALUES (${COLUMNS.map(() => "?").join(", ")})`;

const META_CLIENT_INFO = "io.modelcontextprotocol/clientInfo";
const META_PROTOCOL = "io.modelcontextprotocol/protocolVersion";

// One handler per hostname: the SDK checks Host, and the Worker is reachable both
// on workers.dev and on the custom domain. Cloudflare only routes our own hostnames here.
const handlers = new Map<string, ReturnType<typeof createMcpHandler>>();
function getHandler(hostname: string, env: Env) {
  let h = handlers.get(hostname);
  if (!h) {
    h = createMcpHandler(createServer, {
      route: "/mcp",
      allowedHostnames: [hostname, env.PUBLIC_HOSTNAME],
      // Browsers on other sites must not be able to drive visitors' browsers against /mcp.
      allowedOriginHostnames: [env.PUBLIC_HOSTNAME]
    });
    handlers.set(hostname, h);
  }
  return h;
}

export default {
  async fetch(request, env, ctx): Promise<Response> {
    const url = new URL(request.url);
    const maxBody = Number(env.MAX_BODY_BYTES) || 32768;
    const maxField = Number(env.MAX_FIELD_CHARS) || 2000;
    const ipHash = await hashIp(request.headers.get("cf-connecting-ip") ?? "unknown", env.IP_SALT);
    const base = baseRow(request, url, ipHash);
    const log = (rows: Row[]) => ctx.waitUntil(writeRows(env, rows));

    // Rate limit first; rejected requests are not logged so a flood cannot exhaust D1's daily writes.
    if (env.RATE_LIMITER) {
      try {
        const { success } = await env.RATE_LIMITER.limit({ key: ipHash });
        if (!success) return new Response("Too many requests\n", { status: 429, headers: { "retry-after": "60" } });
      } catch {
        // Binding unavailable: fail open, the plan's own daily limits still apply.
      }
    }

    const body = await readCapped(request, maxBody);
    // Private dashboard: never logged, so the owner's own browsing does not pollute the data.
    if (url.pathname === "/dash" || url.pathname.startsWith("/dash/")) {
      if (body === null) return new Response("Payload too large\n", { status: 413 });
      return handleDash(request, url, env, body);
    }
    if (body === null) {
      log([{ ...base, kind: "rejected", status: 413, note: `body > ${maxBody} bytes` }]);
      return new Response("Payload too large\n", { status: 413 });
    }
    base.body_bytes = new TextEncoder().encode(body).length;

    if (url.pathname === "/mcp") {
      const hasBody = !["GET", "HEAD"].includes(request.method);
      const forwarded = new Request(request.url, {
        method: request.method,
        headers: request.headers,
        body: hasBody ? body : undefined
      });
      let response: Response;
      try {
        response = await getHandler(url.hostname, env)(forwarded, env, ctx);
      } catch (err) {
        log([{ ...base, status: 500, note: truncate(String(err), 300) }]);
        return new Response("Internal error\n", { status: 500 });
      }
      log(rowsFromMcpBody(body, { ...base, status: response.status }, maxField));
      return response;
    }

    let response: Response;
    if (url.pathname === "/" && (request.method === "GET" || request.method === "HEAD")) {
      response = new Response(renderHome(env.CONTACT, Number(env.RETENTION_DAYS) || 90), {
        headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" }
      });
    } else if (url.pathname === "/robots.txt") {
      response = new Response("User-agent: *\nAllow: /\n", { headers: { "content-type": "text/plain" } });
    } else {
      response = new Response("Not found\n", { status: 404 });
    }
    // Scanner paths are interesting; their bodies are not, beyond their size.
    log([{ ...base, kind: "http", status: response.status }]);
    return response;
  },

  async scheduled(_controller, env): Promise<void> {
    const days = Number(env.RETENTION_DAYS) || 90;
    await env.DB.prepare(
      "DELETE FROM events WHERE ts < strftime('%Y-%m-%dT%H:%M:%fZ', 'now', ?)"
    ).bind(`-${days} days`).run();
  }
} satisfies ExportedHandler<Env>;

function baseRow(request: Request, url: URL, ipHash: string): Row {
  const cf = (request.cf ?? {}) as { country?: string; asn?: number; asOrganization?: string };
  return {
    kind: "mcp",
    ip_hash: ipHash,
    country: cf.country ?? null,
    asn: typeof cf.asn === "number" ? cf.asn : null,
    as_org: cf.asOrganization ? truncate(cf.asOrganization, 200) : null,
    user_agent: truncateOrNull(request.headers.get("user-agent"), 500),
    http_method: request.method,
    path: truncate(url.pathname, 300),
    status: null,
    body_bytes: 0,
    protocol_version: truncateOrNull(request.headers.get("mcp-protocol-version"), 50),
    rpc_method: null,
    rpc_id: null,
    client_name: null,
    client_version: null,
    client_info: null,
    tool: null,
    args: null,
    purpose: null,
    note: null
  };
}

function rowsFromMcpBody(body: string, base: Row, maxField: number): Row[] {
  if (!body) return [base];
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    return [{ ...base, note: "invalid JSON", args: truncate(body, maxField) }];
  }
  const messages = Array.isArray(parsed) ? parsed : [parsed];
  return messages.slice(0, 20).map((m) => rowFromMessage(m, base, maxField));
}

function rowFromMessage(msg: unknown, base: Row, maxField: number): Row {
  if (!msg || typeof msg !== "object") return { ...base, note: "non-object message" };
  const m = msg as { method?: unknown; id?: unknown; params?: Record<string, unknown> };
  const params = (m.params && typeof m.params === "object" ? m.params : {}) as Record<string, any>;
  const meta = (params._meta && typeof params._meta === "object" ? params._meta : {}) as Record<string, any>;
  const clientInfo = params.clientInfo ?? meta[META_CLIENT_INFO];
  const row: Row = {
    ...base,
    rpc_method: typeof m.method === "string" ? truncate(m.method, 100) : "(response)",
    rpc_id: m.id === undefined || m.id === null ? null : truncate(String(m.id), 100),
    protocol_version:
      truncateOrNull(asString(params.protocolVersion ?? meta[META_PROTOCOL]), 50) ?? base.protocol_version
  };
  if (clientInfo && typeof clientInfo === "object") {
    row.client_name = truncateOrNull(asString(clientInfo.name), 200);
    row.client_version = truncateOrNull(asString(clientInfo.version), 100);
    row.client_info = truncate(JSON.stringify(clientInfo), maxField);
  }
  if (m.method === "tools/call") {
    row.tool = truncateOrNull(asString(params.name), 100);
    const args = { ...(params.arguments && typeof params.arguments === "object" ? params.arguments : {}) };
    row.purpose = truncateOrNull(asString(args.purpose), maxField);
    delete args.purpose;
    row.args = truncate(JSON.stringify(args), maxField);
  } else if (typeof m.method === "string" && m.method !== "initialize") {
    const { _meta, ...rest } = params;
    if (Object.keys(rest).length) row.args = truncate(JSON.stringify(rest), maxField);
  }
  return row;
}

async function writeRows(env: Env, rows: Row[]): Promise<void> {
  if (!rows.length) return;
  const ts = new Date().toISOString();
  const stmt = env.DB.prepare(INSERT_SQL);
  try {
    await env.DB.batch(rows.map((r) => stmt.bind(ts, ...COLUMNS.slice(1).map((c) => r[c as keyof Row]))));
  } catch (err) {
    console.error("log write failed", String(err));
  }
}

// Reads at most `max` bytes; returns null if the body is larger (declared or actual).
async function readCapped(request: Request, max: number): Promise<string | null> {
  const declared = Number(request.headers.get("content-length"));
  if (declared > max) return null;
  if (!request.body) return "";
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > max) {
      await reader.cancel();
      return null;
    }
    chunks.push(value);
  }
  const buf = new Uint8Array(total);
  let off = 0;
  for (const c of chunks) {
    buf.set(c, off);
    off += c.byteLength;
  }
  return new TextDecoder().decode(buf);
}

// Without a secret salt an IPv4 hash is trivially reversible, so store nothing.
async function hashIp(ip: string, salt: string | undefined): Promise<string> {
  if (!salt) return "no-salt";
  const key = await crypto.subtle.importKey(
    "raw", new TextEncoder().encode(salt), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]
  );
  const sig = new Uint8Array(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(ip)));
  return [...sig.slice(0, 8)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

function asString(v: unknown): string | null {
  return typeof v === "string" ? v : null;
}
function truncate(s: string, n: number): string {
  return s.length > n ? s.slice(0, n) + "…" : s;
}
function truncateOrNull(s: string | null | undefined, n: number): string | null {
  return s == null ? null : truncate(s, n);
}
