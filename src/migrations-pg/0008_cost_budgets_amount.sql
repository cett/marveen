-- PostgreSQL only (phase 3, step 6c-2): cost_budgets.amount is double precision, not bigint.
--
-- The SQLite column is `amount INTEGER NOT NULL` (migration 0061), and it is INTEGER affinity, not a fixed integer type: SQLite
-- stores a REAL value there as a REAL. The route (src/web/routes/costops-budgets.ts) and the config file accept any finite
-- non-negative number, so an amount of 1000.5 is valid input on both engines. The baseline mapped INTEGER to bigint, which
-- refuses such a value on PostgreSQL. This statement widens the column to the type that holds it. The one difference this
-- leaves against the SQLite end state is named in helpers/pg-parity.ts (PG_TYPE_EXCEPTIONS): the column type, and only that.
--
-- No SQLite twin: the SQLite chain keeps its INTEGER column. Listed in PG_ONLY_MIGRATIONS (helpers/pg-twins.ts).

ALTER TABLE cost_budgets ALTER COLUMN amount TYPE double precision USING amount::double precision;
