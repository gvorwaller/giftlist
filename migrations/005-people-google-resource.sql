-- Tracks the Google People API resource name (e.g. "people/c123...") for
-- contacts imported via Phase 2c, so re-syncs match existing rows instead
-- of duplicating them. NULL for manually-created people.
--
-- Partial unique index: multiple NULLs are allowed (SQLite treats NULLs as
-- distinct) but any two people with the same non-NULL resource name collide.

ALTER TABLE people ADD COLUMN google_resource_name TEXT;

CREATE UNIQUE INDEX idx_people_google_resource_name
  ON people (google_resource_name)
  WHERE google_resource_name IS NOT NULL;
