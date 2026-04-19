-- Stored OAuth tokens for external providers (Google for Phase 2/4).
-- Both access_token and refresh_token are AES-256-GCM encrypted at rest
-- using a key derived from AUTH_SECRET. Never write plaintext tokens here.

CREATE TABLE external_tokens (
  id                       INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id                  INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  provider                 TEXT NOT NULL CHECK (provider IN ('google')),
  scope                    TEXT NOT NULL,
  access_token_encrypted   TEXT,
  access_token_expires_at  TEXT,
  refresh_token_encrypted  TEXT,
  token_type               TEXT,
  account_email            TEXT,
  created_at               TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at               TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE (user_id, provider)
);

CREATE INDEX idx_external_tokens_user_provider ON external_tokens (user_id, provider);
