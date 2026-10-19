-- Migration 0085: agent_inflight_turns, the "turn in flight" journal (5aa63510 W3 / J1).
--
-- When a session dies in the middle of a turn (watchdog respawn, crash, host restart) the next
-- session starts blind: Claude Code does not re-run an interrupted turn, and an inter-agent
-- message or a channel prompt that was injected right before the death is simply gone. The hooks
-- keep one row per agent here:
--   UserPromptSubmit  -> begin  (upsert: a new prompt supersedes the previous row)
--   Stop              -> end    (delete: the turn finished)
--   SessionStart      -> replay (a row that is still here, young enough and not yet consumed means
--                                the previous turn was cut off) -> consume
-- The replay is an ADVICE ("decide whether this needs doing again"), never an automatic re-run: a
-- turn that sent a mail or pushed a branch must not run twice.
--
--   agent_id     one row per agent (PRIMARY KEY), a new begin replaces the old row
--   turn_id      changes on every begin; consume names it, so a late consume cannot close a NEWER turn
--   source       what started the turn: channel | agent | scheduled | prompt (classified server side)
--   msg_id       the inter-agent message id when the prompt names one ("msg_id:N"), else NULL
--   preview      first 200 characters of the prompt, whitespace collapsed; NULL for a shared agent
--                (an agent served by two or more tenants), whose replay carries no prompt text
--   prompt_hash  sha256 prefix of the whole prompt (the hook computes it), lets a reader tell two
--                identical-looking turns apart without keeping the text
--   started_at   unix seconds of the begin
--   consumed_at  unix seconds of the replay that offered it; NULL = not offered yet
--   tenant_id    NULLABLE like the other journal tables (0077): NULL means "could not be resolved"
--
-- Plain addition (CREATE TABLE IF NOT EXISTS), nothing is altered or rebuilt.

CREATE TABLE IF NOT EXISTS agent_inflight_turns (
  agent_id    TEXT    NOT NULL PRIMARY KEY,
  turn_id     TEXT    NOT NULL,
  source      TEXT    NOT NULL,
  msg_id      TEXT,
  preview     TEXT,
  prompt_hash TEXT    NOT NULL,
  started_at  INTEGER NOT NULL,
  consumed_at INTEGER,
  tenant_id   TEXT
);
