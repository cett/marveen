-- Migration 0041: add 'confluence' to import_sources.type CHECK constraint,
-- plus two new nullable columns for the Confluence connector's auth config.
-- SQLite can't ALTER a CHECK constraint in place, so the table is rebuilt
-- (same pattern as 0022_blackboard_status_enum.sql); runner wraps this in
-- its own transaction (BEGIN/COMMIT must NOT appear here -- see
-- src/db-migrations.ts:95).
--
-- vault_token_ref / confluence_email / base_url (fork-portability
-- requirement): the Atlassian API token lives in the vault
-- under whatever id the user chooses (vault_token_ref); the account email
-- is NOT a secret (it's the Basic-auth username half) so it is stored
-- directly on the source row, never in the vault. base_url is the
-- Confluence Cloud SITE root (e.g. "https://yourorg.atlassian.net", no
-- trailing slash, no /wiki suffix -- the connector appends /wiki/api/v2
-- itself) -- this is org-specific too, so it is a per-source field rather
-- than a constant, exactly like the token and email. None of the three are
-- ever hardcoded anywhere in the codebase. All three columns stay NULL for
-- the existing local/gdrive/sharepoint source types.

-- 1. New import_sources with the extended CHECK constraint + 3 new columns
CREATE TABLE import_sources_new (
  id               TEXT    PRIMARY KEY,
  type             TEXT    NOT NULL
                     CHECK(type IN ('local', 'gdrive', 'sharepoint', 'confluence')),
  path             TEXT    NOT NULL,
  label            TEXT,
  interval_hours   INTEGER NOT NULL DEFAULT 4,
  enabled          INTEGER NOT NULL DEFAULT 1,
  last_run_at      INTEGER,
  created_at       INTEGER NOT NULL,
  updated_at       INTEGER NOT NULL,
  tenant_id        TEXT    NOT NULL DEFAULT 'default',
  vault_token_ref  TEXT,
  confluence_email TEXT,
  base_url         TEXT
);

-- 2. Copy existing rows (explicit column list to surface schema drift at
-- migration time); the three new columns default to NULL for every existing
-- row, which is correct for all non-confluence source types.
INSERT INTO import_sources_new
  (id, type, path, label, interval_hours, enabled, last_run_at, created_at, updated_at, tenant_id)
  SELECT id, type, path, label, interval_hours, enabled, last_run_at, created_at, updated_at, tenant_id
  FROM import_sources;

-- 3. Swap (import_audit_log.source_id REFERENCES import_sources(id) --
-- foreign_keys is off for this connection, as elsewhere in this schema, so
-- the drop/rename does not require dropping and recreating the FK; SQLite's
-- RENAME TO also updates the reference in import_audit_log's own schema
-- definition automatically).
DROP TABLE import_sources;
ALTER TABLE import_sources_new RENAME TO import_sources;

-- 4. Rebuild indexes
CREATE INDEX idx_import_sources_tenant ON import_sources(tenant_id);
