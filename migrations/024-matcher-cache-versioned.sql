-- Wave 1 (Codex review #1): rebuild matcher_llm_cache with a versioned
-- key that prevents cross-context verdict replay. The old key
-- sha1(needle + sorted candidate titles) collided across different
-- orders, people, email types, and prompt versions — a verdict for one
-- shipment could replay as the verdict for an unrelated import row that
-- happened to have overlapping titles.
--
-- New key is sha1 of:
--   mode + model + prompt_version + needle_normalized +
--   candidate_gift_ids_sorted + candidate_person_ids_sorted +
--   items_fingerprint + recipient_hint_person_id
--
-- All inputs that could change the LLM's answer are part of the key.
-- Bumping prompt_version invalidates the whole cache cleanly.
--
-- expires_at gives every entry a TTL so stale verdicts age out (the
-- cleanup cron in the scheduler sweeps them on the same Sunday cadence
-- as amazon.cleanup_processed). Default 7 days from insert.
--
-- The existing cache table has no entries we can preserve under the new
-- shape (the old keys don't carry mode/model/prompt info). Drop and
-- recreate — the user has explicitly OK'd a fresh start.

DROP INDEX IF EXISTS idx_matcher_llm_cache_created;
DROP TABLE IF EXISTS matcher_llm_cache;

CREATE TABLE matcher_llm_cache (
  cache_key       TEXT PRIMARY KEY,
  mode            TEXT NOT NULL CHECK (mode IN ('import', 'shipment')),
  model           TEXT NOT NULL,
  prompt_version  TEXT NOT NULL,
  response        TEXT NOT NULL,
  created_at      TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  expires_at      TEXT NOT NULL DEFAULT (datetime(CURRENT_TIMESTAMP, '+7 days'))
);

CREATE INDEX idx_matcher_llm_cache_expires ON matcher_llm_cache (expires_at);
CREATE INDEX idx_matcher_llm_cache_mode ON matcher_llm_cache (mode);
