-- td-dc1846: chronological archive metadata.
--
-- archiveGift() today flips is_archived without recording WHEN the archive
-- happened. The admin archived-packages browser wants a "most recently
-- archived first" sort, but there's nothing to sort by except updated_at,
-- which lies (any later edit bumps it).
--
-- Add gifts.archived_at and start populating on new archive/restore.
-- Backfill existing archived rows with updated_at as a best-effort proxy
-- — acknowledged lossy for older rows, but the alternative is showing
-- nothing for them.

ALTER TABLE gifts ADD COLUMN archived_at TEXT;
CREATE INDEX idx_gifts_archived_at ON gifts (archived_at);

UPDATE gifts SET archived_at = updated_at WHERE is_archived = 1;
