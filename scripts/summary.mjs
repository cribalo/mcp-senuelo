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
    "Clientes MCP",
    `${EV} SELECT client, max(client_version) AS version, count(*) AS msgs, sum(tool IS NOT NULL) AS tool_calls,
       count(DISTINCT ip_hash) AS ips, min(ts) AS first, max(ts) AS last
     FROM ev WHERE kind = 'mcp' GROUP BY client ORDER BY msgs DESC LIMIT ${limit}`
  ],
  [
    "Métodos MCP",
    `${EV} SELECT rpc_method, count(*) AS n, count(DISTINCT client) AS clients FROM ev WHERE kind = 'mcp'
     GROUP BY rpc_method ORDER BY n DESC LIMIT ${limit}`
  ],
  [
    "Herramientas por cliente",
    `${EV} SELECT tool, client, count(*) AS calls, count(DISTINCT purpose) AS purposes, sum(purpose IS NULL) AS no_purpose
     FROM ev WHERE tool IS NOT NULL GROUP BY tool, client ORDER BY calls DESC LIMIT ${limit}`
  ],
  [
    "Purposes declarados",
    `${EV} SELECT tool, client, substr(purpose, 1, 120) AS purpose, count(*) AS n FROM ev
     WHERE purpose IS NOT NULL GROUP BY tool, client, purpose ORDER BY n DESC LIMIT ${limit}`
  ],
  [
    "Rutas no MCP (escáneres)",
    `${EV} SELECT path, http_method, count(*) AS n, count(DISTINCT ip_hash) AS ips, count(DISTINCT user_agent) AS uas
     FROM ev WHERE kind <> 'mcp' GROUP BY path, http_method ORDER BY n DESC LIMIT ${limit}`
  ],
  [
    "Origen (país y red)",
    `${EV} SELECT country, as_org, count(*) AS n, count(DISTINCT ip_hash) AS ips FROM ev
     GROUP BY country, as_org ORDER BY n DESC LIMIT 20`
  ]
];

console.log(`Registro ${where === "--remote" ? "remoto" : "local"}, últimos ${days} días\n`);
for (const [title, sql] of sections) {
  const out = execFileSync(
    "npx",
    ["wrangler", "d1", "execute", "mcp-senuelo", where, "--json", "--command", sql.replace(/\s+/g, " ")],
    { encoding: "utf8", stdio: ["ignore", "pipe", "inherit"] }
  );
  const rows = JSON.parse(out)[0]?.results ?? [];
  console.log(`## ${title}`);
  rows.length ? console.table(rows) : console.log("(sin filas)\n");
}
