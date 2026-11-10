// Shared by /stats.json (src/stats.ts) and the daily aggregates (src/daily.ts).

// A visitor is one (hashed IP, User-Agent) pair, as in scripts/summary.mjs.
export const VISITOR = "ip_hash || '|' || COALESCE(user_agent, '')";

// Our own tests, by the rules in METRICAS.md: User-Agent `senuelo-*`, or a purpose or client version that
// starts with `test-`. A visitor with any such row is left out entirely, and so is a canary visit to a link
// that was issued to one of those visitors. User-Agent `node` alone is not a rule: it is Node's default and
// third-party crawlers (glama and others) send it too.
export const OWN_ROW = `(COALESCE(user_agent, '') LIKE 'senuelo-%'
  OR COALESCE(purpose, '') LIKE 'test-%' OR COALESCE(client_version, '') LIKE 'test-%')`;
