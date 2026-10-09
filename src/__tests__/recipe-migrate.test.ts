// Tests for the recipe dry-run tool: scripts/lib/recipe-migrate.ts (pure conversion of old
// "curl + dashboard token" recipes into agent-api.sh calls) and scripts/recipe-wrapper-dry-run.ts
// (the read-only scanner). Neutral fixtures only: made-up agent ids and no real token values.
//
// The scripts live outside the tsc rootDir (src), so they are loaded with a runtime import and typed
// by the small interfaces below instead of a static import.
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createHash } from 'node:crypto'
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { ENDPOINT_PERMISSION_TABLE, hasPermission, resolveRequiredPermission } from '../web/rbac.js'

interface Edit { line: number; endLine: number; start: number; end: number; old: string; replacement: string; method: string; path: string; agent?: string; adminOnly: boolean; adminReason: string }
interface Plan {
  edits: Edit[]
  skipped: Array<{ line: number; reason: string; snippet: string }>
  manual: Array<{ line: number; kind: string; reason: string; snippet: string }>
  assignmentsToDrop: number[]
  inlineAssignments: Array<{ line: number; text: string }>
}
type Converted = { ok: true; replacement: string; method: string; path: string; agent?: string; adminOnly: boolean; adminReason: string } | { ok: false; reason: string; ignored: boolean }
interface Lib {
  findCurlCommands(text: string): Array<{ start: number; end: number; text: string }>
  convertCurl(cmd: string, opts: { wrapper: string; defaultPort?: number }): Converted
  planRewrite(text: string, opts: { wrapper: string; markdown?: boolean }): Plan
  applyEdits(text: string, edits: Edit[], dropLines?: number[]): string
  adminRequirement(method: string, path: string): { adminOnly: boolean; reason: string }
}
interface FileReport {
  source: string; owner: string; schedule?: string; path: string
  edits: Array<Edit & { block: string | null; where?: string }>
  skipped: Array<{ line: number; reason: string; block: string | null }>
  manual: Array<{ line: number; kind: string; block: string | null }>
  assignmentsToDrop: Array<{ line: number }>
}
interface Report {
  notes: string[]
  summary: { filesScanned: number; filesWithHits: number; edits: number; adminEdits: number; skipped: number; manual: number; mentions: number }
  files: FileReport[]
}
interface Cli {
  runDryRun(o: { install: string; home: string; schedulesApi?: boolean }): Promise<Report>
  renderMarkdown(r: Report): string
  generatedBlockMap(text: string): Array<string | null>
}

const lib = (await import(new URL('../../scripts/lib/recipe-migrate.ts', import.meta.url).href)) as Lib
const cli = (await import(new URL('../../scripts/recipe-wrapper-dry-run.ts', import.meta.url).href)) as Cli

const W = 'bash /i/agent-api.sh'
const AUTH = '-H "Authorization: Bearer $(cat store/.dashboard-token)"'
const conv = (cmd: string): Converted => lib.convertCurl(cmd, { wrapper: W })
const okReplacement = (cmd: string): string => {
  const r = conv(cmd)
  if (!r.ok) throw new Error(`not converted: ${r.reason}`)
  return r.replacement
}
const convert = (text: string, markdown = false): { out: string; plan: Plan } => {
  const plan = lib.planRewrite(text, { wrapper: W, markdown })
  return { out: lib.applyEdits(text, plan.edits, plan.assignmentsToDrop), plan }
}

