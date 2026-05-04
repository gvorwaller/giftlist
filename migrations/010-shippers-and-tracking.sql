-- Per-vendor / per-carrier shipment tracking via AfterShip.
-- Mirrors the vendors lookup pattern: a curated `shippers` table for the
-- carrier dropdown, plus tracking-status fields on gifts populated by the
-- AfterShip integration (registration, scheduled poll, webhook callbacks).
--
-- Legacy `gifts.carrier` text column is kept (deprecated) for one release
-- window so we can roll back without losing the typed value, same approach
-- we used in 009-vendors.sql.

CREATE TABLE shippers (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  name            TEXT NOT NULL,
  -- AfterShip carrier slug (e.g. 'usps', 'ups', 'fedex'). NULL means "let
  -- AfterShip auto-detect from the tracking-number format" — used for the
  -- catch-all "Other" shipper and any niche carriers we don't pre-classify.
  aftership_slug  TEXT,
  is_archived     INTEGER NOT NULL DEFAULT 0 CHECK (is_archived IN (0, 1)),
  created_at      TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at      TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE UNIQUE INDEX idx_shippers_name_nocase ON shippers (name COLLATE NOCASE);
CREATE INDEX idx_shippers_archived ON shippers (is_archived);

-- Seed the four shippers the user explicitly named. "Other" is the
-- catch-all whose tracking entries get auto-detected by AfterShip.
INSERT INTO shippers (name, aftership_slug) VALUES
  ('USPS',  'usps'),
  ('UPS',   'ups'),
  ('FedEx', 'fedex'),
  ('Other', NULL);

-- Backfill: where a gift already has a carrier text value that matches one
-- of the seeded shippers (case-insensitive), pre-link via the new shipper_id
-- column added below.
ALTER TABLE gifts ADD COLUMN shipper_id INTEGER REFERENCES shippers(id) ON DELETE SET NULL;

-- AfterShip-driven status fields. Updated by webhook (preferred) or the
-- scheduled poller. Kept on the gift row itself so reads in the manager UI
-- don't need a join — the shipment_events history table below is for the
-- "show me the journey" detail view.
ALTER TABLE gifts ADD COLUMN tracking_status              TEXT;
ALTER TABLE gifts ADD COLUMN tracking_status_at           TEXT;
ALTER TABLE gifts ADD COLUMN tracking_estimated_delivery  TEXT;
ALTER TABLE gifts ADD COLUMN aftership_tracking_id        TEXT;

CREATE INDEX idx_gifts_shipper ON gifts (shipper_id);
CREATE INDEX idx_gifts_aftership_tracking ON gifts (aftership_tracking_id);

UPDATE gifts
   SET shipper_id = (
         SELECT s.id
           FROM shippers s
          WHERE LOWER(s.name) = LOWER(TRIM(gifts.carrier))
          LIMIT 1
       )
 WHERE carrier IS NOT NULL
   AND TRIM(carrier) != '';

-- Append-only history of carrier status events. Webhook handler inserts
-- one row per checkpoint; the poller dedupes on (gift_id, event_at, status).
CREATE TABLE shipment_events (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  gift_id     INTEGER NOT NULL REFERENCES gifts(id) ON DELETE CASCADE,
  event_at    TEXT NOT NULL,
  status      TEXT,
  message     TEXT,
  location    TEXT,
  raw_json    TEXT,
  created_at  TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE (gift_id, event_at, status)
);

CREATE INDEX idx_shipment_events_gift ON shipment_events (gift_id, event_at DESC);
