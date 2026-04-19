-- Session storage (Phase 1). Server-side sessions for proper logout/revocation.
-- Cookie holds only the random session id; all other state lives here.

CREATE TABLE sessions (
  id            TEXT PRIMARY KEY,
  user_id       INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at    TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  expires_at    TEXT NOT NULL,
  last_used_at  TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  user_agent    TEXT
);

CREATE INDEX idx_sessions_user ON sessions (user_id);
CREATE INDEX idx_sessions_expires ON sessions (expires_at);
