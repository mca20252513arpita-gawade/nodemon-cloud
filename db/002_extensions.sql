-- Run once against the existing database:  psql "<conn string>" -f db/002_extensions.sql
ALTER TABLE zones  ADD COLUMN IF NOT EXISTS last_heartbeat   timestamptz;
ALTER TABLE zones  ADD COLUMN IF NOT EXISTS gateway_online   boolean NOT NULL DEFAULT false;
ALTER TABLE assets ADD COLUMN IF NOT EXISTS last_seen        timestamptz;
ALTER TABLE assets ADD COLUMN IF NOT EXISTS last_seen_passive timestamptz;   -- updated on every heartbeat; last_seen only on entry/exit
ALTER TABLE assets ADD COLUMN IF NOT EXISTS checked_out      boolean NOT NULL DEFAULT false;
CREATE INDEX IF NOT EXISTS idx_events_time         ON events (created_at DESC);
CREATE INDEX IF NOT EXISTS idx_events_anomaly_time ON events (created_at DESC) WHERE is_anomaly;
CREATE INDEX IF NOT EXISTS idx_checkouts_window    ON authorized_checkouts (asset_id, valid_from, valid_until);

-- One-time data fix: gateways that never sent a message should start offline.
UPDATE zones SET gateway_online = false WHERE last_heartbeat IS NULL;
