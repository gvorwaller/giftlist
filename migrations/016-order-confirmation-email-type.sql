-- td-c28c5e: order-confirmation emails create self-packages on manual label.
--
-- Widen import_rows.email_type CHECK to allow 'order_confirmation', a new
-- variant for merchant order-confirmation emails (e.g. "Order #3613899
-- confirmed") that have an order# but no carrier tracking#. The eventual
-- shipment email later auto-upgrades the gift via the existing order_id-
-- match path in commitTrackingReviewedRows.
--
-- SQLite has no ALTER TABLE DROP CONSTRAINT, so use the recreate-table
-- pattern. Migration runner toggles foreign_keys OFF before BEGIN and runs
-- PRAGMA foreign_key_check after COMMIT — see migrate.ts.

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
                            'tracking_only', 'order_confirmation'
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
  parsed_sender_domain, match_person_id, match_confidence,
  match_candidates_json, disposition, gift_id, error_message,
  created_at, updated_at
FROM import_rows;

DROP TABLE import_rows;
ALTER TABLE import_rows_new RENAME TO import_rows;

CREATE INDEX idx_import_rows_run ON import_rows (import_run_id);
CREATE INDEX idx_import_rows_disposition ON import_rows (disposition);
CREATE INDEX idx_import_rows_order ON import_rows (parsed_order_id);
CREATE INDEX idx_import_rows_person ON import_rows (match_person_id);
