-- Gift Tracker initial schema
-- Design spec: docs/gift-tracker-design-Claude.md (V3) Section 8 (data model) + Section 15 (creation order)
-- Datetimes stored as TEXT ISO-8601 (CURRENT_TIMESTAMP default). Booleans as INTEGER 0/1.

-- 1. users ------------------------------------------------------------------
CREATE TABLE users (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  username        TEXT NOT NULL UNIQUE,
  password_hash   TEXT NOT NULL,
  role            TEXT NOT NULL CHECK (role IN ('manager', 'admin')),
  display_name    TEXT NOT NULL,
  last_login_at   TEXT,
  last_seen_path  TEXT,
  last_seen_at    TEXT,
  created_at      TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- 2. people -----------------------------------------------------------------
CREATE TABLE people (
  id                        INTEGER PRIMARY KEY AUTOINCREMENT,
  display_name              TEXT NOT NULL,
  full_name                 TEXT,
  relationship              TEXT,
  default_shipping_address  TEXT,
  notes                     TEXT,
  is_archived               INTEGER NOT NULL DEFAULT 0 CHECK (is_archived IN (0, 1)),
  created_at                TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at                TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX idx_people_archived ON people (is_archived);
CREATE INDEX idx_people_display_name ON people (display_name);

-- 3. occasions --------------------------------------------------------------
-- Global occasion definitions. Shared holidays exist once, linked to people via person_occasions.
CREATE TABLE occasions (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  title          TEXT NOT NULL,
  kind           TEXT NOT NULL CHECK (kind IN ('birthday', 'holiday', 'anniversary', 'custom')),
  recurrence     TEXT NOT NULL CHECK (recurrence IN ('annual', 'one_time')),
  month          INTEGER CHECK (month BETWEEN 1 AND 12),
  day            INTEGER CHECK (day BETWEEN 1 AND 31),
  date           TEXT,
  reminder_days  INTEGER NOT NULL DEFAULT 21,
  created_at     TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at     TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CHECK (
    (recurrence = 'annual'   AND month IS NOT NULL AND day IS NOT NULL AND date IS NULL)
    OR (recurrence = 'one_time' AND date IS NOT NULL AND month IS NULL AND day IS NULL)
  )
);

-- 4. person_occasions -------------------------------------------------------
CREATE TABLE person_occasions (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  person_id    INTEGER NOT NULL REFERENCES people(id)    ON DELETE CASCADE,
  occasion_id  INTEGER NOT NULL REFERENCES occasions(id) ON DELETE CASCADE,
  is_active    INTEGER NOT NULL DEFAULT 1 CHECK (is_active IN (0, 1)),
  notes        TEXT,
  UNIQUE (person_id, occasion_id)
);

CREATE INDEX idx_person_occasions_person ON person_occasions (person_id);
CREATE INDEX idx_person_occasions_occasion ON person_occasions (occasion_id);

-- 5. gifts ------------------------------------------------------------------
CREATE TABLE gifts (
  id               INTEGER PRIMARY KEY AUTOINCREMENT,
  person_id        INTEGER NOT NULL REFERENCES people(id)    ON DELETE RESTRICT,
  occasion_id      INTEGER          REFERENCES occasions(id) ON DELETE SET NULL,
  occasion_year    INTEGER,
  title            TEXT NOT NULL,
  source           TEXT,
  source_url       TEXT,
  order_id         TEXT,
  tracking_number  TEXT,
  carrier          TEXT,
  price_cents      INTEGER,
  status           TEXT NOT NULL CHECK (status IN (
                     'idea', 'planned', 'ordered', 'shipped',
                     'delivered', 'wrapped', 'given', 'returned'
                   )),
  ordered_at       TEXT,
  shipped_at       TEXT,
  delivered_at     TEXT,
  notes            TEXT,
  is_idea          INTEGER NOT NULL DEFAULT 0 CHECK (is_idea IN (0, 1)),
  is_archived      INTEGER NOT NULL DEFAULT 0 CHECK (is_archived IN (0, 1)),
  created_at       TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at       TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX idx_gifts_person ON gifts (person_id);
CREATE INDEX idx_gifts_occasion ON gifts (occasion_id);
CREATE INDEX idx_gifts_status ON gifts (status);
CREATE INDEX idx_gifts_archived ON gifts (is_archived);
CREATE INDEX idx_gifts_order_id ON gifts (order_id);

-- 6. drafts -----------------------------------------------------------------
-- Server-side draft persistence. Managed as one active draft per user per draft_type.
CREATE TABLE drafts (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id       INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  draft_type    TEXT NOT NULL CHECK (draft_type IN ('gift')),
  payload_json  TEXT NOT NULL,
  created_at    TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at    TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE (user_id, draft_type)
);

CREATE INDEX idx_drafts_user ON drafts (user_id);
CREATE INDEX idx_drafts_created ON drafts (created_at);

-- 7. recently_viewed --------------------------------------------------------
-- Powers the Today screen's "Recently Viewed" section. App caps at 10 per user.
CREATE TABLE recently_viewed (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id      INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  entity_type  TEXT NOT NULL CHECK (entity_type IN ('person', 'gift')),
  entity_id    INTEGER NOT NULL,
  label        TEXT NOT NULL,
  viewed_at    TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX idx_recently_viewed_user ON recently_viewed (user_id, viewed_at DESC);

-- 8. audit_log --------------------------------------------------------------
CREATE TABLE audit_log (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  actor_user_id   INTEGER NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  entity_type     TEXT NOT NULL,
  entity_id       INTEGER NOT NULL,
  action          TEXT NOT NULL,
  summary         TEXT NOT NULL,
  created_at      TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX idx_audit_entity ON audit_log (entity_type, entity_id);
CREATE INDEX idx_audit_created ON audit_log (created_at DESC);

-- 9. job_runs ---------------------------------------------------------------
-- Records background job executions (reminders, backups, backup verification).
CREATE TABLE job_runs (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  job_name      TEXT NOT NULL,
  started_at    TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  finished_at   TEXT,
  status        TEXT NOT NULL CHECK (status IN ('running', 'ok', 'error')),
  summary       TEXT,
  error_message TEXT
);

CREATE INDEX idx_job_runs_name_started ON job_runs (job_name, started_at DESC);

-- 10. app_state -------------------------------------------------------------
-- Key-value app config/state. Includes the migration runner's schema_version.
CREATE TABLE app_state (
  key         TEXT PRIMARY KEY,
  value       TEXT NOT NULL,
  updated_at  TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
