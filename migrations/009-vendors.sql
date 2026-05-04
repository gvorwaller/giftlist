-- Vendors lookup table for the gift "where from" field.
-- Replaces free-text source with a curated list managed in admin.
-- Existing source values are backfilled into vendors, then linked via vendor_id.
-- The legacy gifts.source column is intentionally kept for one release window
-- so we can roll back without data loss; a later migration may drop it.

CREATE TABLE vendors (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  name        TEXT NOT NULL,
  is_archived INTEGER NOT NULL DEFAULT 0 CHECK (is_archived IN (0, 1)),
  created_at  TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at  TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE UNIQUE INDEX idx_vendors_name_nocase ON vendors (name COLLATE NOCASE);
CREATE INDEX idx_vendors_archived ON vendors (is_archived);

-- Backfill: distinct existing source values become vendors.
-- TRIM + collate-nocase prevents whitespace and case duplicates.
INSERT INTO vendors (name)
SELECT TRIM(source)
  FROM (
    SELECT DISTINCT TRIM(source) AS source
      FROM gifts
     WHERE source IS NOT NULL
       AND TRIM(source) != ''
  )
 ORDER BY 1;

-- Add FK column on gifts. ON DELETE SET NULL so archiving in app code (we
-- never hard-delete) is safe; if a vendor row is ever removed by an admin
-- against advice, the gift survives with vendor_id=NULL and source text intact.
ALTER TABLE gifts ADD COLUMN vendor_id INTEGER REFERENCES vendors(id) ON DELETE SET NULL;

-- Backfill: link each gift's vendor_id by case-insensitive name match.
UPDATE gifts
   SET vendor_id = (
         SELECT v.id
           FROM vendors v
          WHERE LOWER(v.name) = LOWER(TRIM(gifts.source))
          LIMIT 1
       )
 WHERE source IS NOT NULL
   AND TRIM(source) != '';

CREATE INDEX idx_gifts_vendor ON gifts (vendor_id);
