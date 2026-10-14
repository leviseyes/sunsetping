-- Pro plan, alert preferences, saved spots, and a send log so the cron does not double-send.
ALTER TABLE subscribers ADD COLUMN plan TEXT NOT NULL DEFAULT 'free' CHECK (plan IN ('free', 'pro'));
ALTER TABLE subscribers ADD COLUMN score_threshold INTEGER CHECK (score_threshold IS NULL OR (score_threshold BETWEEN 1 AND 10));
ALTER TABLE subscribers ADD COLUMN sunrise_alerts INTEGER NOT NULL DEFAULT 0;
ALTER TABLE subscribers ADD COLUMN day_before INTEGER NOT NULL DEFAULT 0;
ALTER TABLE subscribers ADD COLUMN lead_minutes INTEGER NOT NULL DEFAULT 180;

CREATE TABLE IF NOT EXISTS saved_locations (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  subscriber_id INTEGER NOT NULL REFERENCES subscribers(id),
  label TEXT NOT NULL,
  lat REAL NOT NULL,
  lon REAL NOT NULL,
  tz TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_saved_locations_subscriber ON saved_locations(subscriber_id);

CREATE TABLE IF NOT EXISTS alert_sends (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  subscriber_id INTEGER NOT NULL,
  kind TEXT NOT NULL,
  local_date TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (subscriber_id, kind, local_date)
);

CREATE INDEX IF NOT EXISTS idx_subscribers_status ON subscribers(status);
