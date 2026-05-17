-- td-3d1ee6: tracking-import review queue.
--
-- The tracking importer's accept path currently has three matching clauses
-- (vendor name agreement, source_url INSTR match, self-package owned by
-- actor). When all three fail, it silently falls through and creates a new
-- self-package even though a candidate gift with the same order_id exists
-- in the DB. The user's Sunmed/USPS repro hit this path: an order# match
-- existed but vendor/sender evidence was ambiguous, so a duplicate
-- self-gift was created instead of attaching.
--
-- Fix: widen the disposition CHECK to allow 'review', so the importer can
-- route ambiguous order# matches to a new review queue (manual resolution
-- via the existing /admin/imports/tracking/review/ surface) instead of
-- silently fabricating self-packages.
--
-- SQLite has no ALTER TABLE DROP CONSTRAINT, so use the documented
-- recreate-table pattern. Migration runner (src/lib/server/migrate.ts)
-- toggles foreign_keys OFF before BEGIN and runs PRAGMA foreign_key_check
-- after COMMIT — see runMigrations().

CREATE TABLE import_rows_new (
  id                          INTEGER PRIMARY KEY AUTOINCREMENT,
  import_run_id               INTEGER NOT NULL REFERENCES import_runs(id) ON DELETE CASCADE,
  source_message_id           TEXT NOT NULL,
  source_thread_id            TEXT,
  subject                     TEXT,
  received_at                 TEXT,
  from_address                TEXT,
  email_type                  TEXT NOT NULL CHECK (email_type IN (
                                'order_placed', 'shipped', 'delivered',
                                'marketing', 'review_request', 'unknown',
                                'tracking_only', 'order_confirmation'
                              )),
  parsed_title                TEXT,
  parsed_order_id             TEXT,
  parsed_price_cents          INTEGER,
  parsed_tracking_number      TEXT,
  parsed_carrier              TEXT,
  parsed_recipient_name       TEXT,
  parsed_shipping_address     TEXT,
  parsed_gift_message         TEXT,
  parsed_sender_domain        TEXT,
  parsed_amazon_tracking_url  TEXT,
  parsed_items_json           TEXT,
  match_person_id             INTEGER REFERENCES people(id) ON DELETE SET NULL,
  match_confidence            TEXT CHECK (match_confidence IN ('exact', 'alias', 'fuzzy', 'none', NULL)),
  match_candidates_json       TEXT,
  disposition                 TEXT NOT NULL DEFAULT 'pending' CHECK (disposition IN (
                                'pending', 'accepted', 'skipped', 'failed', 'review'
                              )),
  gift_id                     INTEGER REFERENCES gifts(id) ON DELETE SET NULL,
  error_message               TEXT,
  created_at                  TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at                  TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE (source_message_id)
);

INSERT INTO import_rows_new (
  id, import_run_id, source_message_id, source_thread_id, subject,
  received_at, from_address, email_type, parsed_title, parsed_order_id,
  parsed_price_cents, parsed_tracking_number, parsed_carrier,
  parsed_recipient_name, parsed_shipping_address, parsed_gift_message,
  parsed_sender_domain, parsed_amazon_tracking_url, parsed_items_json,
  match_person_id, match_confidence, match_candidates_json,
  disposition, gift_id, error_message, created_at, updated_at
)
SELECT
  id, import_run_id, source_message_id, source_thread_id, subject,
  received_at, from_address, email_type, parsed_title, parsed_order_id,
  parsed_price_cents, parsed_tracking_number, parsed_carrier,
  parsed_recipient_name, parsed_shipping_address, parsed_gift_message,
  parsed_sender_domain, parsed_amazon_tracking_url, parsed_items_json,
  match_person_id, match_confidence, match_candidates_json,
  disposition, gift_id, error_message, created_at, updated_at
FROM import_rows;

DROP TABLE import_rows;
ALTER TABLE import_rows_new RENAME TO import_rows;

CREATE INDEX idx_import_rows_run ON import_rows (import_run_id);
CREATE INDEX idx_import_rows_disposition ON import_rows (disposition);
CREATE INDEX idx_import_rows_order ON import_rows (parsed_order_id);
CREATE INDEX idx_import_rows_person ON import_rows (match_person_id);
