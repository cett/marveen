-- Migration 0075: conversation_log.tenant_id (Phase 0 of the PostgreSQL move).
--
-- The ledger keeps the raw text of every channel turn per agent. The replay hook injects the last
-- turns into a fresh session, so a conversation must carry the tenant it belongs to or an agent
-- shared by two tenants would replay one tenant's turns into the other's session.
--
-- Nullable on purpose: NULL means "the tenant could not be resolved" (no channel binding for the
-- chat), which is NOT the same as 'default'. New rows are stamped by the server from the chat's
-- channel binding (see src/db/conversation-ledger.ts).
--
-- Backfill (Q3b): the rows of a shared agent (two or more enabled tenant_agent_availability rows)
-- are '_multi_' because the old rows carry no way to tell the tenants apart; every other row is
-- 'default'. Runs once, with the column, in the same transaction.
ALTER TABLE conversation_log ADD COLUMN tenant_id TEXT;

UPDATE conversation_log
   SET tenant_id = CASE
     WHEN agent_id IN (
       SELECT agent_id FROM tenant_agent_availability
        WHERE enabled = 1 GROUP BY agent_id HAVING COUNT(*) >= 2
     ) THEN '_multi_'
     ELSE 'default'
   END
 WHERE tenant_id IS NULL;
