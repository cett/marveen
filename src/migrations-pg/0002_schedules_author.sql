-- PostgreSQL twin of SQLite migration 0096: who wrote and who activated a scheduled task.
-- A plain mirror: the four nullable columns, no default, no constraint, no index (INTEGER is bigint here).
ALTER TABLE schedules ADD COLUMN author_user_id bigint;
ALTER TABLE schedules ADD COLUMN author_label   text;
ALTER TABLE schedules ADD COLUMN activated_by   text;
ALTER TABLE schedules ADD COLUMN activated_at   bigint;
