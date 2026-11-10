// Test for the daily aggregates (src/daily.ts) and the purge that follows them, against a LOCAL `wrangler dev`
// started with --test-scheduled (`npm run dev`). It wipes the local `daily` table and kv['daily_through'].
// Usage: node scripts/daily-test.mjs [http://127.0.0.1:8787]
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";

const base = process.argv.find((a) => a.startsWith("http")) ?? "http://127.0.0.1:8787";
if (!/^http:\/\/(127\.0\.0\.1|localhost)/.test(base)) throw new Error("local only: this test deletes aggregates");

function sql(command) {
  const out = execFileSync("npx", ["wrangler", "d1", "execute", "mcp-senuelo", "--local", "--json", "--command", command],
    { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
  return JSON.parse(out)[0].results;
}
const scheduled = async () => {
  const res = await fetch(`${base}/__scheduled?cron=17+3+*+*+*`, { headers: { "user-agent": "senuelo-daily-test" } });
  assert.equal(res.status, 200, "is wrangler dev running with --test-scheduled?");
};
let passed = 0;
function check(name, fn) {
  try {
    fn();
    passed++;
    console.log(`ok   ${name}`);
  } catch (err) {
    console.error(`FAIL ${name}\n     ${err.message}`);
    process.exitCode = 1;
  }
}

const DAY_MS = 86_400_000;
// 95 days ago: older than the 90-day retention, so the purge must delete these rows once they are aggregated.
const day = new Date(Date.now() - 95 * DAY_MS).toISOString().slice(0, 10);
const yesterday = new Date(Date.now() - DAY_MS).toISOString().slice(0, 10);
const at = (h) => `${day}T${String(h).padStart(2, "0")}:00:00.000Z`;

// Synthetic rows. A, B and E are third parties; C (User-Agent senuelo-*) and D (purpose test-*) are ours.
const rows = [
  // ts, kind, ip_hash, ua, country, as_org, method, path, status, rpc_method, client_name, protocol, tool, purpose, note, redactions
  [at(1), "mcp", "aaaa", "agent-x/1", "ES", "Org A", "POST", "/mcp", 200, "initialize", "Cursor", "2025-06-18", null, null, null, null],
  [at(2), "mcp", "aaaa", "agent-x/1", "ES", "Org A", "POST", "/mcp", 200, "tools/call", null, null, "search_documents", "find docs", "canary:abcdefghijkl", "email,api_key"],
  [at(3), "http", "bbbb", "curl/8", "US", "Org B", "GET", "/.env", 404, null, null, null, null, null, null, null],
  [at(4), "http", "bbbb", "curl/8", "US", "Org B", "GET", "/", 200, null, null, null, null, null, null, null],
  [at(5), "mcp", "cccc", "senuelo-test", "ES", "Org C", "POST", "/mcp", 200, "tools/call", null, null, "search_documents", "x", "canary:ownownownown", null],
  [at(6), "mcp", "dddd", "python", "FR", "Org D", "POST", "/mcp", 200, "tools/call", null, null, "read_file", "test-run", null, null],
  [at(7), "http", "dddd", "python", "FR", "Org D", "GET", "/robots.txt", 200, null, null, null, null, null, null, null],
  [at(8), "http", "eeee", "fetcher", "DE", null, "GET", "/c/abcdefghijkl", 200, null, null, null, null, null, "canary-hit", null],
  [at(9), "http", "eeee", "fetcher", "DE", null, "GET", "/c/ownownownown", 200, null, null, null, null, null, "canary-hit", null]
];
const lit = (v) => (v === null ? "NULL" : typeof v === "number" ? String(v) : `'${String(v).replace(/'/g, "''")}'`);
sql(`DELETE FROM daily; DELETE FROM kv WHERE key = 'daily_through'; DELETE FROM events WHERE ts >= '${day}' AND ts < '${day}T99';
INSERT INTO events (ts, kind, ip_hash, user_agent, country, as_org, http_method, path, status, rpc_method, client_name,
  protocol_version, tool, purpose, note, redactions) VALUES ${rows.map((r) => `(${r.map(lit).join(", ")})`).join(",\n")}`);

// Ten days per run: loop until the aggregates reach yesterday.
for (let i = 0; i < 20; i++) {
  await scheduled();
  const t = sql("SELECT value FROM kv WHERE key = 'daily_through'")[0]?.value;
  if (t === yesterday) break;
}
check("the aggregates reach yesterday", () => {
  assert.equal(sql("SELECT value FROM kv WHERE key = 'daily_through'")[0]?.value, yesterday);
});

const cells = Object.fromEntries(sql(`SELECT metric || '/' || key AS k, n FROM daily WHERE day = '${day}'`).map((r) => [r.k, r.n]));
const expected = {
  "requests/total": 6, "visitors/total": 3,
  "requests/mcp": 2, "requests/http": 4, "visitors/mcp": 1, "visitors/http": 2, "visitors/tools_call": 1,
  "requests_by_rpc_method/mcp:initialize": 1, "requests_by_rpc_method/mcp:tools/call": 1,
  "requests_by_tool/mcp:search_documents": 1,
  "requests_by_client_name/cursor": 1, "visitors_by_client_name/cursor": 1,
  "visitors_by_protocol_version/mcp:2025-06-18": 1,
  "visitors_by_country/ES": 1, "visitors_by_country/US": 1, "visitors_by_country/DE": 1,
  "visitors_by_as_org/Org A": 1, "visitors_by_as_org/(none)": 1,
  "requests_by_path_class/mcp": 2, "requests_by_path_class/other-404": 1, "requests_by_path_class/home": 1,
  "requests_by_path_class/canary": 2,
  "requests_by_redaction/email": 1, "requests_by_redaction/api_key": 1,
  "canary/issued": 1, "canary/hit": 1, "canary/links_followed": 1
};
check("one day of synthetic rows gives the expected counts", () => {
  for (const [k, n] of Object.entries(expected)) assert.equal(cells[k], n, k);
});
check("our own visitors leave no trace", () => {
  assert.equal(cells["visitors_by_country/FR"], undefined, "visitor with purpose test-* counted");
  assert.equal(cells["requests_by_tool/mcp:read_file"], undefined, "visitor with purpose test-* counted");
  assert.equal(cells["visitors_by_as_org/Org C"], undefined, "senuelo-* counted");
});
check("no identifiers are stored", () => {
  const keys = sql("SELECT DISTINCT key FROM daily").map((r) => r.key);
  for (const bad of ["aaaa", "agent-x/1", "find docs", "abcdefghijkl"]) assert.ok(!keys.some((k) => k.includes(bad)), bad);
});
check("the purge deleted the aggregated rows older than the retention", () => {
  assert.equal(sql(`SELECT COUNT(*) AS n FROM events WHERE ts >= '${day}' AND ts < '${day}T99'`)[0].n, 0);
});

const before = sql("SELECT COUNT(*) AS n, SUM(n) AS s FROM daily")[0];
await scheduled();
check("running the cron again duplicates nothing", () => {
  assert.deepEqual(sql("SELECT COUNT(*) AS n, SUM(n) AS s FROM daily")[0], before);
});

// A real day still in `events`: the stored total must match a direct count with the same own-traffic rule.
const recent = sql(`SELECT substr(MIN(ts), 1, 10) AS d FROM events`)[0]?.d;
if (recent && recent <= yesterday) {
  const V = "ip_hash || '|' || COALESCE(user_agent, '')";
  const direct = sql(`SELECT COUNT(*) AS r, COUNT(DISTINCT ${V}) AS v FROM events WHERE ts >= '${recent}' AND ts < '${recent}T99'
    AND ${V} NOT IN (SELECT ${V} FROM events WHERE ts >= '${recent}' AND ts < '${recent}T99' AND (COALESCE(user_agent, '') LIKE 'senuelo-%'
      OR COALESCE(purpose, '') LIKE 'test-%' OR COALESCE(client_version, '') LIKE 'test-%'))`)[0];
  const stored = Object.fromEntries(sql(`SELECT metric, n FROM daily WHERE day = '${recent}' AND key = 'total'`).map((r) => [r.metric, r.n]));
  check(`${recent}: stored totals match a direct count`, () => {
    assert.equal(stored.requests, direct.r);
    assert.equal(stored.visitors, direct.v);
  });
}
console.log(`${passed} checks passed`);
