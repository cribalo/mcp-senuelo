ALTER TABLE events ADD COLUMN capabilities TEXT;  -- JSON of initialize params.capabilities, truncated
ALTER TABLE events ADD COLUMN redactions TEXT;    -- sorted, comma-separated kinds hidden in this row
