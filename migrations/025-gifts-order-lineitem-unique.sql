-- Wave 1 (Codex review #4): DB-level invariant that no two active gifts
-- can share (order_pk, line_item_index). This is the belt-and-suspenders
-- against matcher bugs and double-commit races — even if the
-- commitMultiItemAccept code is wrong, the DB rejects the second insert.
--
-- Prod currently has duplicate clusters from the very bug we're fixing
-- (multi-item commit creating fresh gifts on every shipped/delivered
-- email instead of advancing existing siblings). We can't install the
-- unique index until those clusters are resolved.
--
-- Per user direction: auto-archive everything in each duplicate cluster
-- EXCEPT the lowest-id gift (the original commit), then create the
-- index. The archived gift IDs land in app_state as a JSON list for
-- forensics; each one is still reachable + Restorable via the existing
-- /admin/system/archived browser if the wrong one was kept.

-- Step 1: identify victim gift IDs (active gifts in a duplicate cluster
-- that are NOT the lowest-id member of the cluster).
CREATE TEMP TABLE wave1_archive_victims AS
SELECT g.id
  FROM gifts g
  JOIN (
    SELECT order_pk, line_item_index
      FROM gifts
     WHERE is_archived = 0
       AND order_pk IS NOT NULL
     GROUP BY order_pk, line_item_index
    HAVING COUNT(*) > 1
  ) dup
    ON dup.order_pk = g.order_pk
   AND dup.line_item_index = g.line_item_index
 WHERE g.is_archived = 0
   AND g.id NOT IN (
     SELECT MIN(id) FROM gifts
      WHERE is_archived = 0
        AND order_pk IS NOT NULL
      GROUP BY order_pk, line_item_index
   );

-- Step 2: persist the victim list to app_state for forensics. JSON
-- array of full row snapshots so the admin can audit / restore.
INSERT INTO app_state (key, value, updated_at)
SELECT
  'wave1_migration_025_archived_gifts',
  (SELECT '[' || GROUP_CONCAT(
     json_object(
       'gift_id',         g.id,
       'order_pk',        g.order_pk,
       'order_id',        g.order_id,
       'line_item_index', g.line_item_index,
       'title',           g.title,
       'person_id',       g.person_id,
       'status',          g.status,
       'created_at',      g.created_at
     )
   ) || ']'
   FROM gifts g
   WHERE g.id IN (SELECT id FROM wave1_archive_victims)),
  CURRENT_TIMESTAMP
WHERE EXISTS (SELECT 1 FROM wave1_archive_victims)
ON CONFLICT(key) DO UPDATE SET
  value = excluded.value,
  updated_at = excluded.updated_at;

-- Step 3: archive the victims. archived_at gets a timestamp so the
-- /admin/system/archived browser sorts them as just-archived.
UPDATE gifts
   SET is_archived = 1,
       archived_at = CURRENT_TIMESTAMP,
       updated_at = CURRENT_TIMESTAMP
 WHERE id IN (SELECT id FROM wave1_archive_victims);

DROP TABLE wave1_archive_victims;

-- Step 4: install the partial unique index. Active gifts under an order
-- must have unique line_item_index. Inactive (archived) gifts are
-- unconstrained — they keep their original line_item_index for forensic
-- purposes.
CREATE UNIQUE INDEX gifts_order_lineitem_active
  ON gifts (order_pk, line_item_index)
  WHERE is_archived = 0 AND order_pk IS NOT NULL;
