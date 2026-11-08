-- A2A (kind = 'a2a'): conversation and task identifiers sent by the client.
-- For A2A rows: purpose = message text, tool = skill id from metadata (if any).
ALTER TABLE events ADD COLUMN context_id TEXT;
ALTER TABLE events ADD COLUMN task_id TEXT;
CREATE INDEX IF NOT EXISTS idx_events_kind_ts ON events(kind, ts);
