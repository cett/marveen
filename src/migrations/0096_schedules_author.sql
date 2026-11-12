-- Migration 0096: who wrote and who activated a scheduled task.
--
-- author_user_id  dashboard_users.id of the logged-in user who last wrote the content the runner executes.
--                 NULL = no user-bound author (a seed, a token, an agent, every row from before this migration).
-- author_label    a human-readable form of that writer ('<username>', 'token:<name>', 'claimed:<agent>'), so a row
--                 still says whose it was after the user is deleted. NULL = a seed or a row from before.
-- activated_by    the human admin who activated the task (or created it live). activated_at: epoch seconds.
--
-- Plain ADD COLUMN on purpose: no table rebuild (schedules has indexes, and ALTER TABLE ... RENAME is off the table
-- because of the vec0 triggers), no foreign key (deleting a user must neither cascade nor be blocked: a deleted
-- author is exactly the case the runner has to notice), no CHECK, no DEFAULT, no index (a few dozen rows).
--
-- Backfill (below the columns): every existing row, whatever its status, is given the lowest-id enabled admin as its
-- author, because the real author of an existing row is not known. It is the lowest id of an enabled admin and not a
-- literal 1: on another install (a fork, a fresh one, another order of users) id 1 could be missing or not an admin,
-- and the run-time check would then stop every schedule. With no enabled admin (an empty dashboard_users) the
-- subselects are NULL and the rows stay unchecked: the backfill can never stop anything. activated_by/activated_at stay
-- NULL: an approval is not invented. Later seeds get a NULL author (the system). Plain standard SQL, so the
-- PostgreSQL twin stays DDL-only (data moves with the SQLite to PostgreSQL transfer).
ALTER TABLE schedules ADD COLUMN author_user_id INTEGER;
ALTER TABLE schedules ADD COLUMN author_label   TEXT;
ALTER TABLE schedules ADD COLUMN activated_by   TEXT;
ALTER TABLE schedules ADD COLUMN activated_at   INTEGER;

UPDATE schedules
   SET author_user_id = (SELECT MIN(id) FROM dashboard_users WHERE role = 'admin' AND disabled = 0),
       author_label   = (SELECT username FROM dashboard_users
                          WHERE id = (SELECT MIN(id) FROM dashboard_users WHERE role = 'admin' AND disabled = 0));
