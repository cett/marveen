import { describe, expect, it } from 'vitest'
import { existsSync, readFileSync, statSync, mkdtempSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import Database from 'better-sqlite3'
import { HEARTBEAT_NEW_HOT_MEMORIES_SQL } from '../db.js'
import {
  buildHeartbeatSummaryResponse,
  HEARTBEAT_SUMMARY_TITLE_MAX,
  HEARTBEAT_SUMMARY_WAITING_CAP,
} from '../web/routes/kanban.js'

// Consolidated heartbeat unit/contract tests -- item #8 of the #780 test
// consolidation (heartbeat cluster). Merged from heartbeat-claude-json-bridge,
// heartbeat-hot-memory-count, heartbeat-oauth-token and
// heartbeat-summary-truncation-safe, all of which use readFileSync-on-source
// (raw-text contract assertions) plus, for hot-memory-count, a real
// in-memory-ish better-sqlite3 fixture -- no mocks anywhere, so no vi.mock
// conflict across the four. heartbeat-agent-scaffold.test.ts (DB-mocked, 29
// tests) and heartbeat-worker-isolation.test.ts stay untouched per Boo's plan.

const ROOT = join(__dirname, '..', '..')

// --- heartbeat-claude-json-bridge fixtures ---

const HB_SRC = readFileSync(join(__dirname, '../heartbeat.ts'), 'utf-8')
const CFG_SRC = readFileSync(join(__dirname, '../web/agent-config.ts'), 'utf-8')

// --- heartbeat-oauth-token fixtures ---

// Security contracts -- enforced on the canonical implementation in claude-credentials.ts
const SRC_CREDS = readFileSync(join(__dirname, '../web/claude-credentials.ts'), 'utf-8')
// Heartbeat-level contracts -- call site in ensureHeartbeatWorkerCwd
const SRC_HEARTBEAT = readFileSync(join(__dirname, '../heartbeat.ts'), 'utf-8')

// --- heartbeat-hot-memory-count fixtures ---

function fixtureDb() {
  const dir = mkdtempSync(join(tmpdir(), 'hb-hotmem-'))
  const db = new Database(join(dir, 'test.db'))
  db.exec(`CREATE TABLE memories (
    id INTEGER PRIMARY KEY, agent_id TEXT, category TEXT, content TEXT, created_at INTEGER
  )`)
  const ins = db.prepare('INSERT INTO memories (agent_id,category,content,created_at) VALUES (?,?,?,?)')
  return { db, ins }
}

// --- heartbeat-summary-truncation-safe fixtures ---

function card(id: string, title: string, status: string, updated_at: number) {
  return { id, title, status, priority: 'normal', assignee: null, updated_at }
}

function bigSummary() {
  const waiting = Array.from({ length: 280 }, (_, i) =>
    card(`W${i}`, 'x'.repeat(15_000), 'waiting', 1000 + i))
  const urgent = Array.from({ length: 4 }, (_, i) =>
    card(`U${i}`, 'sürgős '.repeat(400), 'planned', 2000 + i))
  return { urgent, in_progress: [], waiting }
}

const KANBAN = readFileSync(join(ROOT, 'src', 'web', 'routes', 'kanban.ts'), 'utf-8')
const SCAFFOLD = readFileSync(join(ROOT, 'src', 'web', 'heartbeat-agent-scaffold.ts'), 'utf-8')

// Contract tests for the 2026-06-02 14:27 hb-fire regression (#252 follow-up):
//   - Sub-agent ran without 'Not logged in' (Claude API auth fine), but
//     Gmail OAuth was gone and Calendar fell back to the wrong default
//     account because user-level project-scope MCPs live in ~/.claude.json
//     under projects[<cwd>], which the symlink loop missed (HOME root, one
//     level UP from ~/.claude/).
//   - Fix: copy ~/.claude.json into the isolated config dir and duplicate
//     projects[PROJECT_ROOT] under projects[HEARTBEAT_AGENT_CWD].
//   - Plus: dashboard-hide sentinel so the heartbeat-worker dir doesn't
//     pollute the agent list (Szabi 14:31 ask).
describe('heartbeat ~/.claude.json bridge (2026-06-02 14:27 regression fix)', () => {
  it('reads the real ~/.claude.json from HOME (not from CLAUDE_CONFIG_DIR)', () => {
    expect(HB_SRC).toMatch(/homedir\(\),\s*'\.claude\.json'/)
  })

  it('writes the parsed JSON into HEARTBEAT_CONFIG_DIR/.claude.json with mode 0600', () => {
    expect(HB_SRC).toMatch(/HEARTBEAT_CONFIG_DIR.*\.claude\.json/s)
    // The auth-equivalent file must have the same 0600 mode as
    // .credentials.json -- a world-readable .claude.json with the
    // oauthAccount key would leak the user id.
    const start = HB_SRC.indexOf('heartbeatClaudeJsonPath')
    expect(start).toBeGreaterThan(0)
    // The next writeFileSync that targets heartbeatClaudeJsonPath must
    // pass mode 0o600. Slice from the first `writeFileSync(heartbeatClaudeJsonPath`
    // to the end of that call and look for 0o600 anywhere inside.
    const writeIdx = HB_SRC.indexOf('writeFileSync(heartbeatClaudeJsonPath', start)
    expect(writeIdx).toBeGreaterThan(0)
    const callEnd = HB_SRC.indexOf('})', writeIdx)
    expect(callEnd).toBeGreaterThan(writeIdx)
    const callBody = HB_SRC.slice(writeIdx, callEnd + 2)
    expect(callBody).toMatch(/0o600/)
  })

  it('duplicates projects[PROJECT_ROOT] into projects[HEARTBEAT_AGENT_CWD]', () => {
    // The Claude Code TUI keys project-scope MCPs by absolute cwd. The
    // heartbeat sub-agent runs in agents/heartbeat-worker, so an empty
    // entry there means no MCPs visible. Duplicating the PROJECT_ROOT
    // entry under the new key lets the sub-agent inherit Marveen's
    // Gmail + Calendar MCPs without any other change.
    expect(HB_SRC).toMatch(/projects\[PROJECT_ROOT\]/)
    expect(HB_SRC).toMatch(/projects\[HEARTBEAT_AGENT_CWD\]/)
  })

  it('refuses to clobber an existing projects[HEARTBEAT_AGENT_CWD] entry', () => {
    // If a prior tick wrote a curated entry we should not stomp it.
    // Guard with `!projects[HEARTBEAT_AGENT_CWD]` (only set when absent).
    expect(HB_SRC).toMatch(/!\s*projects\[HEARTBEAT_AGENT_CWD\]/)
  })

  it('failure to copy ~/.claude.json is non-fatal (warn, do not abort)', () => {
    // The auth path is still good (CLAUDE_CONFIG_DIR + .credentials.json),
    // so a parse error on ~/.claude.json must not break the heartbeat.
    // Warn and continue.
    const idx = HB_SRC.indexOf('failed to materialise .claude.json')
    expect(idx).toBeGreaterThan(0)
    const window = HB_SRC.slice(Math.max(0, idx - 200), idx)
    expect(window).toMatch(/catch/)
  })
})

describe('dashboard-hide sentinel (Szabi 2026-06-02 14:31 ask)', () => {
  it('agent-config exports HIDDEN_AGENT_SENTINEL', () => {
    expect(CFG_SRC).toMatch(/export const HIDDEN_AGENT_SENTINEL = '\.hidden-from-dashboard'/)
  })

  it('listAgentNames filters out directories containing the sentinel', () => {
    expect(CFG_SRC).toMatch(/HIDDEN_AGENT_SENTINEL/)
    expect(CFG_SRC).toMatch(/existsSync\(join\(AGENTS_BASE_DIR,\s*f,\s*HIDDEN_AGENT_SENTINEL\)\)/)
  })

  it('heartbeat ensures the sentinel exists in agents/heartbeat-worker/', () => {
    expect(HB_SRC).toMatch(/sentinelPath\s*=\s*join\(HEARTBEAT_AGENT_CWD,\s*'\.hidden-from-dashboard'\)/)
    expect(HB_SRC).toMatch(/writeFileSync\(sentinelPath/)
  })

  it('sentinel write is idempotent (skip if already present)', () => {
    const idx = HB_SRC.indexOf('sentinelPath')
    expect(idx).toBeGreaterThan(0)
    const window = HB_SRC.slice(idx, idx + 400)
    expect(window).toMatch(/!existsSync\(sentinelPath\)/)
  })
})

// HBMEMBLIND819: the heartbeat's "new hot memories (1h)" line said 0 for
// 14/14 rounds over 24h while the real value was 2 in three of them. Second
// failure of the prescribe-the-query pattern for this metric (HBMEMBLIND807
// was the first): the agent ran the prescribed query SHAPE but substituted
// agent_id='heartbeat' for the main agent's id on post-compact rounds, and
// the wrong form then persisted as its own precedent. The closure is the same
// one the kanban counts already use: the number is computed server-side and
// served over /api/kanban/heartbeat-summary; the agent copies it and never
// runs a query. These tests pin BOTH halves: the shipped SQL counts the right
// rows, and the scaffold no longer tells the agent to run anything for it.
describe('HEARTBEAT_NEW_HOT_MEMORIES_SQL (the shipped statement, on a fixture DB)', () => {
  it('counts only the given agent, only hot, only the last hour', () => {
    const { db, ins } = fixtureDb()
    const now = Math.floor(Date.now() / 1000)
    ins.run('marveen', 'hot', 'fresh main-agent hot #1', now - 60)
    // Margin widened from -3599 (2026-08-23, CI flake): the SQL computes its
    // own boundary via unixepoch() at QUERY time, not from this JS `now`. A
    // 1-second margin means any wall-clock delay between capturing `now` and
    // the query running (DB setup, CI load) can push the row just outside the
    // window, flipping the count from 2 to 1. -3500 leaves 100s of slack.
    ins.run('marveen', 'hot', 'fresh main-agent hot #2', now - 3500)
    // The exact wrong-row family HBMEMBLIND819 measured: the heartbeat's OWN
    // id. It must not be countable by accident when the caller passes the
    // main agent's id.
    ins.run('heartbeat', 'hot', 'heartbeat own hot', now - 60)
    ins.run('marveen', 'hot', 'main-agent hot but old', now - 3700)
    ins.run('marveen', 'warm', 'fresh but warm', now - 60)

    const forMain = db.prepare(HEARTBEAT_NEW_HOT_MEMORIES_SQL).get('marveen') as { n: number }
    expect(forMain.n).toBe(2)

    // And the failure shape itself, replayed: querying with the heartbeat's
    // own id sees a different world -- which is WHY the id must be supplied
    // server-side, not reconstructed by the agent.
    const forHeartbeat = db.prepare(HEARTBEAT_NEW_HOT_MEMORIES_SQL).get('heartbeat') as { n: number }
    expect(forHeartbeat.n).toBe(1)
  })

  it('empty table -> 0, not NULL-shaped surprises', () => {
    const { db } = fixtureDb()
    const row = db.prepare(HEARTBEAT_NEW_HOT_MEMORIES_SQL).get('marveen') as { n: number }
    expect(row.n).toBe(0)
  })
})

describe('wiring contract: the number flows endpoint -> agent, never agent -> query', () => {
  const KANBAN_LOCAL = readFileSync(join(ROOT, 'src', 'web', 'routes', 'kanban.ts'), 'utf-8')
  const SCAFFOLD_LOCAL = readFileSync(join(ROOT, 'src', 'web', 'heartbeat-agent-scaffold.ts'), 'utf-8')

  it('heartbeat-summary serves counts.new_hot_memories_1h computed with MAIN_AGENT_ID', () => {
    // Anchor the window to the endpoint handler's own structural bounds
    // (start marker to the closing `return true`), NOT to the sought string --
    // a window derived from the needle grows until it contains it and the
    // assertion cannot fail (the #1006 review lesson).
    const start = KANBAN_LOCAL.indexOf("'/api/kanban/heartbeat-summary'")
    expect(start).toBeGreaterThanOrEqual(0)
    const end = KANBAN_LOCAL.indexOf('return true', start)
    expect(end).toBeGreaterThan(start)
    const handler = KANBAN_LOCAL.slice(start, end)
    // HBKANBANDRIFT819 moved the response shape into the pure builder; the
    // protected property is unchanged: the hot count is computed with the
    // MAIN agent's id and flows into the served response.
    expect(handler).toMatch(/buildHeartbeatSummaryResponse\([\s\S]*countNewHotMemories\(MAIN_AGENT_ID\)/)
    // And the builder puts it under counts (the copy-surface the scaffold names).
    const bStart = KANBAN_LOCAL.indexOf('export function buildHeartbeatSummaryResponse')
    expect(bStart).toBeGreaterThanOrEqual(0)
    const builder = KANBAN_LOCAL.slice(bStart, KANBAN_LOCAL.indexOf('\n}', bStart))
    expect(builder).toMatch(/new_hot_memories_1h:\s*newHotMemories1h/)
  })

  it('the scaffold tells the agent to COPY the field and forbids running a query for it', () => {
    expect(SCAFFOLD_LOCAL).toMatch(/counts\.new_hot_memories_1h/)
    // The memory bullet must not prescribe (or even show) a runnable
    // hot-memory SQL anymore -- that is the exact surface that drifted twice.
    expect(SCAFFOLD_LOCAL).not.toMatch(/FROM memories[\s\S]{0,120}category='hot'/)
    // Missing field degrades to "no data", never to a self-run query or a 0.
    expect(SCAFFOLD_LOCAL).toMatch(/nincs adat \(a summary nem adja\)/)
  })
})

// Contract tests for the 2026-06-02 13:00 hb-fire regression chain:
//   - #250 (CLAUDE_CONFIG_DIR) blocked the channel crash but broke auth.
//   - First fix attempt (#252) injected the Keychain JSON via the
//     CLAUDE_CODE_OAUTH_TOKEN env var. Marveen's live test proved that
//     was wrong: the env expects a bare bearer token, the JSON blob comes
//     back 401 "Invalid bearer token".
//   - This PR materialises the FULL Keychain JSON as
//     $CLAUDE_CONFIG_DIR/.credentials.json (mode 0600), which is the
//     path Claude Code's Linux installs use natively and the path the
//     SDK config-dir code honours. Marveen verified this approach
//     succeeds (exit 0, request authenticated).
//
// Refactor note (issue #5): readClaudeCodeOauthJson() was consolidated
// from a private heartbeat.ts copy into src/web/claude-credentials.ts.
// The security contracts and the ensureHeartbeatWorkerCwd assertions
// are split across the two source files accordingly.
describe('heartbeat OAuth bridge from Keychain to .credentials.json (#250 follow-up)', () => {
  it('helper is defined in claude-credentials.ts (consolidated from heartbeat.ts per issue #5)', () => {
    // The implementation lives in the shared module; heartbeat.ts imports it.
    expect(SRC_CREDS).toMatch(/function readClaudeCodeOauthJson\(\)/)
    expect(SRC_HEARTBEAT).toMatch(/readClaudeCodeOauthJson/)
  })

  it('shells out to /usr/bin/security via execFileSync (no shell, no string interpolation)', () => {
    expect(SRC_CREDS).toMatch(/execFileSync\(\s*'\/usr\/bin\/security'/)
    expect(SRC_CREDS).toMatch(/find-generic-password/)
    expect(SRC_CREDS).toMatch(/Claude Code-credentials/)
  })

  it('runs ONLY on darwin -- returns null on linux so the symlinked .credentials.json carries auth', () => {
    expect(SRC_CREDS).toMatch(/process\.platform !== 'darwin'/)
  })

  it('uses stdio:[ignore, pipe, ignore] so stderr cannot capture/leak the JSON', () => {
    expect(SRC_CREDS).toMatch(/stdio:\s*\['ignore',\s*'pipe',\s*'ignore'\]/)
  })

  it('refuses to log the JSON value or even the error detail (error may echo lookup key)', () => {
    // Slice from the function header to its first `^}` at column zero
    // so the assertion does not bleed into the next function.
    const start = SRC_CREDS.indexOf('function readClaudeCodeOauthJson')
    expect(start).toBeGreaterThan(0)
    const closeIdx = SRC_CREDS.indexOf('\n}\n', start)
    expect(closeIdx).toBeGreaterThan(start)
    const body = SRC_CREDS.slice(start, closeIdx)
    expect(body).not.toMatch(/logger\.[a-z]+\(\s*\{\s*err\b/)
  })

  it('writes the JSON to $HEARTBEAT_CONFIG_DIR/.credentials.json (NOT to an env var)', () => {
    expect(SRC_HEARTBEAT).toMatch(/\.credentials\.json/)
    // The env-var injection attempt was proved wrong (Marveen 13:00-13:20
    // A/B test: bare JSON in CLAUDE_CODE_OAUTH_TOKEN -> 401 "Invalid
    // bearer token"). The token name may still appear in comments
    // documenting the dead path; what must NOT exist is an assignment
    // to the runAgent env carrying that name.
    expect(SRC_HEARTBEAT).not.toMatch(/CLAUDE_CODE_OAUTH_TOKEN\s*[:=]/)
  })

  it('writes the credentials file with mode 0600 (owner-only read/write)', () => {
    expect(SRC_HEARTBEAT).toMatch(/mode:\s*0o600/)
  })

  it('still passes CLAUDE_CONFIG_DIR to runAgent (the #250 isolation gate stays in force)', () => {
    expect(SRC_HEARTBEAT).toMatch(/CLAUDE_CONFIG_DIR:\s*HEARTBEAT_CONFIG_DIR/)
  })

  it('credentials write happens inside ensureHeartbeatWorkerCwd, AFTER the symlink tree is built', () => {
    // Both the symlink loop and the credentials write must live in the
    // same setup function so a missing dir is created exactly once.
    const start = SRC_HEARTBEAT.indexOf('function ensureHeartbeatWorkerCwd')
    const closeIdx = SRC_HEARTBEAT.indexOf('\n}\n', start)
    const body = SRC_HEARTBEAT.slice(start, closeIdx)
    expect(body).toMatch(/symlinkSync/)
    expect(body).toMatch(/readClaudeCodeOauthJson\(\)/)
    expect(body).toMatch(/\.credentials\.json/)
    // Sanity: the credentials write must come AFTER the settings.json
    // write so a parse-error on settings.json does not abort the auth
    // material write half-way through.
    const settingsIdx = body.indexOf('settingsPath')
    const credIdx = body.indexOf('credPath')
    expect(credIdx).toBeGreaterThan(settingsIdx)
  })
})

// Live integration sanity (darwin only): exercise ensureHeartbeatWorkerCwd
// against a real ephemeral HEARTBEAT_AGENT_CWD and confirm the resulting
// .credentials.json is mode 0600 and contains the expected top-level
// `claudeAiOauth` key. We do NOT log the JSON content; we only inspect
// keys/permissions.
describe('ensureHeartbeatWorkerCwd materialises Keychain JSON (live, darwin only)', () => {
  const skip = process.platform !== 'darwin'

  it.skipIf(skip)('writes .credentials.json with mode 0600 + claudeAiOauth key', async () => {
    // The function uses fixed PROJECT_ROOT-derived paths, so we can't
    // sandbox it cleanly without invoking the real module. Instead,
    // observe the file the production code path produces on the next
    // heartbeat tick. If a previous deploy already created it, the
    // mode/key check is still a valid contract.
    const credPath = join(__dirname, '..', '..', 'agents', 'heartbeat-worker', '.claude-config', '.credentials.json')
    if (!existsSync(credPath)) {
      // First-run case: the file appears only after a real
      // ensureHeartbeatWorkerCwd call. Skip rather than spawn one from
      // a unit test (the module has init-time side effects we don't
      // want here).
      return
    }
    const st = statSync(credPath)
    const mode = st.mode & 0o777
    expect(mode).toBe(0o600)
    const parsed = JSON.parse(readFileSync(credPath, 'utf-8'))
    expect(parsed).toHaveProperty('claudeAiOauth')
    expect(parsed.claudeAiOauth).toHaveProperty('accessToken')
    // refreshToken is what lets the sub-agent renew without re-reading
    // the Keychain. Its absence would defeat the whole point of writing
    // the JSON blob rather than just an accessToken.
    expect(parsed.claudeAiOauth).toHaveProperty('refreshToken')
  })
})

// HBKANBANDRIFT819: the 16:42 heartbeat reported waiting:12 against a real
// 280. The endpoint's counts were CORRECT -- but the payload was ~31KB (board
// titles here run to 15KB each) and `counts` serialized LAST, so a reader
// that lost the tail lost exactly the numbers and counted the visible list
// instead. Same family as HBMEMBLIND807/819: the number's production must not
// depend on the measured party's reading stamina. Three properties pinned:
// counts-first ordering, server-side truncation, capped list with FULL totals.
describe('buildHeartbeatSummaryResponse (pure)', () => {
  it('counts is the FIRST serialized key, so truncated reads lose lists, never numbers', () => {
    const json = JSON.stringify(buildHeartbeatSummaryResponse(bigSummary(), 2, 305))
    expect(json.startsWith('{"counts":')).toBe(true)
    // The whole counts object must fit well inside any sane read window: the
    // first 200 bytes carry every number even if 99% of the payload is lost.
    const head = json.slice(0, 200)
    expect(head).toContain('"waiting":280')
    // planned has no list at all, so its ONLY existence is this number --
    // measured 2026-08-19 17:00: planned: 0 reported against a real 305.
    expect(head).toContain('"planned":305')
    expect(head).toContain('"new_hot_memories_1h":2')
  })

  it('counts.waiting is the FULL total, never the capped list length (the 2026-08-04 lesson in endpoint form)', () => {
    const r = buildHeartbeatSummaryResponse(bigSummary(), 0, 305)
    expect(r.counts.waiting).toBe(280)
    expect(r.waiting.length).toBe(HEARTBEAT_SUMMARY_WAITING_CAP)
    expect(r.waiting_shown).toBe(HEARTBEAT_SUMMARY_WAITING_CAP)
  })

  it('the waiting list carries the most recently UPDATED cards', () => {
    const r = buildHeartbeatSummaryResponse(bigSummary(), 0, 305)
    // Fixture updated_at grows with the index, so the newest ids are the highest.
    expect(r.waiting[0].id).toBe('W279')
    expect(r.waiting[HEARTBEAT_SUMMARY_WAITING_CAP - 1].id).toBe(`W${280 - HEARTBEAT_SUMMARY_WAITING_CAP}`)
  })

  it('every title is truncated server-side; short titles pass through untouched', () => {
    const r = buildHeartbeatSummaryResponse(bigSummary(), 0, 305)
    for (const c of [...r.urgent, ...r.waiting]) {
      expect(c.title.length).toBeLessThanOrEqual(HEARTBEAT_SUMMARY_TITLE_MAX + 1) // +1 for the ellipsis
    }
    const small = buildHeartbeatSummaryResponse(
      { urgent: [card('A', 'rövid cím', 'waiting', 1)], in_progress: [], waiting: [] }, 0, 0)
    expect(small.urgent[0].title).toBe('rövid cím')
  })

  it('the payload with 280 huge-titled cards stays small enough to never truncate in practice', () => {
    const json = JSON.stringify(buildHeartbeatSummaryResponse(bigSummary(), 0, 305))
    // Pre-fix this was ~4.2MB with these fixtures (280 x 15KB); the cap+trunc
    // must keep it in the low KB range.
    expect(json.length).toBeLessThan(10_000)
  })
})

describe('wiring: the endpoint serves the pure builder, the scaffold forbids counting lists', () => {
  it('the heartbeat-summary handler goes through buildHeartbeatSummaryResponse', () => {
    const start = KANBAN.indexOf("'/api/kanban/heartbeat-summary'")
    expect(start).toBeGreaterThanOrEqual(0)
    const handler = KANBAN.slice(start, KANBAN.indexOf('return true', start))
    expect(handler).toMatch(/buildHeartbeatSummaryResponse\(/)
    // planned must come from its sanctioned server-side counter, or the agent
    // manufactures it again (planned: 0 vs real 305, 2026-08-19 17:00).
    expect(handler).toMatch(/countPlannedKanbanCards\(\)/)
  })

  it('the scaffold says numbers come from counts.* only and names the drift incident', () => {
    expect(SCAFFOLD).toMatch(/EVERY NUMBER COMES FROM \\`counts\.\*\\`/)
    expect(SCAFFOLD).toMatch(/HBKANBANDRIFT819/)
    expect(SCAFFOLD).toMatch(/never count the lists as/)
  })
})
