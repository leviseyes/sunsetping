-- Subscribers are in the early-access list for aurora and fog alerts.
-- DEFAULT 1 covers existing rows. Signup does not need to write the column.
ALTER TABLE subscribers ADD COLUMN early_access INTEGER NOT NULL DEFAULT 1;
