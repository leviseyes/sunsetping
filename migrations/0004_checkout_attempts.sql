-- Checkout attempt diagnostics. Do not store IP addresses or email addresses.
-- outcome is one of: session, interstitial, crawler_redirect, fallback_link, placeholder.
CREATE TABLE IF NOT EXISTS checkout_attempts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  plan TEXT,
  outcome TEXT NOT NULL,
  confirm INTEGER NOT NULL DEFAULT 0,
  ua TEXT,
  sec_fetch_mode TEXT,
  sec_fetch_site TEXT,
  sec_fetch_user TEXT,
  sec_fetch_dest TEXT,
  has_accept_language INTEGER,
  referer_host TEXT,
  country TEXT,
  asn INTEGER,
  as_org TEXT,
  session_id_suffix TEXT
);
