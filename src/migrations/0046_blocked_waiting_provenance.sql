-- Migration 0046: blocked/waiting provenance for the fleet blackboard and
-- kanban cards.
--
-- All nine columns are nullable TEXT, no backward-compat break. Split by
-- where each concern is actually READ:
--   fleet_blackboard (the LIVE row per agent): blocked_by, blocked_reason
--   -- who/why a status='blocked' row is stuck right now.
--   fleet_blackboard_history (the append-only audit trail written on every
--   upsert): blocked_by, blocked_reason mirror the live snapshot at that
--   point in time; resolved_by additionally records who moved the row out
--   of 'blocked' (e.g. into 'done'), which the live table has no room for
--   once the block is over and the row has moved on.
--   kanban_cards (the LIVE card): blocked_by, blocked_reason, waiting_for
--   -- kanban has no 'blocked' status, only 'waiting'; waiting_for is a
--   free-text description of what the card is waiting on, distinct from
--   blocked_by/blocked_reason (who/why it stalled getting there in the
--   first place, when known). resolved_by records who closed a waiting
--   card, mirroring fleet_blackboard_history's resolution field.
ALTER TABLE fleet_blackboard ADD COLUMN blocked_by TEXT;
ALTER TABLE fleet_blackboard ADD COLUMN blocked_reason TEXT;

ALTER TABLE fleet_blackboard_history ADD COLUMN blocked_by TEXT;
ALTER TABLE fleet_blackboard_history ADD COLUMN blocked_reason TEXT;
ALTER TABLE fleet_blackboard_history ADD COLUMN resolved_by TEXT;

ALTER TABLE kanban_cards ADD COLUMN blocked_by TEXT;
ALTER TABLE kanban_cards ADD COLUMN blocked_reason TEXT;
ALTER TABLE kanban_cards ADD COLUMN waiting_for TEXT;
ALTER TABLE kanban_cards ADD COLUMN resolved_by TEXT;