describe('findCurlCommands', () => {
  it('ends a command at a pipe, a redirect, a semicolon and a closing parenthesis', () => {
    const t = 'curl -s a | jq .\nx=$(curl -s b)\ncurl -s c 2>/dev/null\ncurl -s d; echo'
    expect(lib.findCurlCommands(t).map(c => c.text)).toEqual(['curl -s a ', 'curl -s b', 'curl -s c ', 'curl -s d'])
  })
  it('does not end at the > of a <name> placeholder', () => {
    const [c] = lib.findCurlCommands('curl -s http://localhost:3420/api/kanban/<ID>/children | cat')
    expect(c.text).toBe('curl -s http://localhost:3420/api/kanban/<ID>/children ')
  })
  it('keeps a quoted $(...) and a quoted pipe inside the command', () => {
    const [c] = lib.findCurlCommands(`curl -s -d "{\\"a\\":\\"$(date +%s | tr -d x)\\"}" http://localhost:3420/api/x`)
    expect(c.text.endsWith('/api/x')).toBe(true)
  })
  it('does not match curl inside a longer word or path', () => {
    expect(lib.findCurlCommands('use /usr/bin/curl or libcurl or curl-based')).toEqual([])
  })
  it('falls back to the line end when a quote is never closed', () => {
    const cmds = lib.findCurlCommands('curl -s "http://localhost:3420/api/x\ncurl -s http://localhost:3420/api/y')
    expect(cmds).toHaveLength(2)
  })
})

