-- Wave 2 Phase 5 (td-4bfb59): record the admin's matcher corrections so the
-- Opus prompt can learn from them as few-shot examples.
--
-- A row is appended whenever the admin commits a decision that DISAGREES with
-- the LLM's pick (override = different existing gift, fill-in = LLM saw no
-- match but the admin linked one). The matcher's prompt builders already
-- render a "Prior admin corrections" section (Wave 1); this table is the data
-- source that was missing.
--
-- `action` describes what the admin did relative to the LLM:
--   'override' — LLM picked an existing gift, admin chose a different one
--   'fill-in'  — LLM found no match, admin linked an existing gift
-- (Pure create-new "reject" corrections aren't captured here yet — they don't
--  map cleanly to a positive few-shot example.)
--
-- Person names live in these rows. Acceptable in single-admin scope; the
-- prompt already flags the corrections block as internal-only context.

CREATE TABLE matcher_corrections (
  id                  INTEGER PRIMARY KEY AUTOINCREMENT,
  source_email_title  TEXT,
  source_email_subject TEXT,
  chosen_gift_id      INTEGER REFERENCES gifts(id) ON DELETE SET NULL,
  chosen_gift_title   TEXT NOT NULL,
  chosen_person_id    INTEGER REFERENCES people(id) ON DELETE SET NULL,
  chosen_person_name  TEXT NOT NULL,
  action              TEXT NOT NULL DEFAULT 'override'
                      CHECK (action IN ('override', 'fill-in')),
  created_at          TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX idx_matcher_corrections_recent ON matcher_corrections (created_at DESC);

-- Natural-key uniqueness so the same correction isn't logged repeatedly. The
-- same order's order_placed / shipped / delivered rows all resolve to the same
-- (item title -> gift -> person -> action) tuple; appendCorrection upserts on
-- this key (refreshing created_at) so a re-affirmed correction bumps recency
-- instead of piling up duplicate few-shot examples. (NULL source titles are
-- distinct under SQLite, so the rare title-less correction won't collapse —
-- acceptable.)
CREATE UNIQUE INDEX idx_matcher_corrections_natural
  ON matcher_corrections (source_email_title, chosen_gift_id, chosen_person_id, action);
