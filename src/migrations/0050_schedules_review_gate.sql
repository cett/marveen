-- Migration 0050: draft/pending_review/live review-gate for schedules.
--
-- Today ANY caller with schedule-write access can
-- create or edit a schedule and have it fire on the very next cron tick --
-- there is no build-vs-publish separation (n8n's draft/review/live model).
-- Concretely, every fleet agent shares the dashboard-token bearer, which
-- resolves to role='admin' for backward-compat (see src/web/authz.ts), so
-- role alone cannot distinguish "a human approved this" from "an agent
-- proposed this" -- the gate below is keyed off session-vs-token auth, not
-- role, for exactly that reason (see schedules.ts).
--
-- All existing rows are stamped 'live' (unchanged runtime behavior for
-- every schedule that predates this migration); only NEW schedules created
-- by a non-human-admin caller start life as 'draft'.

ALTER TABLE schedules ADD COLUMN status TEXT NOT NULL DEFAULT 'live';

CREATE INDEX IF NOT EXISTS idx_schedules_status ON schedules(status);
