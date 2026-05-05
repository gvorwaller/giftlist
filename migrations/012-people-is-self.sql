-- Add `is_self` flag to people so personal (non-gift) orders can be tracked
-- alongside gifts without polluting the gift-manager flows. See td-24eac3
-- and docs/devlog/2026-05-04.md for context: after the Shippo integration
-- landed Gaylon started using the app as one-stop-shop package tracking, so
-- we need a way to surface "my own orders" on /app/packages while hiding
-- them from /app/today, /app/people, and reminder digests.

ALTER TABLE people
  ADD COLUMN is_self INTEGER NOT NULL DEFAULT 0 CHECK (is_self IN (0, 1));

CREATE INDEX idx_people_is_self ON people (is_self);
