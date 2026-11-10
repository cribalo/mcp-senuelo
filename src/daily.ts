// Daily aggregate counts that outlive the retention of `events` (table `daily`, migration 0004).
// Run by the cron before the purge. Aggregates every finished UTC day after kv['daily_through'], at most
// MAX_DAYS_PER_RUN per run, and the purge never deletes a day that has not been aggregated yet.
// Stored: counts per day only. No IP hashes, full User-Agents, purposes or arguments.
import { OWN_ROW, VISITOR } from "./own.ts";

// Free plan: 50 D1 queries per invocation. Each day costs 1 read + 3 writes (one batch), so 10 days ≈ 42 queries.
const MAX_DAYS_PER_RUN = 10;
// Long-tail dimensions keep their top TOP keys by visitors; the rest is summed into '(other)'.
const TOP = 200;
const CAPPED = new Set(["client_name", "as_org"]);

const PATH_CLASS = `CASE
  WHEN kind = 'rejected' THEN 'rejected'
  WHEN kind = 'mcp' THEN 'mcp'
  WHEN note = 'agent-card' THEN 'card'
  WHEN kind = 'a2a' THEN 'a2a'
  WHEN path LIKE '/c/%' THEN 'canary'
  WHEN path LIKE '/.well-known/%' THEN 'well-known'
  WHEN path = '/' THEN 'home'
  WHEN status = 404 THEN 'other-404'
  ELSE 'other' END`;

// Dimensions stored as requests_by_<name> and visitors_by_<name>. Protocol versions and methods carry the
// kind ('mcp:', 'a2a:') because both protocols share those columns. A NULL key leaves the row out of that
// dimension; country and network keep such rows as '(none)'.
const DIMENSIONS: [string, string][] = [
  ["rpc_method", "kind || ':' || rpc_method"],
  ["tool", "kind || ':' || tool"],
  ["client_name", "LOWER(client_name)"],
  ["protocol_version", "kind || ':' || protocol_version"],
  ["country", "COALESCE(country, '(none)')"],
  ["as_org", "COALESCE(as_org, '(none)')"],
  ["path_class", PATH_CLASS]
];
// Every grouping in one pass: each row of the day is crossed with the list of groupings. (D1 caps a compound
// SELECT at 5 terms, so a UNION ALL per grouping does not fit.)
const GROUPINGS: [string, string][] = [
  ["kind", "kind"],
  ["total", "'total'"],
  ...DIMENSIONS,
  ["redaction", "redactions"],
  ["canary_issued", "CASE WHEN note LIKE '%canary:%' THEN 'issued' END"],
  // A canary visit is left out when the link was issued to one of our visitors on any day, as in /stats.json.
  ["canary_hit", `CASE WHEN note LIKE 'canary-hit%' AND NOT EXISTS (
    SELECT 1 FROM events i WHERE i.note LIKE '%canary:' || substr(e.path, 4, 12) || '%' AND EXISTS (
      SELECT 1 FROM events j WHERE j.ip_hash = i.ip_hash AND COALESCE(j.user_agent, '') = COALESCE(i.user_agent, '')
        AND ${OWN_ROW})) THEN 'hit' END`]
];

// One UTC day of rows (?1 <= ts < ?2) without our own visitors. Here a visitor counts as ours if it has a
// matching row that same day: scoping it to the day keeps each run to index range scans instead of full scans.
// For canary visits, `v` counts distinct links instead of visitors.
const DAY_SQL = `WITH own AS (SELECT DISTINCT ${VISITOR} AS v FROM events WHERE ts >= ?1 AND ts < ?2 AND ${OWN_ROW}),
e AS (SELECT * FROM events WHERE ts >= ?1 AND ts < ?2 AND ${VISITOR} NOT IN (SELECT v FROM own)),
x AS (SELECT g.name AS d,
  CASE g.name ${GROUPINGS.map(([name, expr]) => `WHEN '${name}' THEN ${expr}`).join("\n    ")} END AS k,
  CASE g.name WHEN 'canary_hit' THEN e.path ELSE ${VISITOR} END AS who
  -- Wrapped in a subquery: json_each's own columns (key, value, path…) would clash with those of events.
  FROM e, (SELECT value AS name FROM json_each('${JSON.stringify(GROUPINGS.map(([name]) => name))}')) g)
SELECT d, k, COUNT(*) AS r, COUNT(DISTINCT who) AS v FROM x WHERE k IS NOT NULL GROUP BY d, k`;