describe('convertCurl: shapes', () => {
  it('converts a simple GET', () => {
    expect(okReplacement(`curl -s ${AUTH} http://localhost:3420/api/blackboard`)).toBe(`${W} GET /api/blackboard`)
  })
  it('converts a POST with a JSON body and drops Content-Type', () => {
    const cmd = `curl -s -X POST http://localhost:3420/api/memories -H "Content-Type: application/json" ${AUTH} -d '{"agent_id":"a","content":"x"}'`
    expect(okReplacement(cmd)).toBe(`${W} POST /api/memories '{"agent_id":"a","content":"x"}'`)
  })
  it('converts a PUT and infers POST from a body without -X', () => {
    expect(okReplacement(`curl -s -X PUT ${AUTH} -d '{"value":1}' http://localhost:3420/api/agent-state/a/k`)).toBe(`${W} PUT /api/agent-state/a/k '{"value":1}'`)
    expect(okReplacement(`curl -s ${AUTH} -d '{}' http://localhost:3420/api/memories/resort`)).toBe(`${W} POST /api/memories/resort '{}'`)
  })
  it('joins a multi-line command with -H lines after the URL', () => {
    const text = 'before\ncurl -s -X POST http://localhost:3420/api/blackboard \\\n  -H "Content-Type: application/json" \\\n  -H "Authorization: Bearer $(cat store/.dashboard-token)" \\\n  -d \'{"a":1}\'\nafter\n'
    const { out, plan } = convert(text)
    expect(plan.edits).toHaveLength(1)
    expect(plan.edits[0].line).toBe(2)
    expect(plan.edits[0].endLine).toBe(5)
    expect(out).toBe(`before\n${W} POST /api/blackboard '{"a":1}'\nafter\n`)
  })
  it('keeps a <name> placeholder in the URL and the pipe after the call', () => {
    const { out } = convert(`curl -s ${AUTH} http://localhost:3420/api/kanban/<ID>/children | python3 -c 'print(1)'\n`)
    expect(out).toBe(`${W} GET '/api/kanban/<ID>/children' | python3 -c 'print(1)'\n`)
  })
  it('keeps a space and a line continuation before a following pipe', () => {
    expect(convert(`curl -s ${AUTH} http://localhost:3420/api/agents | jq .\n`).out).toBe(`${W} GET /api/agents | jq .\n`)
    expect(convert(`curl -s ${AUTH} http://localhost:3420/api/agents \\\n  | jq .\n`).out).toBe(`${W} GET /api/agents \\\n  | jq .\n`)
  })
  it('keeps a $VAR path in double quotes', () => {
    expect(okReplacement(`curl -s ${AUTH} "http://localhost:3420/api/memories?agent=$AGENT_ID&limit=5"`)).toBe(`${W} GET "/api/memories?agent=$AGENT_ID&limit=5"`)
  })
  it('single-quotes a plain path with a query string', () => {
    expect(okReplacement(`curl -s ${AUTH} "http://localhost:3420/api/memories?agent=a&q=term"`)).toBe(`${W} GET '/api/memories?agent=a&q=term'`)
  })
  it('keeps a $(date +%s) body substitution live in double quotes', () => {
    const r = okReplacement(`curl -s -X PUT ${AUTH} -d "{\\"value\\": $(date +%s)}" http://localhost:3420/api/agent-state/a/k`)
    expect(r).toBe(`${W} PUT /api/agent-state/a/k "{\\"value\\": $(date +%s)}"`)
  })
  it('turns a double-quoted body without substitutions into a single-quoted one', () => {
    expect(okReplacement(`curl -s -X POST ${AUTH} -d "{\\"from\\":\\"a\\"}" http://localhost:3420/api/messages`)).toBe(`${W} POST /api/messages '{"from":"a"}'`)
  })
  it('escapes a single quote inside a single-quoted body', () => {
    expect(okReplacement(`curl -s -X POST ${AUTH} -d "{\\"c\\":\\"it's\\"}" http://localhost:3420/api/messages`)).toBe(`${W} POST /api/messages '{"c":"it'\\''s"}'`)
  })
  it('maps X-Agent-Id to --agent', () => {
    expect(okReplacement(`curl -s -X POST ${AUTH} -H "X-Agent-Id: alpha" -d '{}' http://localhost:3420/api/memories`)).toBe(`${W} --agent alpha POST /api/memories '{}'`)
    expect(okReplacement(`curl -s ${AUTH} -H "X-Agent-Id: <AGENT>" http://localhost:3420/api/blackboard`)).toBe(`${W} --agent '<AGENT>' GET /api/blackboard`)
  })
  it('passes -d @file through and turns -d @- into -', () => {
    expect(okReplacement(`curl -s -X POST ${AUTH} -d @/tmp/body.json http://localhost:3420/api/memories`)).toBe(`${W} POST /api/memories @/tmp/body.json`)
    expect(okReplacement(`curl -s -X PUT ${AUTH} -d @- http://localhost:3420/api/skills/sql/agent%2Fa%2Fx`)).toBe(`${W} PUT /api/skills/sql/agent%2Fa%2Fx -`)
  })
  it('maps --max-time and the -w status format', () => {
    expect(okReplacement(`curl -sf --max-time 30 ${AUTH} http://localhost:3420/api/agents`)).toBe(`${W} --max-time 30 GET /api/agents`)
    expect(okReplacement(`curl -s -w '\\n%{http_code}' ${AUTH} http://localhost:3420/api/agents`)).toBe(`${W} --with-status GET /api/agents`)
  })
  it('accepts a token held in a variable that was read from a token file', () => {
    const { out, plan } = convert('TOKEN=$(cat store/.dashboard-token)\ncurl -s -H "Authorization: Bearer $TOKEN" http://localhost:3420/api/agents\n')
    expect(out).toBe(`${W} GET /api/agents\n`)
    expect(plan.assignmentsToDrop).toEqual([1])
  })
  it('uses the operator token for an operator token file', () => {
    expect(okReplacement('curl -s -H "Authorization: Bearer $(cat store/.operator-token)" http://localhost:3420/api/agents')).toBe(`${W} --token operator GET /api/agents`)
  })
  it('resolves $BASE assigned to the dashboard URL and drops both assignments', () => {
    const t = 'TOKEN=$(cat store/.dashboard-token)\nBASE=http://127.0.0.1:3420\ncurl -s "$BASE/api/artifacts/x" -H "Authorization: Bearer $TOKEN"\n'
    const { out, plan } = convert(t)
    expect(plan.assignmentsToDrop).toEqual([1, 2])
    expect(out).toBe(`${W} GET /api/artifacts/x\n`)
  })
  it('stops at prose after the command and leaves sentence punctuation alone', () => {
    const t = 'Delete: curl -s -X DELETE http://localhost:3420/api/schedules/t -H "Authorization: Bearer $(cat store/.dashboard-token)". Then stop.\n'
    expect(convert(t).out).toBe(`Delete: ${W} DELETE /api/schedules/t. Then stop.\n`)
    const t2 = `Read: curl -s ${AUTH} http://localhost:3420/api/agent-state/a/k   (404 -> {}; the value field)\n`
    expect(convert(t2).out).toBe(`Read: ${W} GET /api/agent-state/a/k   (404 -> {}; the value field)\n`)
  })
})

