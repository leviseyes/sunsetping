-- Stripe customer linkage and a processed-event log so webhooks are idempotent.
ALTER TABLE subscribers ADD COLUMN stripe_customer_id TEXT;
ALTER TABLE subscribers ADD COLUMN stripe_subscription_id TEXT;

CREATE UNIQUE INDEX IF NOT EXISTS idx_subscribers_stripe_customer
  ON subscribers(stripe_customer_id) WHERE stripe_customer_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_subscribers_stripe_subscription
  ON subscribers(stripe_subscription_id);

CREATE TABLE IF NOT EXISTS stripe_events (
  id TEXT PRIMARY KEY,
  type TEXT NOT NULL,
  received_at TEXT NOT NULL DEFAULT (datetime('now'))
);
