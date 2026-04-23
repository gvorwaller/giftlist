-- Staging tables for Amazon email import. Each scan creates an import_run;
-- each parsed email becomes an import_row. Admin reviews rows and either
-- commits them into gifts or skips them. Committed rows link back to the
-- created gift id so we can group multi-email orders.

CREATE TABLE import_runs (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  source          TEXT NOT NULL CHECK (source IN ('amazon_email')),
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

CREATE INDEX idx_import_runs_status ON import_runs (status, started_at DESC);

CREATE TABLE import_rows (
  id                      INTEGER PRIMARY KEY AUTOINCREMENT,
  import_run_id           INTEGER NOT NULL REFERENCES import_runs(id) ON DELETE CASCADE,
  source_message_id       TEXT NOT NULL,
  source_thread_id        TEXT,
  subject                 TEXT,
  received_at             TEXT,
  from_address            TEXT,
  email_type              TEXT NOT NULL CHECK (email_type IN (
                            'order_placed', 'shipped', 'delivered',
                            'marketing', 'review_request', 'unknown'
                          )),
  parsed_title            TEXT,
  parsed_order_id         TEXT,
  parsed_price_cents      INTEGER,
  parsed_tracking_number  TEXT,
  parsed_carrier          TEXT,
  parsed_recipient_name   TEXT,
  parsed_shipping_address TEXT,
  parsed_gift_message     TEXT,
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

CREATE INDEX idx_import_rows_run ON import_rows (import_run_id);
CREATE INDEX idx_import_rows_disposition ON import_rows (disposition);
CREATE INDEX idx_import_rows_order ON import_rows (parsed_order_id);
CREATE INDEX idx_import_rows_person ON import_rows (match_person_id);
