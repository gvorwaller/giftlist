-- Rename AfterShip-specific columns to provider-agnostic names so swapping
-- the underlying tracking aggregator (we're moving from AfterShip → Shippo
-- because AfterShip's free tier no longer includes API access) doesn't
-- require another migration. Slugs happen to be identical for the major US
-- carriers (usps, ups, fedex) so existing data stays valid.

-- gifts.aftership_tracking_id → gifts.tracking_provider_id
ALTER TABLE gifts RENAME COLUMN aftership_tracking_id TO tracking_provider_id;
DROP INDEX IF EXISTS idx_gifts_aftership_tracking;
CREATE INDEX idx_gifts_tracking_provider ON gifts (tracking_provider_id);

-- shippers.aftership_slug → shippers.tracking_provider_slug
ALTER TABLE shippers RENAME COLUMN aftership_slug TO tracking_provider_slug;
