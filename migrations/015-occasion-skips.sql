-- td-927a2d: skip a single iteration of a recurring occasion without
-- archiving the person_occasion link.
--
-- Composite primary key (person_occasion_id, occasion_year) means each
-- annual instance is independently skippable / unskippable, and no row can
-- exist twice for the same (po, year). Removing the row is the reversal —
-- there's no soft-delete column because "no row" naturally means "not
-- skipped". Audit-trail comes via audit_log entries written by the
-- skip/unskip helpers.
--
-- ON DELETE CASCADE: if the underlying person_occasion link is removed
-- (e.g., admin deletes the birthday), drop its skips too.

CREATE TABLE occasion_skips (
  person_occasion_id  INTEGER NOT NULL REFERENCES person_occasions(id) ON DELETE CASCADE,
  occasion_year       INTEGER NOT NULL,
  actor_user_id       INTEGER NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  skipped_at          TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  reason              TEXT,
  PRIMARY KEY (person_occasion_id, occasion_year)
);

CREATE INDEX idx_occasion_skips_year ON occasion_skips (occasion_year);
