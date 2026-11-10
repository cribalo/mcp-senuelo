// Public aggregate figures (GET /stats.json): totals only, no IP hashes, user agents, arguments or texts.
// The body is cached at the edge for CACHE_SECONDS per data centre and, behind that, in D1 (kv['stats']), so the
// full scans of `events` run at most about once per CACHE_SECONDS in total, not once per data centre.
// Requests to it are not logged.
import { OWN_ROW, VISITOR } from "./own.ts"; // with .ts so Node can import this module in scripts/stats-test.mjs
const CACHE_SECONDS = 300;
const CACHE_KEY = "https://stats.internal/mcp-senuelo/v1";

const A2A_SEND = "('SendMessage','message/send','SendStreamingMessage','message/stream')";

const SQL = `WITH own AS (SELECT DISTINCT ${VISITOR} AS v FROM events WHERE ${OWN_ROW}),
e AS (SELECT * FROM events WHERE kind <> 'rejected' AND ${VISITOR} NOT IN (SELECT v FROM own))
SELECT
  MIN(ts) AS since,
  MAX(ts) AS last_event,
  COUNT(*) AS requests,
  COUNT(DISTINCT ${VISITOR}) AS visitors,
  COUNT(DISTINCT CASE WHEN kind = 'mcp' THEN ${VISITOR} END) AS mcp_visitors,
  COUNT(DISTINCT LOWER(client_name)) AS mcp_clients,
  COUNT(DISTINCT CASE WHEN rpc_method = 'tools/call' THEN ${VISITOR} END) AS tool_visitors,
  SUM(rpc_method = 'tools/call') AS tool_calls,
  SUM(rpc_method = 'tools/call' AND purpose IS NOT NULL AND TRIM(purpose) <> '') AS tool_calls_with_purpose,
  COUNT(DISTINCT CASE WHEN kind = 'a2a' THEN ${VISITOR} END) AS a2a_visitors,
  SUM(kind = 'a2a' AND rpc_method IN ${A2A_SEND} AND purpose IS NOT NULL) AS a2a_messages,
  COUNT(DISTINCT CASE WHEN note = 'canary-hit' AND NOT EXISTS (
    SELECT 1 FROM events i WHERE i.note LIKE '%canary:' || substr(e.path, 4, 12) || '%'
      AND i.ip_hash || '|' || COALESCE(i.user_agent, '') IN (SELECT v FROM own)) THEN path END) AS canary_links_followed
FROM e`;

export type Stats = {
  source: string;
  generated_at: string;
  window_days: number;
  since: string | null;
  last_event: string | null;
  totals: Record<string, number>;
  definitions: Record<string, string>;
};

const DEFINITIONS: Record<string, string> = {
  scope: "all figures leave out our own test traffic: any visitor with a request whose User-Agent starts with " +
    "'senuelo-', or whose purpose or client version starts with 'test-', plus visits to canary links issued to them",
  visitor: "one (hashed IP address, User-Agent) pair",
  mcp_clients: "distinct MCP clientInfo.name values declared in initialize",
  tool_visitors: "visitors that called tools/call at least once, with any arguments",
  tool_calls_with_purpose: "tools/call requests whose required free-text purpose was not empty",
  a2a_messages: "A2A messages with text",
  canary_links_followed: "distinct links that only existed inside a tool or agent result and were later visited"
};

async function compute(env: Env): Promise<Stats> {
  const row = (await env.DB.prepare(SQL).first<Record<string, number | string | null>>()) ?? {};
  const totals: Record<string, number> = {};
  for (const k of ["requests", "visitors", "mcp_visitors", "mcp_clients", "tool_visitors", "tool_calls", "tool_calls_with_purpose",
    "a2a_visitors", "a2a_messages", "canary_links_followed"]) totals[k] = Number(row[k] ?? 0) || 0;
  return {
    source: `https://${env.PUBLIC_HOSTNAME}/`,
    generated_at: new Date().toISOString(),
    window_days: Number(env.RETENTION_DAYS) || 90,
    since: typeof row.since === "string" ? row.since : null,
    last_event: typeof row.last_event === "string" ? row.last_event : null,
    totals,
    definitions: DEFINITIONS
  };
}

const headers = {
  "content-type": "application/json; charset=utf-8",
  "cache-control": `public, max-age=${CACHE_SECONDS}`,
  "access-control-allow-origin": "*",
  "x-content-type-options": "nosniff"
};

// Serves kv['stats'] while it is younger than CACHE_SECONDS; otherwise recomputes and stores it.
// Exported for scripts/stats-test.mjs, which counts how often compute runs.
export async function statsBody(env: Env, now = Date.now(), recompute: (env: Env) => Promise<Stats> = compute): Promise<string> {
  try {
    const saved = await env.DB.prepare("SELECT value, updated_at FROM kv WHERE key = 'stats'")
      .first<{ value: string; updated_at: string }>();
    if (saved && now - Date.parse(saved.updated_at) < CACHE_SECONDS * 1000) return saved.value;
  } catch {
    // Table missing (migration not applied yet) or D1 hiccup: fall through and compute.
  }
  const stats = await recompute(env);
  const body = JSON.stringify(stats, null, 2);
  try {
    await env.DB.prepare(
      "INSERT INTO kv (key, value, updated_at) VALUES ('stats', ?, ?) " +
      "ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at"
    ).bind(body, new Date(now).toISOString()).run();
  } catch {
    // Not stored: the next miss computes again. The answer itself is still good.
  }
  return body;
}

export async function handleStats(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
  if (request.method !== "GET" && request.method !== "HEAD") {
    return new Response("Method not allowed\n", { status: 405, headers: { allow: "GET, HEAD" } });
  }
  const cache = (globalThis as { caches?: { default?: Cache } }).caches?.default;
  const key = new Request(CACHE_KEY);
  const hit = cache ? await cache.match(key) : undefined;
  if (hit) return request.method === "HEAD" ? new Response(null, { headers: hit.headers }) : hit;
  let body: string;
  try {
    body = await statsBody(env);
  } catch {
    return new Response(JSON.stringify({ error: "stats unavailable" }), { status: 503, headers: { ...headers, "cache-control": "no-store" } });
  }
  const res = new Response(body, { headers });
  if (cache) ctx.waitUntil(cache.put(key, res.clone()));
  return request.method === "HEAD" ? new Response(null, { headers }) : res;
}
