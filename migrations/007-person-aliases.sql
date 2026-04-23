-- Recipient-name aliases learned during Amazon import. When an Amazon
-- order's "Gift message" or shipping name doesn't match any known person,
-- the admin can assign it manually and save the text as an alias so the
-- next matching run finds the person automatically.

CREATE TABLE person_aliases (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  person_id   INTEGER NOT NULL REFERENCES people(id) ON DELETE CASCADE,
  alias_name  TEXT NOT NULL,
  source      TEXT NOT NULL CHECK (source IN ('manual', 'import_assigned')),
  created_at  TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE (alias_name)
);

CREATE INDEX idx_person_aliases_person ON person_aliases (person_id);
