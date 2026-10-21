-- Migration 0086: the server-side record of a channel's credential, for the sends the SERVER makes.
--
-- The bot token (<state_dir>/.env) and the pairing (<state_dir>/access.json) live in a directory the
-- agent's own OS user can write. A server send that trusts those files (voice TTS/STT, the chat a
-- scheduled task reports to) can therefore be steered by the agent: a forged allowFrom widens who is
-- spoken to, a foreign token in .env changes whose bot speaks. The server now reads neither on those
-- paths. What it uses instead:
--   * the bot token: the encrypted vault, secret id 'channel-token:<agent_id>' (no table, no column);
--   * the allowed chats: channel_allowed_chats, written ONLY by the admin "adopt" route, which records
--     the pairing as it stands at the moment the owner adopts it;
--   * channel_credential_baseline: what was adopted (sha256 of the token and of the normalized chat
--     list), so the drift check can tell that the files no longer match. Drift alarms; it never
--     changes the server-side value, which stays authoritative.
--
--   agent_id     the agent the channel belongs to (MAIN_AGENT_ID for the main agent's channel)
--   provider     'telegram' (the only provider this record covers today)
--   chat_id      the adopted chat, as text (a Telegram user id, or a negative group id)
--   position     order in the adopted list; the scheduled-task delivery chat is the first entry
--   adopted_by   the admin principal that adopted the list
--   drift_state  ok | token | access | both | unreadable: 'ok' or the part that differs;
--                'unreadable' when a file could not be read; set by the drift check
--   drift_since  unix seconds since the current non-ok state began (NULL while ok); the alarm is
--                raised once per episode, not on every sweep
--   tenant_id    NOT NULL DEFAULT 'default' like the tenant-keyed tables (plan 3A)
--
-- Plain addition (CREATE TABLE IF NOT EXISTS), nothing is altered or rebuilt.

CREATE TABLE IF NOT EXISTS channel_allowed_chats (
  agent_id    TEXT    NOT NULL,
  provider    TEXT    NOT NULL,
  chat_id     TEXT    NOT NULL,
  position    INTEGER NOT NULL DEFAULT 0,
  adopted_by  TEXT    NOT NULL,
  adopted_at  INTEGER NOT NULL DEFAULT (unixepoch()),
  tenant_id   TEXT    NOT NULL DEFAULT 'default',
  PRIMARY KEY (tenant_id, agent_id, provider, chat_id)
);

CREATE INDEX IF NOT EXISTS idx_channel_allowed_chats_agent ON channel_allowed_chats(agent_id, provider);

CREATE TABLE IF NOT EXISTS channel_credential_baseline (
  agent_id        TEXT    NOT NULL,
  provider        TEXT    NOT NULL,
  token_sha256    TEXT    NOT NULL,
  allow_sha256    TEXT    NOT NULL,
  adopted_by      TEXT    NOT NULL,
  adopted_at      INTEGER NOT NULL DEFAULT (unixepoch()),
  last_checked_at INTEGER,
  drift_state     TEXT    NOT NULL DEFAULT 'ok',
  drift_since     INTEGER,
  tenant_id       TEXT    NOT NULL DEFAULT 'default',
  PRIMARY KEY (tenant_id, agent_id, provider)
);