describe('convertCurl: admin-only endpoints get --token admin', () => {
  const call = (method: string, path: string): string => okReplacement(`curl -s -X ${method} ${AUTH} -d '{}' http://localhost:3420${path}`)

  it.each([
    ['POST', '/api/agents/x/restart'],
    ['PUT', '/api/skills/sql/global%2Fx'],
    ['POST', '/api/voice/tts'],
    ['GET', '/api/vault'],
    ['PATCH', '/api/approvals/7'],
  ])('%s %s is admin-only', (method, path) => {
    expect(call(method, path)).toBe(`${W} --token admin ${method} ${path} '{}'`)
  })

  it.each([
    ['POST', '/api/memories'],
    ['POST', '/api/daily-log'],
    ['POST', '/api/messages'],
    ['POST', '/api/kanban'],
    ['POST', '/api/blackboard'],
    ['POST', '/api/approvals'],
    ['PUT', '/api/skills/sql/agent%2Fzack%2Fx'],
  ])('%s %s is open to a fleet agent token', (method, path) => {
    expect(call(method, path)).not.toContain('--token')
  })

  it('reports the admin flag and its reason on the result', () => {
    const r = conv(`curl -s -X POST ${AUTH} http://localhost:3420/api/agents/x/restart`)
    expect(r.ok && r.adminOnly).toBe(true)
    expect(r.ok && r.adminReason).toMatch(/admin:all/)
  })

  it('ignores the query string and normalises /api/v1', () => {
    expect(lib.adminRequirement('GET', '/api/memories?next=/api/admin/x').adminOnly).toBe(false)
    expect(lib.adminRequirement('GET', '/api/v1/memories?q=1').adminOnly).toBe(false)
    expect(lib.adminRequirement('GET', '/api/v1/admin/tenants').adminOnly).toBe(true)
    expect(lib.adminRequirement('POST', '/api/v1/agents/x/restart').adminOnly).toBe(true)
    expect(call('POST', '/api/v1/blackboard')).not.toContain('--token')
  })

  it('treats an unmapped endpoint and a variable resource as admin-only', () => {
    expect(lib.adminRequirement('GET', '/api/no-such-resource').adminOnly).toBe(true)
    expect(lib.adminRequirement('GET', '/api/$RESOURCE').adminOnly).toBe(true)
  })

  it('never marks an operator-token call as admin', () => {
    const r = conv('curl -s -H "Authorization: Bearer $(cat store/.operator-token)" http://localhost:3420/api/vault')
    expect(r.ok && r.replacement).toBe(`${W} --token operator GET /api/vault`)
    expect(r.ok && r.adminOnly).toBe(false)
  })
})

