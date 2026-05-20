-- Wave 1 follow-up: persist a body excerpt on import_rows so the LLM
-- matcher has fallback context when the item parser couldn't extract a
-- structured items[] (rare — confirmation/marketing edge cases). Up to
-- 4000 chars from the parsed body text. NULL when the parser succeeded
-- and items[] carries the per-line breakdown, or for legacy rows.

ALTER TABLE import_rows ADD COLUMN parsed_body_excerpt TEXT;
