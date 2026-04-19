-- Seed standard *shared* occasions. Birthdays and anniversaries are per-person —
-- those get their own occasion rows (kind='birthday' / 'anniversary') with the
-- person's actual month/day. Shared holidays are created once and linked to each
-- relevant person via person_occasions.
--
-- Uses single-quoted literals with SQL-style '' escaping for apostrophes.
-- Each INSERT is guarded by NOT EXISTS so re-applying is a no-op.
--
-- Approximate dates for floating holidays (Mother's Day, Father's Day, Thanksgiving)
-- picked to fall within the actual window — admin can override per year in a later phase.

INSERT INTO occasions (title, kind, recurrence, month, day, reminder_days)
SELECT 'Christmas', 'holiday', 'annual', 12, 25, 28
WHERE NOT EXISTS (SELECT 1 FROM occasions WHERE title = 'Christmas' AND kind = 'holiday');

INSERT INTO occasions (title, kind, recurrence, month, day, reminder_days)
SELECT 'Mother''s Day', 'holiday', 'annual', 5, 10, 14
WHERE NOT EXISTS (SELECT 1 FROM occasions WHERE title = 'Mother''s Day' AND kind = 'holiday');

INSERT INTO occasions (title, kind, recurrence, month, day, reminder_days)
SELECT 'Father''s Day', 'holiday', 'annual', 6, 15, 14
WHERE NOT EXISTS (SELECT 1 FROM occasions WHERE title = 'Father''s Day' AND kind = 'holiday');

INSERT INTO occasions (title, kind, recurrence, month, day, reminder_days)
SELECT 'Valentine''s Day', 'holiday', 'annual', 2, 14, 10
WHERE NOT EXISTS (SELECT 1 FROM occasions WHERE title = 'Valentine''s Day' AND kind = 'holiday');

INSERT INTO occasions (title, kind, recurrence, month, day, reminder_days)
SELECT 'Thanksgiving', 'holiday', 'annual', 11, 25, 14
WHERE NOT EXISTS (SELECT 1 FROM occasions WHERE title = 'Thanksgiving' AND kind = 'holiday');

INSERT INTO occasions (title, kind, recurrence, month, day, reminder_days)
SELECT 'New Year''s Day', 'holiday', 'annual', 1, 1, 10
WHERE NOT EXISTS (SELECT 1 FROM occasions WHERE title = 'New Year''s Day' AND kind = 'holiday');
