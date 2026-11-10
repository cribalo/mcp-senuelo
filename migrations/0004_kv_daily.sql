-- Small key/value store: the last /stats.json body ('stats') and how far the daily aggregates go ('daily_through').
CREATE TABLE IF NOT EXISTS kv (
  key        TEXT PRIMARY KEY,
  value      TEXT NOT NULL,
  updated_at TEXT NOT NULL             -- ISO 8601 UTC
);

-- Daily aggregate counts, kept beyond the retention of `events`. Built by the cron in src/daily.ts before the purge.
-- No identifiers: no IP hashes, full User-Agents, purposes or arguments. Our own test traffic is left out
-- (same rule as /stats.json). Small cells are stored, but cells with fewer than 5 visitors are never published
-- (METRICAS.md): `visitors_by_*` rows give the count to check against.
CREATE TABLE IF NOT EXISTS daily (
  day    TEXT    NOT NULL,             -- YYYY-MM-DD (UTC)
  metric TEXT    NOT NULL,             -- e.g. 'requests', 'visitors', 'requests_by_tool', 'visitors_by_country'
  key    TEXT    NOT NULL,             -- e.g. 'mcp', 'total', 'search_documents', 'ES'; '(none)' for NULL
  n      INTEGER NOT NULL,
  PRIMARY KEY (day, metric, key)
);