type Agg = { d: string; k: string | null; r: number; v: number };
export type Cell = [metric: string, key: string, n: number];

const DAY_MS = 86_400_000;
export const nextDay = (day: string) => new Date(Date.parse(`${day}T00:00:00Z`) + DAY_MS).toISOString().slice(0, 10);

// Turns the rows of DAY_SQL into (metric, key, n) cells. Exported for scripts/daily-test.mjs.
export function cellsFromAgg(rows: Agg[]): Cell[] {
  const cells: Cell[] = [];
  const byDim = new Map<string, Agg[]>();
  const redactions = new Map<string, number>();
  for (const row of rows) {
    const k = row.k ?? "(none)";
    const r = Number(row.r) || 0;
    const v = Number(row.v) || 0;
    if (row.d === "kind" || row.d === "total") {
      cells.push(["requests", k, r], ["visitors", k, v]);
    } else if (row.d.startsWith("canary_")) {
      cells.push(["canary", k, r]);
      if (k === "hit") cells.push(["canary", "links_followed", v]);
    } else if (row.d === "redaction") {
      // Stored comma-separated per row; count requests per kind.
      for (const kind of k.split(",")) redactions.set(kind, (redactions.get(kind) ?? 0) + r);
    } else {
      if (!byDim.has(row.d)) byDim.set(row.d, []);
      byDim.get(row.d)!.push({ ...row, k, r, v });
    }
  }
  for (const [kind, n] of redactions) cells.push(["requests_by_redaction", kind, n]);
  for (const [dim, list] of byDim) {
    if (dim === "rpc_method") {
      const call = list.find((x) => x.k === "mcp:tools/call");
      cells.push(["visitors", "tools_call", call ? call.v : 0]);
    }
    list.sort((a, b) => b.v - a.v || b.r - a.r || String(a.k).localeCompare(String(b.k)));
    let keep = list;
    if (CAPPED.has(dim) && list.length > TOP) {
      keep = list.slice(0, TOP);
      // '(other)' visitors is a sum over keys, so a visitor with two such keys counts twice there.
      const rest = list.slice(TOP);
      keep.push({ d: dim, k: "(other)", r: rest.reduce((s, x) => s + x.r, 0), v: rest.reduce((s, x) => s + x.v, 0) });
    }
    for (const x of keep) cells.push([`requests_by_${dim}`, x.k!, x.r], [`visitors_by_${dim}`, x.k!, x.v]);
  }
  return cells;
}

// Aggregates the pending days and returns the last day aggregated so far (null if none).
export async function aggregateDaily(env: Env, now = Date.now()): Promise<string | null> {
  const state = await env.DB.prepare(
    "SELECT (SELECT value FROM kv WHERE key = 'daily_through') AS t, (SELECT MAX(day) FROM daily) AS m, " +
    "(SELECT substr(MIN(ts), 1, 10) FROM events) AS f"
  ).first<{ t: string | null; m: string | null; f: string | null }>();
  let through = state?.t ?? state?.m ?? null;
  let day = through ? nextDay(through) : state?.f ?? null;
  const yesterday = new Date(now - DAY_MS).toISOString().slice(0, 10);
  for (let i = 0; day && day <= yesterday && i < MAX_DAYS_PER_RUN; i++, day = nextDay(day)) {
    const { results } = await env.DB.prepare(DAY_SQL).bind(`${day}T00:00:00.000Z`, `${nextDay(day)}T00:00:00.000Z`).all<Agg>();
    const cells = cellsFromAgg(results ?? []);
    await env.DB.batch([
      env.DB.prepare("DELETE FROM daily WHERE day = ?").bind(day),
      env.DB.prepare(
        "INSERT INTO daily (day, metric, key, n) SELECT ?1, json_extract(value, '$[0]'), json_extract(value, '$[1]'), " +
        "json_extract(value, '$[2]') FROM json_each(?2)"
      ).bind(day, JSON.stringify(cells)),
      env.DB.prepare(
        "INSERT INTO kv (key, value, updated_at) VALUES ('daily_through', ?, ?) " +
        "ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at"
      ).bind(day, new Date(now).toISOString())
    ]);
    through = day;
  }
  return through;
}
