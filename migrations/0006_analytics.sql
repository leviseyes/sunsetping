-- Daily first-party counts. No cookies, IPs, emails, or user ids.
-- day is YYYY-MM-DD in America/Los_Angeles. Writes upsert count = count + 1.
CREATE TABLE IF NOT EXISTS analytics_daily (
  day TEXT NOT NULL /* YYYY-MM-DD in America/Los_Angeles */,
  path TEXT NOT NULL,
  event TEXT NOT NULL,
  form TEXT NOT NULL DEFAULT '',
  referrer_host TEXT NOT NULL DEFAULT '',
  count INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY(day, path, event, form, referrer_host)
);

-- Where a new subscriber signed up. Nullable so existing rows and old pages stay valid.
ALTER TABLE subscribers ADD COLUMN signup_path TEXT;
ALTER TABLE subscribers ADD COLUMN signup_form TEXT;
