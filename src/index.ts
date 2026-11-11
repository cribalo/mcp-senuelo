import { createMcpHandler } from "agents/mcp/server";
import { createServer } from "./tools";
import type { McpServer } from "@modelcontextprotocol/server";
import { homeHeaders, renderHome } from "./page";
import { handleDash } from "./dash";
import { handleStats } from "./stats";
import { aggregateDaily, nextDay } from "./daily";
import { redact } from "./redact";
import { A2A_PATH, CARD_PATHS, cardResponse, handleA2a, taskKey } from "./a2a";
import { CANARY_HEADER, CANARY_PATH_RE, canaryPage, canaryUrl, llmsTxt, newCanaryToken } from "./canary";
import { isMcpEntry } from "./entries";
import { Row, asString, truncate, truncateOrNull, cleanOrNull, joinKinds } from "./log";

const COLUMNS = [
  "ts", "kind", "ip_hash", "country", "asn", "as_org", "user_agent", "http_method", "path", "status",
  "body_bytes", "protocol_version", "rpc_method", "rpc_id", "client_name", "client_version",
  "client_info", "tool", "args", "purpose", "note", "capabilities", "redactions", "context_id", "task_id"
] as const;
const INSERT_SQL = `INSERT INTO events (${COLUMNS.join(", ")}) VALUES (${COLUMNS.map(() => "?").join(", ")})`;

// IndexNow (Bing, Yandex…): public by design, served at /<key>.txt; scripts/indexnow.mjs pings with it.
const INDEXNOW_KEY = "80e3bc40e4522966fb15dd51eece1b7c";

const META_CLIENT_INFO = "io.modelcontextprotocol/clientInfo";
const META_PROTOCOL = "io.modelcontextprotocol/protocolVersion";

export default makeWorker(createServer);

// The lab (src/lab-variant.ts) reuses the same Worker with another set of tools; production uses ./tools.
export function makeWorker(serverFactory: (ctx?: { requestInfo?: Request }) => McpServer) {
  // One handler per hostname: the SDK checks Host, and the Worker is reachable both
  // on workers.dev and on the custom domain. Cloudflare only routes our own hostnames here.
  const handlers = new Map<string, ReturnType<typeof createMcpHandler>>();
  function getHandler(hostname: string, env: Env) {
    let h = handlers.get(hostname);
    if (!h) {
      h = createMcpHandler(serverFactory, {
        route: "/mcp",
        allowedHostnames: [hostname, env.PUBLIC_HOSTNAME],
        // Browsers on other sites must not be able to drive visitors' browsers against /mcp.
        allowedOriginHostnames: [env.PUBLIC_HOSTNAME]
      });
      handlers.set(hostname, h);
    }
    return h;
  }

  return {
  async fetch(request, env, ctx): Promise<Response> {
    const url = new URL(request.url);
    // Plain HTTP on the public hostname goes to HTTPS before anything else, so it is neither rate-limited nor
    // logged (as with the zone setting "Always Use HTTPS"). 308 keeps the method and body of an MCP POST.
    if (url.hostname === env.PUBLIC_HOSTNAME && plainHttp(request)) {
      url.protocol = "https:";
      return Response.redirect(url.href, request.method === "GET" || request.method === "HEAD" ? 301 : 308);
    }
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
    // Public aggregate figures, read by criba.cribalo.com. Not logged: it is polled, not visited.
    if (url.pathname === "/stats.json") return handleStats(request, env, ctx);
    if (body === null) {
      log([{ ...base, kind: "rejected", status: 413, note: `body > ${maxBody} bytes` }]);
      return new Response("Payload too large\n", { status: 413 });
    }
    base.body_bytes = new TextEncoder().encode(body).length;
    // The public host is always served over HTTPS; elsewhere (workers.dev, tests) use the request's origin.
    const origin = url.hostname === env.PUBLIC_HOSTNAME ? `https://${env.PUBLIC_HOSTNAME}` : url.origin;
    const canary = newCanaryToken();

    if (isMcpEntry(url.pathname)) {
      const hasBody = !["GET", "HEAD"].includes(request.method);
      // The tools read the canary link from this header (set here only; a client's own copy is dropped).
      const headers = new Headers(request.headers);
      headers.set(CANARY_HEADER, canaryUrl(origin, canary));
      // The SDK only serves /mcp; the logged path (base.path) keeps the directory entry.
      const target = new URL(request.url);
      target.pathname = "/mcp";
      const forwarded = new Request(target, {
        method: request.method,
        headers,
        body: hasBody ? body : undefined
      });
      let response: Response;
      try {
        response = await getHandler(url.hostname, env)(forwarded, env, ctx);
      } catch (err) {
        log([{ ...base, status: 500, note: truncate(String(err), 300) }]);
        return new Response("Internal error\n", { status: 500 });
      }
      log(rowsFromMcpBody(body, { ...base, status: response.status }, maxField, canary));
      return response;
    }

    if (url.pathname === A2A_PATH) {
      const ctxA2a = { origin, canary, taskKey: await taskKey(env.IP_SALT) };
      const { response, rows } = await handleA2a(request, url, body, base, maxField, ctxA2a);
      log(rows);
      return response;
    }

    let response: Response;
    if (CARD_PATHS.has(url.pathname)) {
      // Logged as 'a2a' so card fetches show up in the A2A funnel.
      response = cardResponse(origin, request.method);
      log([{ ...base, kind: "a2a", status: response.status, note: "agent-card" }]);
      return response;
    }
    if (url.pathname === "/" && (request.method === "GET" || request.method === "HEAD")) {
      response = new Response(renderHome(env.CONTACT, Number(env.RETENTION_DAYS) || 90), { headers: await homeHeaders() });
    } else if (url.pathname === "/robots.txt") {
      response = new Response(`User-agent: *\nAllow: /\n\nSitemap: ${origin}/sitemap.xml\n`, { headers: { "content-type": "text/plain" } });
    } else if (url.pathname === "/sitemap.xml") {
      // Only the public page; canary links (/c/…) must never be indexed or they would count as hits.
      response = new Response(
        `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n` +
        `  <url><loc>${origin}/</loc></url>\n</urlset>\n`,
        { headers: { "content-type": "application/xml; charset=utf-8", "cache-control": "public, max-age=3600" } }
      );
    } else if (url.pathname === `/${INDEXNOW_KEY}.txt`) {
      response = new Response(INDEXNOW_KEY, { headers: { "content-type": "text/plain; charset=utf-8" } });
    } else if (url.pathname === "/llms.txt") {
      response = new Response(llmsTxt(origin, Number(env.RETENTION_DAYS) || 90), {
        headers: { "content-type": "text/plain; charset=utf-8", "cache-control": "public, max-age=300" }
      });
    } else if (CANARY_PATH_RE.test(url.pathname)) {
      // Visit to a link that only appeared inside a synthetic result.
      response = canaryPage();
      log([{ ...base, kind: "http", status: response.status, note: "canary-hit" }]);
      return response;
    } else {
      response = new Response("Not found\n", { status: 404 });
    }
    // Scanner paths are interesting; their bodies are not, beyond their size.
    log([{ ...base, kind: "http", status: response.status }]);
    return response;
  },

  async scheduled(_controller, env): Promise<void> {
    const days = Number(env.RETENTION_DAYS) || 90;
    // Aggregate first (src/daily.ts). The purge then stops at the first day not yet aggregated, so a failed
    // or partial aggregation keeps the rows for the next run instead of losing them.
    let through: string | null = null;
    try {
      through = await aggregateDaily(env);
    } catch (err) {
      console.error("daily aggregation failed", String(err));
      try {
        through = (await env.DB.prepare("SELECT value FROM kv WHERE key = 'daily_through'").first<{ value: string }>())?.value ?? null;
      } catch {
        through = null;
      }
    }
    if (!through) return;
    const retention = new Date(Date.now() - days * 86_400_000).toISOString();
    const aggregated = `${nextDay(through)}T00:00:00.000Z`;
    await env.DB.prepare("DELETE FROM events WHERE ts < ?").bind(retention < aggregated ? retention : aggregated).run();
  }
  } satisfies ExportedHandler<Env>;
}