describe('convertCurl: calls that must not be rewritten', () => {
  it('reports an unparsable dashboard call as skipped, not rewritten', () => {
    const text = `curl -s ${AUTH} "http://localhost:3420/api/memories?q=\n`
    const { out, plan } = convert(text)
    expect(out).toBe(text)
    expect(plan.edits).toEqual([])
    expect(plan.skipped).toHaveLength(1)
    expect(plan.skipped[0].reason).toMatch(/unparsable/)
  })
  it.each([
    ['an unsupported option', `curl -s -o /dev/null ${AUTH} http://localhost:3420/api/agents`, /unsupported option -o/],
    ['an unsupported header', `curl -s -H "X-Custom: 1" ${AUTH} http://localhost:3420/api/agents`, /unsupported header/],
    ['a bare -w http_code', `curl -s -w '%{http_code}' ${AUTH} http://localhost:3420/api/agents`, /-w format/],
    ['a non-JSON content type', `curl -s -X POST -H "Content-Type: text/plain" ${AUTH} -d x http://localhost:3420/api/memories`, /Content-Type/],
    ['a different instance port', `curl -s ${AUTH} http://localhost:3421/api/agents`, /another instance/],
    ['no token header', 'curl -s http://localhost:3420/api/memories', /without a token header/],
    ['an unknown host variable', `curl -s ${AUTH} "$HOST/api/agents"`, /variable/],
    ['the dashboard token sent to another host', `curl -s ${AUTH} https://example.org/api/agents`, /non-dashboard host/],
  ])('skips %s', (_name, cmd, reason) => {
    const r = conv(cmd)
    expect(r.ok).toBe(false)
    expect(!r.ok && r.ignored).toBe(false)
    expect(!r.ok && r.reason).toMatch(reason)
  })
  it('ignores a call to another host or a non-API path without reporting it', () => {
    for (const cmd of [
      'curl -s -H "Authorization: Bearer $GH" https://api.github.com/repos/o/r/issues',
      'curl -s -H "Authorization: Bearer $AT" "https://www.googleapis.com/drive/v3/files"',
      'curl -s http://localhost:3420/health',
      'curl -s -u admin:pw http://localhost:9009/api/system/status',
    ]) {
      const r = conv(cmd)
      expect(r.ok).toBe(false)
      expect(!r.ok && r.ignored).toBe(true)
    }
  })
  it('keeps a token variable that a non-converted call still uses', () => {
    const t = 'TOKEN=$(cat store/.dashboard-token)\ncurl -s -H "Authorization: Bearer $TOKEN" http://localhost:3420/api/agents\ncurl -s -o /dev/null -H "Authorization: Bearer $TOKEN" http://localhost:3420/api/agents\n'
    const { plan } = convert(t)
    expect(plan.edits).toHaveLength(1)
    expect(plan.skipped).toHaveLength(1)
    expect(plan.assignmentsToDrop).toEqual([])
    expect(plan.manual.map(m => m.kind)).toContain('token-file-read')
  })
  it('reports an inline assignment on a command line instead of dropping the line', () => {
    const t = 'TOKEN=$(cat store/.dashboard-token); curl -s -H "Authorization: Bearer $TOKEN" http://localhost:3420/api/agents\n'
    const { plan } = convert(t)
    expect(plan.assignmentsToDrop).toEqual([])
    expect(plan.inlineAssignments).toEqual([{ line: 1, text: 'TOKEN=$(cat store/.dashboard-token)' }])
  })
})

describe('credential uses that cannot be converted are listed as manual', () => {
  it('reports a python urllib Bearer snippet', () => {
    const py = [
      'import json, urllib.request as u',
      'token = open("store/.dashboard-token").read().strip()',
      'req = u.Request("http://localhost:3420/api/messages", data=b"{}", headers={"Authorization": f"Bearer {token}"}, method="POST")',
    ].join('\n')
    const { plan, out } = convert(py)
    expect(out).toBe(py)
    expect(plan.manual.map(m => [m.line, m.kind])).toEqual([[2, 'token-file-read'], [3, 'bearer-in-code']])
  })
  it('reports a shell cat of a token file outside any curl', () => {
    expect(convert('T=$(cat store/.dashboard-token); node run.js "$T"\n').plan.manual.map(m => m.kind)).toEqual(['token-file-read'])
  })
  it('reports a curl built as an argv list in code', () => {
    const t = 'subprocess.run(["curl", "-s", "-X", "POST", "http://localhost:3420/api/messages",\n  "-H", "x"])\n'
    expect(convert(t).plan.manual.map(m => m.kind)).toEqual(['subprocess-curl'])
  })
  it('lists prose that merely names a token file as a mention, code as a read, in markdown', () => {
    const md = 'Use the token from store/.dashboard-token please.\n\n```python\ntoken = open("store/.dashboard-token").read()\n```\n'
    const { plan } = convert(md, true)
    expect(plan.manual.map(m => [m.line, m.kind])).toEqual([[1, 'mention'], [4, 'token-file-read']])
  })
})

