-- td-61017c: non-Amazon shipment-email auto-import.
--
-- 1) Widen the CHECK on import_runs.source to allow a second pipeline
--    ('tracking_email') alongside the existing 'amazon_email'.
-- 2) Widen the CHECK on import_rows.email_type to allow 'tracking_only',
--    a new variant for plain shipment-confirmation emails that don't carry
--    Amazon's order_placed/shipped/delivered lifecycle.
-- 3) Add import_rows.parsed_sender_domain so the commit path can
--    constrain the order_id-match step (sender/vendor agreement) and
--    avoid binding unrelated gifts that happen to share a short order#.
-- 4) Seed shippers DHL, OnTrac, Lasership with their canonical Shippo
--    carrier slugs. Without these rows, registerWithProvider() falls back
--    to slug 'usps' (tracking.ts:124) which would mis-register non-USPS
--    self-packages. Amazon Logistics deliberately not seeded — Shippo's
--    public carrier list has no documented slug for it, and Amazon-routed
--    emails arrive via the existing Giftlist/Amazon/* pipeline regardless.
--
-- SQLite has no ALTER TABLE DROP CONSTRAINT, so we use the official
-- "recreate table" pattern. Migration runner (src/lib/server/migrate.ts)
-- toggles foreign_keys OFF before BEGIN and runs PRAGMA foreign_key_check
-- after COMMIT to validate the rebuild left no orphans behind.

-- ---------------------------------------------------------------------
-- import_rows: rebuild with widened email_type CHECK + new column.
-- Rebuild children FIRST so the FK reference to import_runs(id) is still
-- pointing at the original (about-to-be-rebuilt) parent table during
-- INSERT. With foreign_keys OFF the order is academic, but it keeps the
-- intent of the 12-step pattern clear.

CREATE TABLE import_rows_new (
  id                      INTEGER PRIMARY KEY AUTOINCREMENT,
  import_run_id           INTEGER NOT NULL REFERENCES import_runs(id) ON DELETE CASCADE,
  source_message_id       TEXT NOT NULL,
  source_thread_id        TEXT,
  subject                 TEXT,
  received_at             TEXT,
  from_address            TEXT,
  email_type              TEXT NOT NULL CHECK (email_type IN (
                            'order_placed', 'shipped', 'delivered',
                            'marketing', 'review_request', 'unknown',
                            'tracking_only'
                          )),
  parsed_title            TEXT,
  parsed_order_id         TEXT,
  parsed_price_cents      INTEGER,
  parsed_tracking_number  TEXT,
  parsed_carrier          TEXT,
  parsed_recipient_name   TEXT,
  parsed_shipping_address TEXT,
  parsed_gift_message     TEXT,
  parsed_sender_domain    TEXT,
  match_person_id         INTEGER REFERENCES people(id) ON DELETE SET NULL,
  match_confidence        TEXT CHECK (match_confidence IN ('exact', 'alias', 'fuzzy', 'none', NULL)),
  match_candidates_json   TEXT,
  disposition             TEXT NOT NULL DEFAULT 'pending' CHECK (disposition IN (
                            'pending', 'accepted', 'skipped', 'failed'
                          )),
  gift_id                 INTEGER REFERENCES gifts(id) ON DELETE SET NULL,
  error_message           TEXT,
  created_at              TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at              TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE (source_message_id)
);

INSERT INTO import_rows_new (
  id, import_run_id, source_message_id, source_thread_id, subject,
  received_at, from_address, email_type, parsed_title, parsed_order_id,
  parsed_price_cents, parsed_tracking_number, parsed_carrier,
  parsed_recipient_name, parsed_shipping_address, parsed_gift_message,
  parsed_sender_domain, match_person_id, match_confidence,
  match_candidates_json, disposition, gift_id, error_message,
  created_at, updated_at
)
SELECT
  id, import_run_id, source_message_id, source_thread_id, subject,
  received_at, from_address, email_type, parsed_title, parsed_order_id,
  parsed_price_cents, parsed_tracking_number, parsed_carrier,
  parsed_recipient_name, parsed_shipping_address, parsed_gift_message,
  NULL AS parsed_sender_domain,
  match_person_id, match_confidence, match_candidates_json,
  disposition, gift_id, error_message, created_at, updated_at
FROM import_rows;

DROP TABLE import_rows;
ALTER TABLE import_rows_new RENAME TO import_rows;

CREATE INDEX idx_import_rows_run ON import_rows (import_run_id);
CREATE INDEX idx_import_rows_disposition ON import_rows (disposition);
CREATE INDEX idx_import_rows_order ON import_rows (parsed_order_id);
CREATE INDEX idx_import_rows_person ON import_rows (match_person_id);

-- ---------------------------------------------------------------------
-- import_runs: rebuild with widened source CHECK.

CREATE TABLE import_runs_new (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  source          TEXT NOT NULL CHECK (source IN ('amazon_email', 'tracking_email')),
  actor_user_id   INTEGER NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  started_at      TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  finished_at     TEXT,
  status          TEXT NOT NULL CHECK (status IN ('running', 'ready_for_review', 'committed', 'error')),
  fetched_count   INTEGER NOT NULL DEFAULT 0,
  parsed_count    INTEGER NOT NULL DEFAULT 0,
  skipped_count   INTEGER NOT NULL DEFAULT 0,
  created_count   INTEGER NOT NULL DEFAULT 0,
  error_message   TEXT
);

INSERT INTO import_runs_new (
  id, source, actor_user_id, started_at, finished_at, status,
  fetched_count, parsed_count, skipped_count, created_count, error_message
)
SELECT
  id, source, actor_user_id, started_at, finished_at, status,
  fetched_count, parsed_count, skipped_count, created_count, error_message
FROM import_runs;

DROP TABLE import_runs;
ALTER TABLE import_runs_new RENAME TO import_runs;

CREATE INDEX idx_import_runs_status ON import_runs (status, started_at DESC);

-- ---------------------------------------------------------------------
-- Seed shippers for non-Amazon carriers we expect to see in tracking
-- emails. Slugs verified against repo doc (src/routes/admin/shippers
-- /+page.svelte:36) and Shippo carrier docs. INSERT OR IGNORE so a
-- pre-existing manual seed (admin added DHL by hand) doesn't break the
-- migration.

INSERT OR IGNORE INTO shippers (name, tracking_provider_slug) VALUES
  ('DHL',       'dhl_express'),
  ('OnTrac',    'ontrac'),
  ('Lasership', 'lasership');
