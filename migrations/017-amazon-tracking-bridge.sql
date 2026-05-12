-- td-b221ae: Amazon tracking bridge (email link -> TBA refresh).
--
-- 1) Add gifts.amazon_tracking_url: persists the "Track package" CTA URL
--    parsed from Amazon shipped/delivered emails. Survives import review so
--    the package detail page can offer an "Open Amazon tracking" tap-target
--    even when no carrier tracking number was extractable.
-- 2) Add import_rows.parsed_amazon_tracking_url: parallel staging column on
--    the import-row side. Useful for audit + re-running URL extraction
--    without re-fetching Gmail.
-- 3) Seed an "Amazon Logistics" shipper row with tracking_provider_slug
--    NULL. The Amazon Logistics path is handled by amazon-tracker.ts, not
--    Shippo; the slug being NULL ensures registerWithProvider's USPS
--    fallback (tracking.ts:150) never gets a chance to fire for these.
--    INSERT OR IGNORE so a pre-existing manual seed doesn't break.
--
-- Both columns are nullable, so plain ALTER TABLE is sufficient -- no
-- recreate-table dance required.

ALTER TABLE gifts        ADD COLUMN amazon_tracking_url        TEXT;
ALTER TABLE import_rows  ADD COLUMN parsed_amazon_tracking_url TEXT;

INSERT OR IGNORE INTO shippers (name, tracking_provider_slug) VALUES
  ('Amazon Logistics', NULL);