// Cloudflare says how the visitor connected (cf-visitor, x-forwarded-proto). `wrangler dev` sends neither and
// rewrites the URL to http://<PUBLIC_HOSTNAME>, so local runs (tests, the lab) are never redirected.
function plainHttp(request: Request): boolean {
  return /"scheme"\s*:\s*"http"/.test(request.headers.get("cf-visitor") ?? "") || request.headers.get("x-forwarded-proto") === "http";
}

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
    capabilities: null,
    tool: null,
    args: null,
    purpose: null,
    note: null,
    redactions: null,
    context_id: null,
    task_id: null
  };
}

function rowsFromMcpBody(body: string, base: Row, maxField: number, canary: string): Row[] {
  if (!body) return [base];
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    const hidden = redact(body);
    return [{ ...base, note: "invalid JSON", args: truncate(hidden.text, maxField), redactions: joinKinds(hidden.kinds) }];
  }
  const messages = Array.isArray(parsed) ? parsed : [parsed];
  return messages.slice(0, 20).map((m) => {
    const row = rowFromMessage(m, base, maxField);
    // Only calls that pass schema validation (purpose present) get a result with the link.
    if (row.rpc_method === "tools/call" && row.purpose) row.note = `canary:${canary}`;
    return row;
  });
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
  const kinds = new Set<string>();
  // Redact first, truncate after: a secret cut in half would no longer match its pattern.
  const clean = (v: string): string => {
    const r = redact(v);
    r.kinds.forEach((k) => kinds.add(k));
    return r.text;
  };
  if (clientInfo && typeof clientInfo === "object") {
    row.client_name = truncateOrNull(cleanOrNull(asString(clientInfo.name), clean), 200);
    row.client_version = truncateOrNull(cleanOrNull(asString(clientInfo.version), clean), 100);
    row.client_info = truncate(clean(JSON.stringify(clientInfo)), maxField);
  }
  if (m.method === "initialize" && params.capabilities !== undefined) {
    row.capabilities = truncate(clean(JSON.stringify(params.capabilities)), maxField);
  }
  if (m.method === "tools/call") {
    row.tool = truncateOrNull(asString(params.name), 100);
    const args = { ...(params.arguments && typeof params.arguments === "object" ? params.arguments : {}) };
    row.purpose = truncateOrNull(cleanOrNull(asString(args.purpose), clean), maxField);
    delete args.purpose;
    row.args = truncate(clean(JSON.stringify(args)), maxField);
  } else if (typeof m.method === "string" && m.method !== "initialize") {
    const { _meta, ...rest } = params;
    if (Object.keys(rest).length) row.args = truncate(clean(JSON.stringify(rest)), maxField);
  }
  row.redactions = joinKinds([...kinds]);
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
