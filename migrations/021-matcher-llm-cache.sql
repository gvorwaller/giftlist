-- td-1d01e9 Phase B: cache LLM matcher decisions so re-evaluating a
-- previously-staged import row never re-bills the Anthropic API.
--
-- Keyed by sha1(needle_title || sorted_candidate_titles). Same
-- (needle, candidate set) always returns the same cached answer; a
-- different candidate set (admin added/archived a gift) gets a fresh
-- decision automatically because the key changes.

CREATE TABLE matcher_llm_cache (
  cache_key   TEXT PRIMARY KEY,
  response    TEXT NOT NULL,
  created_at  TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX idx_matcher_llm_cache_created ON matcher_llm_cache (created_at);
