-- Migration 0074: agent_messages_delivered_needs_ts, moved from initDatabase() under the migration runner.
--
-- INVARIANT: a row that says 'delivered' must carry a delivered_at.
--
-- On 2026-07-27 an operator bulk-closed a 28-row backlog with raw SQL that set status without a
-- timestamp. Nothing broke loudly, but the queue, which is the only signal for "what actually went
-- out", started claiming that messages had been delivered when they never left.
--
-- Enforced with a trigger rather than a CHECK constraint because SQLite cannot add a CHECK to an
-- existing table without rebuilding it. Self-healing rather than ABORT: aborting would turn a
-- bookkeeping slip into a failed operation for the caller, and the point is to keep the RECORD
-- honest. The row gets a timestamp AND, if nothing else explains it, a marker saying it was closed
-- without ever being delivered.
--
-- The trigger used to be created by src/db/connection.ts on every start. Living in the migrations
-- means a database built from them alone (and the schema a PostgreSQL port starts from) has it, and
-- the channel-coordinator, which now runs the same runner, no longer boots without it. IF NOT EXISTS
-- keeps every existing install untouched: the body is the one initDatabase() created.
CREATE TRIGGER IF NOT EXISTS agent_messages_delivered_needs_ts
AFTER UPDATE OF status ON agent_messages
FOR EACH ROW WHEN NEW.status = 'delivered' AND NEW.delivered_at IS NULL
BEGIN
  UPDATE agent_messages
     SET delivered_at = CAST(strftime('%s','now') AS INTEGER),
         result = COALESCE(result, 'closed-without-delivery')
   WHERE id = NEW.id;
END;
