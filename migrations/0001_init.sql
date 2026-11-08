-- One row per HTTP request (non-MCP paths) or per JSON-RPC message (/mcp).
CREATE TABLE IF NOT EXISTS events (
  id               INTEGER PRIMARY KEY AUTOINCREMENT,
  ts               TEXT    NOT NULL,              -- ISO 8601 UTC
  kind             TEXT    NOT NULL,              -- 'mcp' | 'http' | 'rejected'
  ip_hash          TEXT,                          -- HMAC-SHA256(IP_SALT, ip), 16 hex chars
  country          TEXT,                          -- request.cf.country
  asn              INTEGER,                       -- request.cf.asn (network, e.g. a cloud provider)
  as_org           TEXT,
  user_agent       TEXT,
  http_method      TEXT,
  path             TEXT,                          -- path only; query string dropped
  status           INTEGER,
  body_bytes       INTEGER,
  protocol_version TEXT,                          -- MCP-Protocol-Version header or _meta
  rpc_method       TEXT,
  rpc_id           TEXT,
  client_name      TEXT,
  client_version   TEXT,
  client_info      TEXT,                          -- JSON, truncated
  tool             TEXT,
  args             TEXT,                          -- JSON without 'purpose', truncated
  purpose          TEXT,                          -- truncated
  note             TEXT                           -- e.g. rejection reason, parse error
);
CREATE INDEX IF NOT EXISTS idx_events_ts ON events(ts);
CREATE INDEX IF NOT EXISTS idx_events_client ON events(client_name);
CREATE INDEX IF NOT EXISTS idx_events_tool ON events(tool);
