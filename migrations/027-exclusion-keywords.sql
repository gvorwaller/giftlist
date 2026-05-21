-- td-8360f4: keyword-based exclusion list for the Amazon importer.
--
-- Many Amazon emails are recurring, non-gift purchases (household
-- supplies, Subscribe & Save). This table holds admin-managed keywords;
-- any parsed line item whose title matches an active keyword is dropped
-- from the import pipeline at scan time (and hidden on the review page),
-- so it never resurfaces for processing.
--
-- match_type:
--   'contains' (default) — case-insensitive substring match. Admin trims
--                          long Amazon titles to a recurring core (e.g.
--                          "Tide PODS") so future, slightly-different
--                          titles still match.
--   'exact'             — case-insensitive whole-title equality.
--
-- Soft delete via is_archived: archived keywords stop filtering but can be
-- restored, covering admin error (the task's "restore in case of user
-- error" requirement). Filtering is per-item, so excluded items are simply
-- omitted from the row's parsed_items_json — there is no row-level flag.

CREATE TABLE exclusion_keywords (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  keyword     TEXT NOT NULL,
  match_type  TEXT NOT NULL DEFAULT 'contains'
              CHECK (match_type IN ('contains', 'exact')),
  notes       TEXT,
  is_archived INTEGER NOT NULL DEFAULT 0,
  created_at  TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at  TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX idx_exclusion_keywords_active ON exclusion_keywords (is_archived);
