# Changelog

All notable changes to this project are documented in this file.
Format: [Keep a Changelog](https://keepachangelog.com/en/1.0.0/), SemVer.

API changes are labelled **[API]** so they can be found at a glance.
Generate/update [Unreleased]: `npm run changelog`
Extract a version for release: `npm run release-notes -- <version>`

## [Unreleased]

<!-- changelog-auto-sha: cd00e7d54aadf38020b01709e16f6102bb1d0451 -->

### Added

- **[API]** Schedules admin view gains two pieces of scheduler-state visibility that were previously invisible or DB-only-with-no-UI: (1) a per-task badge next to the existing "last run" time showing the outcome of that run (`fired`/`fired_late`/`skipped_quota`/`skipped_precheck`/`command`, sourced from `schedules.last_run_result`, migration 0057); (2) a scheduler-wide heartbeat indicator (new admin-only `GET /api/schedules/tick-status`) showing when the schedule-runner's tick loop last stamped its liveness marker (`schedule_last_tick_ms`), turning from a success to a danger badge past a 3-minute staleness threshold -- previously this stamp existed only to seed the catch-up window on restart, with no way for an operator to tell a hung runner from a healthy one short of reading the DB directly. Both are read-only additions; no existing endpoint or stored shape changes.
- Vault-secret-to-MCP-env-var bindings moved from `store/vault-bindings.json` to a new `vault_bindings` DB table (migration 0062, group 7/8); unlike group 6, the whole file is retired (renamed to `.deprecated` on boot after a one-time idempotent backfill), since nothing else lived in it. The table holds binding *metadata* only (which `vaultSecretId` maps to which `envVar`, and which MCP file/server it syncs into) -- no secret value is ever stored here; the actual secret material stays in `vault.json`. `connectors.ts`'s bindings routes are unchanged -- only the storage underneath `getBindings()`/`addBinding()`/`removeBinding()`/`removeBindingsForSecret()` moved. Fleet export/import hardening mirrors the group 6/8 `costBudgets` lessons: an empty or entirely-invalid source `bindings` array no longer wipes the target's own bindings, each entry is validated before the DB write, and a duplicated `(vaultSecretId, envVar)` pair is de-duped (first occurrence wins) instead of throwing on the table's primary key -- each case reported as an import warning.
- CostOps budgets (`budgets[]`) moved from `store/costops-config.json` to a new `cost_budgets` DB table (migration 0061, group 6/8); `version`/`currency`/`fixed_costs` stay in the file (`fixed_costs` has no clean home in the existing `cost_sources` registry table). One-time idempotent backfill from an existing install's file on boot, no baked seed (a fresh install already starts with zero budgets). `GET`/`POST`/`PUT`/`DELETE /api/costops/budgets` and the Settings budgets UI are unchanged -- only the storage underneath `loadCostopsConfig()`/`saveCostopsConfig()` moved. Fleet import hardening: an empty `costBudgets` array in the source snapshot no longer wipes the target's own budgets (same guard idiom as the other overwrite fields, now applied to the *validated* result too -- if every entry turns out invalid, the target is left untouched rather than replaced with an empty set), each entry is validated (`validateConfig()`) before the DB write so a malformed one is dropped instead of crashing the import on a `NOT NULL` constraint, a duplicated `id` in the source is de-duped (first occurrence wins, same as `migrateCostBudgetsFromFile()`'s `INSERT OR IGNORE`) instead of throwing on the `cost_budgets` primary key, and the import response now carries a warning for each of these cases. An old-format snapshot's `costopsConfig.budgets` is not lost either -- it lands additively (`INSERT OR IGNORE`) via `migrateCostBudgetsFromFile()` on the target's next boot.
- **[API]** Model-fallback-on-limit config (`enabled`/`chain`/`revertAfterMinutes`), agents-desired run-state, and the terminal-input opt-in toggle moved from `store/model-fallback.json`, `store/agents-desired.json`, and `store/terminal-input.json` to `system_config` DB rows (group 5/8; federation stays file-based, deferred to a later step). One-time idempotent backfill from any existing JSON side-cars on boot, deliberately not a baked migration seed (the fallback chain's primary must match the actually-running model; the terminal-input default must stay OFF for a fresh install). New `GET`/`PUT /api/model-fallback` admin route and Settings "Model fallback" tab (enable toggle, chain editor, revert-after-minutes). Fleet export/import updated: `agentsDesired`/`modelFallback`/`terminalInputEnabled` now round-trip through the 3 store modules' own raw field accessors instead of the retired files, preserving the same "operator never set it" vs "explicitly configured" distinction on both sides.
- migrate kanban-audit-state.json to agent_state (group 4/8 item 2A)
- migrate context-restart-gate run-state to SQLite (group 4/8 part 1)
- supplement egress-allowlist seed with 7 post-authoring hosts
- migrate agent-settings config to SQLite (group 3/8)
- migrate schedule last-run/tick state from JSON to SQLite (group 2/8)
- migrate egress allowlist from JSON file to SQLite (group 1/8)
- cost calc and reasoning breakdown for thinking tokens
- track thinking tokens in summary/dist/stats, fix cache upsert
- search UI + pager (P2c frontend)
- server-side pagination for search (P2c backend)
- per-column "load more" for the flat board (P1c)
- backend support for per-status paginated loading (P1c)
- server-side pagination for the workspace docs list
- server-side pagination for the approvals list
- server-side pagination for the ideas list
- server-side pagination for the artifacts list
- add shared pagination param helper and index migration
- add send-digest-email.py Gmail REST digest sender
- **[API]** Server-side offset/limit pagination across all dashboard list views: shared `parsePagination()` helper and `{items,total,offset,limit}` response contract applied to `GET /api/artifacts`, `/api/ideas`, `/api/approvals`, `/api/workspace`, `/api/kanban?status=`, and `/api/import/search`. New migration `0055_pagination_indexes.sql` (kanban status+sort_order, idea_box tenant+created_at, workspace_docs tenant+created_at). Kanban board gains per-column "load more" (20 cards/column). Import Memories page gets its first frontend search UI.
- **[API]** Model-profile map (`premium_reasoning`/`build_strong`/`analysis_efficient`/`routine_lowcost` -> concrete model id) moved from `store/model-profile-map.json` to a new `model_profile_map` DB table (migration 0054, schema + baked default seed with `INSERT OR IGNORE`). Reads via 90s TTL cache; new `GET`/`PATCH /api/model-profiles` admin route invalidates cache on write. New Settings "Model profiles" tab. The example config file and manual install step are removed; fleet-transfer and fork-guide docs updated.
- **[API]** Autonomy categories (`GET`/`POST /api/autonomy`) moved from `store/autonomy-config.json` to a new `autonomy_categories` DB table, seeded via baked migration with `INSERT OR IGNORE` per key so operator edits are never overwritten. If the DB is unreachable, `GET /api/autonomy` returns `503`; agents should fall back to level 1. Fleet export/import and agent CLAUDE.md templates updated.
- **[API]** WebFetch egress allowlist moved from `store/egress-allowlist.json` to a new `egress_allowlist` DB table (migration `0056`, baked seed of the 199 previously-file-managed domains via `INSERT OR IGNORE`, tenant-scoped). New `GET`/`POST /api/v1/egress-allowlist` and `DELETE /api/v1/egress-allowlist/:id` routes (non-admin restricted to their own tenant). The `egress-gate.mjs` PreToolUse hook runs outside the backend process, so it now calls the new endpoint with a small disk-backed ~30s cache and falls back to reading the JSON file directly if the dashboard is unreachable -- the file is left in place (already gitignored) purely as that fail-safe. Fleet export/import updated to the DB-backed row-array shape (still union/merge semantics on import, never overwrite).
- Help chapter index (`#help`) with a new sidebar nav link listing every user guide and install/ops guide chapter, language-aware, linking into the dashboard's own help viewer. **[API]** New `GET /api/docs/<path>` route serves user-guide and fork-guide markdown over HTTP (allowlisted paths, path-traversal guarded, RBAC: `memories:read`). Every dashboard view's "? Sugó"/"? Help" link now opens the in-dashboard viewer.
- Settings screen regrouped from 15 individual module tabs into 9 fixed section tabs: Rendszer, Csatornák & Biztonság, Ágensek & Heartbeat, Kanban, Memória & Munkadokumentumok, Fleet monitor, Adatmegőrzés & Megfigyelhetőség, Autonómia, Budgetek & Claude csomagok. Frontend-only; no registry key or API shape changed. New `scripts/settings-verify.sh` for before/after deploy diffs.
- **[API]** Unified kanban card search: `GET /api/kanban/search?q=` matches across active and archived cards by running number (`#NNN`), hex id prefix, or title/project/assignee substring, ranking active cards first. Dashboard gains a global sidebar search box (any page, debounced, min 2 characters).
- `config-overrides.json` fully retired through a 3-phase migration: settings now persisted exclusively in `system_config` DB (idempotent backfill, write-path switch to DB, then file renamed to `.deprecated`). `cfg()` resolution chain is now `system_config` > `/run/secrets/<KEY>` > `.env`. A key that only lived in `config-overrides.json` and was never migrated no longer resolves - intentional behavior change.
- **[API]** `GET /api/settings` now exposes masked secrets (`TELEGRAM_BOT_TOKEN`, `ALLOWED_CHAT_ID`) as `***` instead of omitting them; `POST /api/settings` opens an admin-only write path for them (re-submitting `***` is a no-op). New masked-secret editor UI on the Settings Channels tab.
- Install-time seeding of the default tenant's `main_agent_id` and optional `display_name`; new `system_config` key/value table as foundation for DB-backed runtime configuration. `cfg()` now checks `system_config` first; `setOverride()` writes exclusively to `system_config`.
- Unit test coverage for `store-watcher`, `telegram-inbox-wake`, `graph-mail`, `context-guard-runner` (prompt-builders and orchestration), `claude-credentials-guard` token-lifecycle functions, `google-api`, `context-restart-gate-runner`, `inbox-nudge-watcher`, `stuck-input-watcher`, `update-checker`, `command-task`, `stuck-tool-call-watcher`, raising all from near-0% to substantial coverage.
- Unit test coverage for 10 additional previously-untested modules: `keychain`, `voice-modality`, `blackboard-stale-sweeper`, `federation/local-catalog`, `channel-plugin-unlock`, `model-fallback-store`, `context-restart-gate-store`, `openrouter-models`, `mcp-list`, `federation/capability-runner`.
- Unit test coverage for route surfaces: `background-tasks.ts`, `onboarding.ts`, `fleet.ts` (export/import), `agent-taskstate.ts`, `fleet-q.ts`, `docs.ts` (all previously at 0%), plus incremental coverage lift for `settings.ts`, vault-ssh, schedules, daily-log, voice, connectors, updates, tool-log, skills routes.
- CI gate (`scripts/check_commit_subjects.py`) catching internal kanban-rowid `#NNN` tokens in commit subjects and bodies; verifies bare `#NNN` references against GitHub API and explicit `upstream #NNN` against upstream repo.
- Audit trail: denied `no_pii_scrub` attempts, skipped scheduled tasks (not live / deduped per restart), and approval-timeout sweeps now each write `agent_audit_log` entries; audit-log dashboard highlights these with colored action badges.
- Scheduled-task review-gate UI (draft badge, activate button); PII scrub-before-persist for `agent_messages`; reference-based delivery for large task bodies (>1,500 chars snapshot to `store/scheduled-runs/`, 7-day retention).
- **[API]** `agent_messages` gains: `envelope` TEXT column for handoff payload on `assign:true` sends; `refused_reason`/`no_session_at` status markers; `complete:true` flag to close the sender's own blackboard row in the same call.
- **[API]** `GET /api/memories` gains opt-in `read_only` param (skips `accessed_at` stamp for inspection queries); offset-based pagination for plain listing with `{memories,total,offset,limit}` response shape and real `COUNT(*)`. The Memories page always sends `read_only=1`.
- **[API]** `GET /api/audit-log` gains offset-based pagination (`{entries,total,offset,limit}`, real per-source `COUNT(*)` sum); new shared `web/modules/paginator.js` component reused for memories and archived-kanban pages.
- **[API]** `GET /api/token-usage/summary`, `/model-dist`, and `/tool-stats` gain a `totalThinking` field (`SUM(thinking_tokens)`); Token Monitor cost calculation now bills thinking tokens at the output rate and shows an estimated "Reasoning" line/column when present. `token_usage`'s ON CONFLICT UPDATE upsert now backfills `cache_creation_tokens`/`cache_read_tokens` the same way it already did for `thinking_tokens`, instead of leaving a duplicate row's first (often zero) cache values in place.
- **[API]** Admin-only subscription quota strip on the Overview page (5h + 7d window, bar + percentage + reset countdown), reading from `store/.claude-rate-limits.json` via `scripts/statusline-ratelimit.sh`, wired as the Claude Code `statusLine` command in both `.claude/settings.json` and `templates/settings.json.template`.
- **[API]** `GET /api/memories?q=` now includes workspace docs by default (`WORKSPACE_DOC_RECALL_DEFAULT` setting, default true); explicit `include_docs=0/1` always overrides. Workspace docs get full FTS+vector hybrid search (RRF fusion) with embeddings generated on save/patch and a startup backfill. Tenant-scoped at SQL level with defence-in-depth post-filter.
- **[API]** `GET /api/agents` / team graph surface tenant `main_agent_id` as a colored "foügynök" badge; fleet blackboard rows open a history modal; approvals nav badge polls `GET /api/approvals?status=pending` at boot and every 5 minutes.
- **[API]** Blocked/waiting provenance: `fleet_blackboard` gains `blocked_by`/`blocked_reason`; `kanban_cards` gains `blocked_by`/`blocked_reason`/`waiting_for`/`resolved_by` - all nullable. Surfaced as blackboard badge tooltip, history modal entry, and kanban card detail "Mire vár?" field.
- Fleet export/import now covers: DB-based `schedules` table (force-disabled on import); `import_sources` (force-disabled, `last_run_at` cleared); additional `store/*.json` config fields (`model-fallback.json`, `federation.json`, `costops-config.json`, `egress-allowlist.json` merged/unioned); `vault_ssh_keys`/`vault_ssh_servers` metadata (private key travels in encrypted export only).
- Confluence Cloud connector for the import-memories pipeline: cursor-paginated, incremental sync by page `version.createdAt`, per-source vault token, 429 Retry-After honored, one-source-failure does not abort the crawl. Dashboard "Add import source" form gains a Confluence option.
- Budget-plafon alert: `evaluateBudgets()` checks configured budgets against current token volume (24h warning / 6h hard cooldown), notifies channel. Admin CRUD API (`GET/POST/PUT/DELETE /api/costops/budgets`) with live status enrichment; Settings "Budgets" tab with full CRUD and a status widget on the Token Monitor page.
- Context-guard daily-handoff tier (`dailyHandoffEnabled`/`dailyHandoffTime` on `ContextGuardConfig`): requests HANDOFF.md + fresh restart at a fixed local wall-clock time each day, ranked below wedge/idle-flush tiers. Default off; existing configs cannot switch it on.
- Claude Plans registry DB mirror (`claude_plans_registry`) and per-agent active-plan lifecycle table (`agent_active_plans`): deactivated on blackboard done/stale/clean-stop, swept after idle; `GET /api/blackboard` gains `activePlan` field; dashboard blackboard panel shows inline plan-type chip.
- **[API]** OTel instrumentation: `tool.call` span gains `mcp_tool` attribute; `agent.turn`/`model.call` spans from context-watchdog PostToolUse hook; OTLP push exporter with SHA-256-derived valid hex trace/span ids; `trigger_source` column on `hook_audit_log`.
- Context-guard extended to all persistent fleet sub-agents; context-restart-gate proactive `/clear` gate with fail-closed live-work detection; auto-skillify PreCompact hook; deferred-MCP ToolSearch protocol wired fleet-wide; context-watchdog HANDOFF injection gated on sub-agent field to prevent state leakage.
- Security hardening: opt-in `scripts/hooks/browser-content-notice.py` (PostToolUse untrusted-content envelope for browser/search tools); `scripts/hooks/destructive-gate.py` fleet-wide activated via `injectDestructiveGate()`; file-based credential materializer for MCP servers; vault-backed injection for HTTP MCP server headers; Tenant-IDOR verified closed on the vector search ANN path.
- Upstream backport (selective cherry-pick): macOS installer offers Discord with Linux parity; Slack managed-settings writes atomic; fleet hooks moved to project-scoped `.claude/settings.json`; Claude Plans rotation logic, write API, dashboard UI, and channel heartbeat wiring; watchdog self-locates fleet root; config-root watchdog reads from actual config dir.
- Dashboard UX additions: row-click detail modals and audit export on audit trail and approvals; workspace docs list/view/delete page; B2B admin hard-delete for tenants and users with user edit modal; self-service profile page; Ideas import source UI (Confluence); archived kanban pagination.
- **[API]** Skill read path moved to SQL (`GET /api/agents/:name/skills` reads from `skills` SQL table); dual file-write retired (create now materializes via `regenSingleSkillFile()`); PostToolUse hook syncs SKILL.md edits to SQL.
- **[API]** DB-based `schedules` table with tenant scoping; SQL-backed partner sender allowlist; B2B tenant and user management API; `tenant_id` scoping across memories, kanban, messages routes.
- Memory graph v2: single-round-trip endpoint, cinematic render, semantic edge layer, timeline mode, dark-glass detail card, memory links table with link-maintenance heartbeat; cross-encoder reranker (Xenova/bge-reranker-base); ANN semantic search via sqlite-vec.
- **[API]** Artifact store (local artifact DB, Bearer-gated CRUD, FTS5 + vector semantic search, cloud-sync hook, HMAC view-token); OTel distributed trace waterfall for inter-agent messages; branch-drift warning; remote-enroll with dashboard token; optional browser login; Microsoft Graph mail module; MCP capability scope per agent.

### Documentation

- log fast-uri/ip-address npm audit high-sev fix
- log thinking-token tracking + cache upsert fix
- editorial trim of [Unreleased] section
- sync README fork-diff and user guide with the P2c search feature
- document the pagination-dashboard feature

### Infrastructure

- retire context-compact-monitor.sh in favor of the proactive PostToolUse hook, and the interlock stamp/validation counter that gated its removal
- fix seed-count assertions stale after quarantine supplement
- scrub internal workspace-doc id from group 1 comments
- drop internal kanban-id reference from test names
- bootstrap the auto-sha marker to current HEAD

### Removed

- **[API]** `GET /api/hook-audit/watchdog-cycles` removed along with `src/watchdog-validation.ts` (the interlock-stamp validation counter it read, itself retired now that `context-compact-monitor.sh` and `store/context-compact-state.json` are gone). Internal/admin route, never documented in `docs/openapi.yaml`, no SUNSET-tracked alias. `hook_audit_log`'s `handoff` rows (the real audit trail) and migration 0038's `trigger_source` column are unaffected.
- **[API]** `tool_call_log` table and its prune endpoint retired; `GET /api/tool-log`/`GET /api/tool-log/analyze` now read from `otel_spans`. `POST /api/tool-log` (writer) keeps its existing shape. **BREAKING** on internal audit-writer contract: calls missing `trace_id` or `agent_id` are dropped (logged as warning) instead of stored with null columns.
- Dashboard Napló audit-timeline page removed (nav link, IIFE, i18n keys, CSS); shared `GET /api/audit-log` backend is untouched.
- Overview Fleet Health strip (`#fleetHealthBar`); underlying counters remain, feeding the Attention Required panel.
- Legacy workspace scan/import (`POST /api/migrate/scan`, `/run`); the Fleet Export/Import half of the page is untouched.

### Fixed

- `updateEnvFile()` loosened `.env` to the umask default (typically 0644) on every write, because it went through `atomicWriteFileSync` without a mode. It now preserves the existing file's mode, and a newly created `.env` is 0600. An already-loosened `.env` is not tightened retroactively: run `chmod 600 .env` once.
- Main agent model resolution had two different readers: `scripts/channels.sh`'s `resolve_main_model()` (initial launch) already preferred `.env MAIN_AGENT_MODEL` over `.claude/settings.json .model`, but `channel-monitor.ts`'s soft-resume reader and `model-fallback-runner.ts`'s fallback-chain reader each read `settings.json` only -- so a `.env`-only model change silently reverted on the next soft resume (`--continue`) or fallback-runner restart. Both now resolve through a single new `readMainModelRaw()` (`agent-config.ts`), matching `channels.sh`'s own precedence exactly. `writeMainModel()` now writes only `.env` (`.claude/settings.json` is a tracked file, not per-install state, and no longer touched here).
- bump fast-uri and ip-address to resolve npm audit high-sev finding
- revert file-level enabled:false reconciliation
- honor a file-level enabled:false even after DB seeding
- **Security:** `fast-uri` (transitive via `ajv` <- `@modelcontextprotocol/sdk` <- `@anthropic-ai/claude-agent-sdk`) bumped 3.1.6 -> 3.1.8, resolving a high-severity authority-injection / host-confusion advisory (GHSA-qw65-cvwx-89v3, GHSA-58mr-gqgx-xq4g). `ip-address` bumped 10.5.0 -> 10.7.2 in the same pass (moderate SSRF advisory, same transitive chain via `express-rate-limit`). Both are non-breaking in-range lockfile bumps; neither is a direct dependency.
- **Reverted:** `listScheduledTasks()`'s file-level `enabled: false` reconciliation (previous entry below) is reverted. Every task's on-disk `task-config.json` in this fleet carries a vestigial `enabled: false` default that was never the operative signal (the `schedules` DB row was the actual source of truth), so the reconciliation read that stale `false` on every task and force-disabled all of them in the DB on first read after deploy -- the scheduler stopped firing entirely. `listScheduledTasks()` goes back to reading the DB row exclusively once a task is seeded there; the file is informational only in that mode. `enabled: false` from a hand-edited file is no longer honored in DB-seeded mode.
- **[API]** `generate-error-schema.mjs` idempotency: Error-enum replacement in `docs/openapi.yaml` no longer appends an extra blank line on each run.
- Context-guard "every tier off" early-out now also checks `dailyHandoffEnabled` (previously an agent with only the daily-handoff tier armed was treated as fully disarmed).
- Audit `principal` field: new `principalSource` sibling records the auth mechanism (`session`/`token`/`peer`/`device`/`unknown`). Registered API token names now resolve correctly. `authPrincipal(ctx)` reads from the auth gate, never from the request body.
- Absolute install paths removed from `fleet-heartbeat-sweep.sh`, `auto-skillify.py`, `skill-sql-sync.py` - each now self-locates relative to its own file path.
- `agent_messages` missing columns repaired by migration 0048 for tables created by the channel-coordinator boot-race path. `applyMigration()` now applies `ALTER TABLE ADD COLUMN` statements tolerantly (per-statement, skipping "duplicate column" errors).
- Context-watchdog `write_token_row()` no longer commits early, restoring atomicity with subsequent span writes.
- `pruneOtelSpans()`, `pruneConversationLog()`, `pruneAgentMessages()`, `pruneHookAuditLog()` wired into daily sweeps - all four tables previously grew unbounded.
- Tenant scoping fixes: `GET /api/blackboard`/history scoped to caller's tenant; `GET /api/agents`/detail scoped to `tenant_agent_availability` matrix with `mcpJson` redacted for non-admin; Vault and SSH server routes tenant-isolated; import sources and `import_audit_log` tenant-scoped; memory stat cards, graph, and timeline tenant-scoped.
- **[API]** `GET /api/status` de-duplicates service tiles by name; `loadStatus()` deduplicates concurrent client-side calls.
- Scheduler Telegram alerts removed for downtime catch-up, pending-retry-stuck, and task-timeout - logged/dashboard only. Scheduled tasks' own result notifications are unaffected.
- Vault AES-256-GCM calls now pass explicit `authTagLength`; `decryptWithKey` gained corrupt-entry length guard. (defense-in-depth, not a fix for an exploited path)
- OTel export: `traceId`/`spanId` exported as deterministic SHA-256-derived hex (valid OTLP 32/16 hex chars), fixing silent 400 rejection by collectors.
- Vitest test runs no longer send real Telegram messages (network call short-circuits under `process.env.VITEST`).
- `hardRestartMarveenChannels()` falls through to `respawn-pane` for an orphaned launchd job instead of timing out with `ETIMEDOUT`.
- `DELETE /api/mcp-catalog/:id/uninstall` purges the in-memory MCP list cache immediately instead of waiting for the 30s background refresh.
- `GET /api/schedules` in DB-mode applies `rowToTask()` mapper (fixes missing `name` field causing silent 404 on delete/toggle/run); `writeScheduledTask` tenant_id no longer resets to null on toggle/edit.
- Context-watchdog HANDOFF-emission gated on sub-agent field in hook payload (prevents fleet state leaking into spawned sub-agent context); token-usage and OTel span writes still run for sub-agents.
- Agents screen: org-chart now shows admin-only tenant chip via `tenantSummaryFields()`; grid card loop skips the main agent to prevent the duplicate pinned card.
- `vault-file-materializer` stdin fix: `"$@" <&0 &` restores stdin for stdio MCP servers (was `/dev/null` by POSIX async default, breaking Garmin MCP login).
- Security: `no_pii_scrub` bypass gated behind human admin session; Host header validation against DNS-rebinding; `javascript:`/`data:`/`vbscript:` links neutralized in `mdInline`; strict hostname validation replacing substring allowlist.
- B2B/RBAC i18n: ~55 missing translation keys added (admin, RBAC nav, profile pages); permission matrix and screen-access matrix unified to one visual system.
- Npm audit security fixes: `qs` (ReDoS), `adm-zip` (high), `xlsx` replaced by `exceljs` (high), `sharp` overridden (libvips CVEs).
- Install/startup: npm-prefix writability pre-flight; macOS version pre-flight; node@22 pin for launchd services; WEB_PORT propagation throughout; lsof absolute path; single-instance reclaim (macOS); `bun` PATH added to `~/.profile` on Linux.
- Scheduler: stop re-alerting on still-dead agent every 30 minutes; per-task stuck threshold; daily-handoff early-out fix; sub-agent context leak prevention; task-dispatch loop and heartbeat fixes.

### Changed

- reasoning/cache-write labels for hu.js and en.js
- **[API]** Error response shapes normalized to snake_case tokens across all routes (B1-B15 normalization passes); disabled schedule run returns 409; `GET /api/messages` unknown-param normalized.
- Fleet blackboard stale-sweeper now also ages out `assigned` rows (delegated but never picked up), transitioning them to `stale` via a flat threshold.
- Dashboard modularization: agent-scaffold split into hooks + templates; `agents.js` split into 5 files; `connectors.js` split into connectors/vault; Canvas graph engine extracted to `memory-graph.js`; `agent-process.ts` split into spawn/session/config/identity; `db.ts` split by domain.
- Collapsible sidebar groups (5 groups, declarative re-parenting); Archived cards moved from sidebar into Kanban header; back button added.
- CI: GitHub Actions pipeline added and optimized; Python tests, Shell tests, npm audit, `oasdiff` breaking-change detection, `generate:sdk` diff check all gated; coverage gate fixed (was silently never enforced due to misplaced config block).
- `generate-changelog.mjs` made incremental via `<!-- changelog-auto-sha: <sha> -->` marker - no longer overwrites hand-written entries on each run.
- Dependency bumps: Node.js 20->22, TypeScript 5.9->7.0, vitest 2.1->5.0, pino 9->10, better-sqlite3 11->13; various minor/patch group updates.
- **[API]** API deprecation policy documented; URL-level versioning with `/api/v1/*` canonical paths; OpenAPI 3.1 spec with operationIds; custom OpenAPI->TypeScript SDK generator.

## [1.33.0] - 2026-08-18

### Added

- Bridge: service-port allowlist enforced in permitopen, managed server-side
- Hooks: persist the outgoing-copy gate (script + hook wiring survive checkout)
- Hooks: missing name-rules file now causes email fail-closed, telegram loud systemMessage
- Channels: launchd port of the idle-path keepalive probe
- Channels: redacted pane diagnostics on stage-1 reconnect failures
- Updates: show the running version in the Updates page header
- Context-guard: idle-flush tier for heavy sessions that have gone quiet
- Egress-gate: payload-field recording and quarantine tier
- Telegram: enforce reply-tool with a Stop hook and directive
- Alerts: report wedge recoveries and long channel outages to the owner

### Fixed

- Schedule-runner: a parked prompt fragment deferred every scheduled task forever
- Update: Node pin never resolved on macOS, so the build used the wrong major
- Stuck-tool-call-watcher: arriving message must not open gate on stale evidence
- Kanban: an agent picking up its own card got the task dispatched back at it
- Agents: stop the tmux session on delete so no orphan ghost returns
- Vault: store the SSH import key with the newline it was validated with
- Kanban: self-heal updated_at on raw SQL status writes
- Context-restart-gate: completion reports are not dispatched work
- Agents: isolated settings.json lost keys the shared file never mentions
- Model-fallback: add 'session limit' variant to USAGE_LIMIT_RX
- Slack: expose hasSlack in agent summary so the dashboard shows sub-agent Slack config
- Ledger: keep voice/video_note attachment identity so a respawned session can still transcribe

## [1.32.1] - 2026-08-11

### Fixed

- Onboarding: the auth check trusts a running authenticated fleet, not just storage
- Self-pace-gate: stop quoted prose from faking a command position

### Documentation

- Onboarding: spell out that the running-fleet auth leg is presence-only, not validity

## [1.32.0] - 2026-08-09

### Added

- Scaffold: teach every agent the deferred-MCP ToolSearch protocol
- Context-restart-gate: proactive /clear gate with fail-closed live-work detection
- Support-mail: split login mailbox from outgoing From address

### Fixed

- Heartbeat: teach the scaffold the deferred-MCP ToolSearch protocol
- Router: session-stuck escalation and working-session silence
- Hooks: capture Telegram message_id in outbound ledger entries
- Scheduler: a pending retry survives a missing target session
- Scheduler: both resubmit dead ends enqueue the never-abandon pending retry
- Install: report zstd version in the dependency check summary
- Heartbeat: remove the unfalsifiable warnings metric
- Heartbeat: the hot-memory metric ships as a ready-made query, not prose

## [1.31.0] - 2026-08-07

### Added

- Install: probe the entered Telegram bot token and speak the findings
- Channels: reject a busy Telegram bot token at save time with a human remedy

### Fixed

- Respawn: every respawn path resolves the main model through the one three-layer resolver
- Model-suggest: the top-tier recommendation is the distribution default, never a 4.8 literal
- Install: the not-started remedy now works on an unregistered launchd unit
- Guard: disk-space reaper was a silent no-op on macOS; repair two shell tests

### Documentation

- Model-suggest: correct the measured before-figures in both comments

## [1.30.0] - 2026-08-04

### Added

- **[API]** Skill usage stats endpoint and LRU sort in the dashboard
- Fleet Blackboard: shared status API and Overview widget
- Web: lazy-load JS modules on first navigation

### Fixed

- Web: lazy-load regression fixes (boot-crash, overlay-on-all-async)
- DB: reduce SQLite page cache and mmap size
- i18n: add missing KANBAN_WIP_TESTING description key in hu/en
