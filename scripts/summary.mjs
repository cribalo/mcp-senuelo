// Summarise the D1 log. Usage: node scripts/summary.mjs [--remote] [--days N] [--limit N]
// Reads only; with --remote it uses the account you logged into with `wrangler login`.
import { execFileSync } from "node:child_process";

const args = process.argv.slice(2);
const where = args.includes("--remote") ? "--remote" : "--local";
const opt = (name, dflt) => {
  const i = args.indexOf(name);
  const n = i >= 0 ? Number.parseInt(args[i + 1], 10) : dflt;
  return Number.isFinite(n) && n > 0 ? n : dflt;
};
const days = opt("--days", 30);
const limit = opt("--limit", 40);

// Stateless 2025-era clients send clientInfo only in `initialize`: later rows inherit the
// latest client name seen from the same hashed IP and User-Agent.
const EV = `WITH ev AS (
  SELECT e.*, COALESCE(e.client_name, (
    SELECT i.client_name FROM events i
    WHERE i.ip_hash = e.ip_hash AND i.user_agent IS e.user_agent AND i.client_name IS NOT NULL AND i.ts <= e.ts
    ORDER BY i.ts DESC LIMIT 1), '(unknown)') AS client
  FROM events e
  WHERE e.ts >= strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '-${days} days'))`;

const sections = [
  ["Totales por tipo", `${EV} SELECT kind, count(*) AS n, count(DISTINCT ip_hash) AS ips FROM ev GROUP BY kind ORDER BY n DESC`],
  [
    "Embudo (visitante = ip_hash + user_agent; % sobre visitantes)",
    `${EV}, v AS (SELECT ip_hash, user_agent, count(*) AS any_req, max(coalesce(rpc_method = 'initialize', 0)) AS init,
       max(coalesce(rpc_method = 'tools/list', 0)) AS list, max(coalesce(rpc_method = 'tools/call', 0)) AS call FROM ev GROUP BY ip_hash, user_agent)
     SELECT 'todos' AS grupo, count(*) AS any_req, sum(init) AS initialize, sum(list) AS tools_list, sum(call) AS tools_call,
       round(100.0 * sum(init) / count(*)) AS pct_init, round(100.0 * sum(list) / count(*)) AS pct_list,
       round(100.0 * sum(call) / count(*)) AS pct_call FROM v`
  ],
  [
    "Embudo por cliente declarado (% sobre visitantes)",
    `${EV}, v AS (SELECT ip_hash, user_agent, client, max(coalesce(rpc_method = 'initialize', 0)) AS init,
       max(coalesce(rpc_method = 'tools/list', 0)) AS list, max(coalesce(rpc_method = 'tools/call', 0)) AS call FROM ev GROUP BY ip_hash, user_agent, client)
     SELECT client AS cliente_declarado, count(*) AS any_req, sum(init) AS initialize, sum(list) AS tools_list, sum(call) AS tools_call,
       round(100.0 * sum(init) / count(*)) AS pct_init, round(100.0 * sum(list) / count(*)) AS pct_list,
       round(100.0 * sum(call) / count(*)) AS pct_call
     FROM v GROUP BY client ORDER BY any_req DESC LIMIT ${limit}`
  ],
  [
    "Sesiones (huecos < 30 min por ip_hash + user_agent)",
    `${EV}, g AS (SELECT ip_hash, user_agent, ts, tool, julianday(ts) AS j,
         CASE WHEN julianday(ts) - LAG(julianday(ts)) OVER (PARTITION BY ip_hash, user_agent ORDER BY ts) < 30.0 / 1440
              THEN 0 ELSE 1 END AS new_s FROM ev),
       s AS (SELECT *, sum(new_s) OVER (PARTITION BY ip_hash, user_agent ORDER BY ts ROWS UNBOUNDED PRECEDING) AS sid FROM g),
       t AS (SELECT count(*) AS reqs, (max(j) - min(j)) * 1440 AS minutes, max(tool IS NOT NULL) AS has_call
             FROM s GROUP BY ip_hash, user_agent, sid)
     SELECT count(*) AS sessions, round(avg(reqs), 1) AS avg_reqs, round(avg(minutes), 1) AS avg_minutes,
       sum(has_call) AS sessions_with_tool_call FROM t`
  ],
  [
    "Clientes MCP (cliente declarado)",
    `${EV} SELECT client AS cliente_declarado, max(client_version) AS version, count(*) AS msgs, sum(tool IS NOT NULL) AS tool_calls,
       count(DISTINCT ip_hash) AS ips, min(ts) AS first, max(ts) AS last
     FROM ev WHERE kind = 'mcp' GROUP BY client ORDER BY msgs DESC LIMIT ${limit}`
  ],
  [
    "Métodos MCP",
    `${EV} SELECT rpc_method, count(*) AS n, count(DISTINCT client) AS clientes_declarados FROM ev WHERE kind = 'mcp'
     GROUP BY rpc_method ORDER BY n DESC LIMIT ${limit}`
  ],
  [
    "Herramientas por cliente declarado",
    `${EV} SELECT tool, client AS cliente_declarado, count(*) AS calls, count(DISTINCT purpose) AS purposes, sum(purpose IS NULL) AS no_purpose
     FROM ev WHERE tool IS NOT NULL GROUP BY tool, client ORDER BY calls DESC LIMIT ${limit}`
  ],
  [
    "Purposes declarados",
    `${EV} SELECT tool, client AS cliente_declarado, substr(purpose, 1, 120) AS purpose, count(*) AS n FROM ev
     WHERE purpose IS NOT NULL GROUP BY tool, client, purpose ORDER BY n DESC LIMIT ${limit}`
  ],
  [
    "Capabilities declaradas",
    `${EV} SELECT client AS cliente_declarado, capabilities, count(*) AS n FROM ev WHERE capabilities IS NOT NULL
     GROUP BY client, capabilities ORDER BY n DESC LIMIT ${limit}`
  ],
  [
    "Rutas no MCP (escáneres)",
    `${EV} SELECT path, http_method, count(*) AS n, count(DISTINCT ip_hash) AS ips, count(DISTINCT user_agent) AS uas
     FROM ev WHERE kind <> 'mcp' GROUP BY path, http_method ORDER BY n DESC LIMIT ${limit}`
  ],
  [
    "Escáneres que conocen MCP",
    `${EV} SELECT path, http_method, rpc_method, client AS cliente_declarado, as_org, substr(user_agent, 1, 80) AS user_agent, count(*) AS n
     FROM ev
     WHERE path LIKE '/.well-known/%' OR rpc_method IN ('server/discover', 'initialize')
        OR (path = '/' AND http_method = 'POST') OR (path LIKE '%mcp%' AND path <> '/mcp')
        OR (kind = 'mcp' AND rpc_method IS NULL)
     GROUP BY path, http_method, rpc_method, client, as_org, user_agent ORDER BY n DESC LIMIT ${limit}`
  ],
  [
    "User-Agents más frecuentes",
    `${EV} SELECT substr(user_agent, 1, 100) AS user_agent, count(*) AS n, count(DISTINCT ip_hash) AS ips,
       sum(kind = 'mcp') AS mcp, count(DISTINCT path) AS paths
     FROM ev GROUP BY user_agent ORDER BY n DESC LIMIT ${limit}`
  ],
  [
    "Origen (país y red)",
    `${EV} SELECT country, as_org, count(*) AS n, count(DISTINCT ip_hash) AS ips FROM ev
     GROUP BY country, as_org ORDER BY n DESC LIMIT 20`
  ]
];

