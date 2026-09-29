-- Migration 0061: cost_budgets table.
--
-- Backs the CostOps budgets feature's `budgets[]` array, previously the
-- `budgets` field inside store/costops-config.json. Part of the wider
-- config/state -> SQLite migration (#985, plan #984, group 6/8). Only
-- `budgets` moves here -- `version`, `currency`, and `fixed_costs` stay in
-- the JSON file (fixed_costs has no clean home in the existing cost_sources
-- table: cost_sources is a source *registry* with no recurring-amount/period
-- column, built to be joined against actual cost_line_items rows, not to
-- hold a flat "N tokens/month" figure the way BudgetEntry does -- see the
-- group 6/8 plan doc). The route API (GET/POST/PUT/DELETE
-- /api/costops/budgets) and its contract are unchanged; only
-- loadCostopsConfig()/saveCostopsConfig()'s internals move for the budgets
-- half.
--
-- scope_ref is NOT in the plan doc's draft schema but IS a real BudgetEntry
-- field (the agent id or tenant id an 'agent'/'tenant'-scoped budget applies
-- to) -- omitting it would silently drop that data on the first read/write
-- round-trip through the table. Composite PRIMARY KEY(id, tenant_id) instead
-- of the plan's plain `id TEXT PRIMARY KEY`: this MVP only ever writes
-- tenant_id='default', but a bare `id` PK would collide the moment a second
-- tenant defines a budget with the same operator-chosen id (e.g. both
-- tenants naming their global budget "global-monthly") -- free to get right
-- now, expensive to migrate later.
CREATE TABLE IF NOT EXISTS cost_budgets (
  id                 TEXT    NOT NULL,
  name               TEXT    NOT NULL,
  scope              TEXT    NOT NULL DEFAULT 'global',
  scope_ref          TEXT,
  amount             INTEGER NOT NULL,
  currency           TEXT    NOT NULL DEFAULT 'HUF',
  warning_threshold  REAL    NOT NULL DEFAULT 0.8,
  hard_threshold     REAL    NOT NULL DEFAULT 1.0,
  block_on_hard      INTEGER NOT NULL DEFAULT 0,
  tenant_id          TEXT    NOT NULL DEFAULT 'default',
  created_at         INTEGER NOT NULL DEFAULT (unixepoch()),
  updated_at         INTEGER NOT NULL DEFAULT (unixepoch()),
  PRIMARY KEY (id, tenant_id)
);

-- No baked seed: a fresh install's store/costops-config.json does not exist,
-- and loadCostopsConfig() already returns an empty budgets array in that
-- case today -- baking a placeholder row here would be a behavior change,
-- not a migration. An existing install's operator-configured budgets are
-- backfilled at runtime by migrateCostBudgetsFromFile() (src/db/cost-budgets.ts),
-- wired into initDatabase() next to the other #985 file-backfill migrators --
-- never as literal values in this tracked SQL file (costops-config.json is
-- gitignored specifically so real budget figures never enter a tracked file;
-- baking them here would defeat that).
