-- td-68804e: per-user privacy on self-orders.
-- Adds owner_user_id to people so /app/packages can scope self-people to
-- the signed-in user (admin sees their own self-orders; manager sees hers,
-- not admin's). Null for shared gift recipients (the normal case).
-- Backfills existing is_self rows to the first admin user — there's only
-- ever one admin in this app per CLAUDE.md, and the only existing self
-- person was created by Gaylon (admin).

-- ON DELETE RESTRICT (not SET NULL): if a user is ever deleted, fail loudly
-- rather than orphan their self-people. An orphaned self-row would either be
-- invisible to everyone (with the strict filters we use on /app) or leak to
-- the surviving user (with permissive filters); neither is acceptable. To
-- delete a user safely, the admin must first reassign or delete their
-- self-people in the same transaction.
ALTER TABLE people
  ADD COLUMN owner_user_id INTEGER REFERENCES users(id) ON DELETE RESTRICT;

CREATE INDEX idx_people_owner_user_id ON people (owner_user_id);

UPDATE people
   SET owner_user_id = (SELECT id FROM users WHERE role = 'admin' ORDER BY id ASC LIMIT 1)
 WHERE is_self = 1
   AND owner_user_id IS NULL;