// Kinds are comma-separated in one column; split in JS rather than in SQL.
const redactionRows = (rows) => {
  const m = new Map();
  for (const r of rows) for (const kind of r.redactions.split(",")) {
    const k = `${kind}\u0000${r.tool ?? "(no tool)"}`;
    m.set(k, (m.get(k) ?? 0) + r.n);
  }
  return [...m].map(([k, n]) => { const [kind, tool] = k.split("\u0000"); return { kind, tool, n }; })
    .sort((a, b) => b.n - a.n || a.kind.localeCompare(b.kind));
};
const post = { "Datos ocultados": redactionRows };
sections.push([
  "Datos ocultados",
  `${EV} SELECT redactions, tool, count(*) AS n FROM ev WHERE redactions IS NOT NULL GROUP BY redactions, tool`
]);

console.log(`Registro ${where === "--remote" ? "remoto" : "local"}, últimos ${days} días\n`);
for (const [title, sql] of sections) {
  const out = execFileSync(
    "npx",
    ["wrangler", "d1", "execute", "mcp-senuelo", where, "--json", "--command", sql.replace(/\s+/g, " ")],
    { encoding: "utf8", stdio: ["ignore", "pipe", "inherit"] }
  );
  let rows = JSON.parse(out)[0]?.results ?? [];
  if (post[title]) rows = post[title](rows);
  console.log(`## ${title}`);
  rows.length ? console.table(rows) : console.log("(sin filas)\n");
}