describe('the admin oracle follows the RBAC table', () => {
  const sample = (pattern: string, prefix: boolean): string => (prefix && !pattern.endsWith('/') ? pattern + '/x' : prefix ? pattern + 'x' : pattern)
  const routeLevel = (path: string): boolean => /^\/api\/(v1\/)?(skills\/sql|approvals\/)/.test(path)

  it('agrees with resolveRequiredPermission + hasPermission for every table row', () => {
    let admin = 0
    let open = 0
    for (const e of ENDPOINT_PERMISSION_TABLE) {
      const method = e.method === '*' ? 'GET' : e.method
      const path = sample(e.pathPattern, e.prefix)
      if (routeLevel(path)) continue
      const perm = resolveRequiredPermission(method, path.replace(/^\/api\/v1\//, '/api/'))
      const expected = perm === null || !hasPermission('fleet_agent', perm)
      expect(lib.adminRequirement(method, path).adminOnly, `${method} ${path}`).toBe(expected)
      if (expected) admin++
      else open++
    }
    expect(admin).toBeGreaterThan(0)
    expect(open).toBeGreaterThan(0)
  })

  it('knows the endpoints a fleet agent token is refused on today', () => {
    const adminOnly: Array<[string, string]> = [
      ['POST', '/api/agents/x/restart'], ['POST', '/api/agents/x/start'], ['POST', '/api/agents/x/stop'],
      ['GET', '/api/vault'], ['POST', '/api/voice/tts'], ['GET', '/api/messages'], ['PATCH', '/api/blackboard/abc'],
      ['POST', '/api/schedules/x/activate'], ['GET', '/api/schedules/tick-status'], ['GET', '/api/agents/x/export'],
    ]
    for (const [m, p] of adminOnly) expect(lib.adminRequirement(m, p).adminOnly, `${m} ${p}`).toBe(true)
    const open: Array<[string, string]> = [
      ['GET', '/api/memories'], ['POST', '/api/daily-log'], ['POST', '/api/messages'], ['POST', '/api/kanban'],
      ['GET', '/api/blackboard'], ['GET', '/api/agents'], ['GET', '/api/autonomy'], ['POST', '/api/approvals'],
      ['PUT', '/api/agent-state/a/k'], ['POST', '/api/artifacts'], ['GET', '/api/schedules'],
    ]
    for (const [m, p] of open) expect(lib.adminRequirement(m, p).adminOnly, `${m} ${p}`).toBe(false)
  })

  it('only ever tightens the table for the two route-level rules', () => {
    for (const [m, p] of [['PUT', '/api/skills/sql/global%2Fx'], ['POST', '/api/skills/sql'], ['PATCH', '/api/approvals/1']] as const) {
      const perm = resolveRequiredPermission(m, p)
      expect(perm !== null && hasPermission('fleet_agent', perm), `${m} ${p} is open in the table`).toBe(true)
      expect(lib.adminRequirement(m, p).adminOnly).toBe(true)
    }
  })
})

describe('generatedBlockMap', () => {
  it('names the managed block a line sits in and nothing outside it', () => {
    const t = [
      'hand written',
      '<!-- BEGIN GENERATED: autonomy-wiring (auto-generated, do not edit by hand) -->',
      'inside',
      '<!-- END GENERATED: autonomy-wiring -->',
      'outside',
      '<!-- MARVEEN-FEDERATION:BEGIN -- managed block -->',
      'federation text',
      '<!-- MARVEEN-FEDERATION:END -->',
      'tail',
    ].join('\n')
    const m = cli.generatedBlockMap(t)
    expect([m[1], m[3], m[5], m[7], m[9]]).toEqual([null, 'autonomy-wiring', null, 'MARVEEN-FEDERATION', null])
  })
})

describe('the dry-run CLI logic', () => {
  let root: string
  let install: string
  let home: string
  let outside: string

  const put = (base: string, rel: string, text: string | Buffer): string => {
    const p = join(base, rel)
    mkdirSync(dirname(p), { recursive: true })
    writeFileSync(p, text)
    return p
  }
  const snapshot = (dir: string): Record<string, string> => {
    const out: Record<string, string> = {}
    const walk = (d: string): void => {
      for (const name of readdirSync(d)) {
        const p = join(d, name)
        const st = statSync(p)
        if (st.isDirectory()) { out[p + '/'] = String(st.mtimeMs); walk(p); continue }
        out[p] = createHash('sha256').update(readFileSync(p)).digest('hex') + ':' + st.mtimeMs
      }
    }
    walk(dir)
    return out
  }

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'recipe-dry-'))
    install = join(root, 'install')
    home = join(root, 'home')
    outside = join(root, 'outside')
    mkdirSync(install, { recursive: true })
    mkdirSync(outside, { recursive: true })

    put(install, '.env', 'MAIN_AGENT_ID=boss\nWEB_PORT=3420\n')
    put(install, 'CLAUDE.md', [
      'intro',
      `curl -s ${AUTH} http://localhost:3420/api/blackboard`,
      '<!-- BEGIN GENERATED: autonomy-wiring (auto-generated, do not edit by hand) -->',
      `curl -s -X POST ${AUTH} -d '{}' http://localhost:3420/api/messages`,
      '<!-- END GENERATED: autonomy-wiring -->',
    ].join('\n') + '\n')
    put(install, 'agents/zed/CLAUDE.md', `restart: curl -s -X POST ${AUTH} http://localhost:3420/api/agents/x/restart\n`)
    put(install, 'agents/zed/.claude/skills/s1/SKILL.md', `curl -s ${AUTH} http://localhost:3420/api/memories\n`)
    put(install, 'agents/zed/.claude/skills/s1/data.bin', Buffer.from([0, 1, 2, 0, 99]))
    put(install, 'agents/zed/.claude/skills/s1/old.sh.bak', `curl -s ${AUTH} http://localhost:3420/api/memories\n`)
    put(install, 'agents/zed/.claude/skills/node_modules/pkg/index.js', `curl -s ${AUTH} http://localhost:3420/api/memories\n`)
    put(home, '.claude/skills/g1/SKILL.md', `curl -s ${AUTH} http://localhost:3420/api/agents\n\`\`\`python\ntoken = open("store/.dashboard-token").read()\n\`\`\`\n`)
    put(home, '.claude/scheduled-tasks/t1/SKILL.md', `curl -s ${AUTH} http://localhost:3420/api/kanban\n`)
    put(home, '.claude/scheduled-tasks/t1/task-config.json', JSON.stringify({
      agent: 'zed',
      type: 'command',
      command: 'TOKEN=$(cat store/.dashboard-token); curl -sf --max-time 5 -X POST http://localhost:3420/api/memories/resort -H "Authorization: Bearer $TOKEN" -d \'{}\'',
    }, null, 2))
    put(outside, 'secret.md', `curl -s ${AUTH} http://localhost:3420/api/agents\n`)
    symlinkSync(outside, join(home, '.claude/skills/escape'))
  })
  afterEach(() => rmSync(root, { recursive: true, force: true }))

  it('writes nothing: every scanned file keeps its content and mtime, and a report comes out', async () => {
    const before = { install: snapshot(install), home: snapshot(home), outside: snapshot(outside) }
    const report = await cli.runDryRun({ install, home, schedulesApi: false })
    const md = cli.renderMarkdown(report)
    expect({ install: snapshot(install), home: snapshot(home), outside: snapshot(outside) }).toEqual(before)
    expect(md).toContain('# Recipe to wrapper dry run')
    expect(md).toContain('## Summary')
    expect(report.summary.edits).toBeGreaterThan(0)
  })

  it('attributes owners, marks managed blocks, flags admin-only calls and skips what it must', async () => {
    const report = await cli.runDryRun({ install, home, schedulesApi: false })
    const byPath = (suffix: string): FileReport => {
      const f = report.files.find(x => x.path.endsWith(suffix))
      if (!f) throw new Error(`no hit in ${suffix}`)
      return f
    }

    const main = byPath('install/CLAUDE.md')
    expect(main.owner).toBe('boss')
    expect(main.source).toBe('claude-md')
    expect(main.edits.map(e => [e.line, e.block])).toEqual([[2, null], [4, 'autonomy-wiring']])

    const zed = byPath('agents/zed/CLAUDE.md')
    expect(zed.owner).toBe('zed')
    expect(zed.edits[0].adminOnly).toBe(true)
    expect(zed.edits[0].replacement).toContain('--token admin POST /api/agents/x/restart')

    expect(byPath('s1/SKILL.md').source).toBe('agent-skill')
    expect(report.files.some(f => f.path.endsWith('data.bin') || f.path.endsWith('.bak') || f.path.includes('node_modules'))).toBe(false)

    const global = byPath('g1/SKILL.md')
    expect(global.owner).toBe('global')
    expect(global.manual.map(m => m.kind)).toContain('token-file-read')

    const task = byPath('t1/SKILL.md')
    expect(task.owner).toBe('zed')
    expect(task.schedule).toBe('t1')
    const cfg = byPath('t1/task-config.json')
    expect(cfg.edits[0].where).toBe('command')
    expect(cfg.edits[0].replacement).toContain('--max-time 5 POST /api/memories/resort')

    // a symlink that leaves the scanned root is not followed
    expect(report.files.some(f => f.path.includes('secret.md'))).toBe(false)
    expect(report.notes.some(n => n.includes('symlink'))).toBe(true)

    expect(report.summary.adminEdits).toBe(1)
    const md = cli.renderMarkdown(report)
    expect(md).toContain('[ADMIN]')
    expect(md).toContain('[generated block: autonomy-wiring]')
    expect(md).toContain('[hand-written]')
  })

  it('takes the dashboard port from the install .env', async () => {
    put(install, '.env', 'MAIN_AGENT_ID=boss\nWEB_PORT=4100\n')
    put(install, 'agents/zed/CLAUDE.md', `curl -s ${AUTH} http://localhost:4100/api/blackboard\ncurl -s ${AUTH} http://localhost:3420/api/blackboard\n`)
    const report = await cli.runDryRun({ install, home, schedulesApi: false })
    const zed = report.files.find(f => f.path.endsWith('agents/zed/CLAUDE.md'))
    expect(zed?.edits.map(e => e.line)).toEqual([1])
    expect(zed?.skipped.map(s => s.line)).toEqual([2])
  })

  it('reads the schedules registry through an injected fetch and labels it with the schedule name', async () => {
    const report = await cli.runDryRun({
      install, home, schedulesApi: true,
      fetchSchedules: async () => [{ name: 'nightly', agent: 'zed', prompt: `Run:\n\`\`\`bash\ncurl -s ${AUTH} http://localhost:3420/api/blackboard\n\`\`\`` }],
    } as never)
    const f = report.files.find(x => x.source === 'schedule-api')
    expect(f?.owner).toBe('zed')
    expect(f?.schedule).toBe('nightly')
    expect(f?.edits[0].where).toBe('prompt')
  })

  it('notes an unreachable registry in one line and carries on', async () => {
    const report = await cli.runDryRun({ install, home, schedulesApi: true, fetchSchedules: async () => ({ note: 'dashboard not reachable' }) } as never)
    expect(report.notes.some(n => n.includes('schedules registry not read'))).toBe(true)
    expect(report.summary.edits).toBeGreaterThan(0)
  })
})
