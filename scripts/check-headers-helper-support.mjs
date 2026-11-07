#!/usr/bin/env node
// Does the INSTALLED Claude Code still honour the `headersHelper` contract this fleet relies on?
//
//   H1  a helper's JSON header reaches an http MCP server (user-scope config under CLAUDE_CONFIG_DIR);
//   H3  a failing helper (exit 1) and a helper printing non-JSON send NO Authorization at all, when there is no
//       static Authorization (the state after the migration removed it);
//   H4  with the static header still present, a failing helper falls back to it (the fail-open trap the
//       migration closes): checked so a Claude Code that changes THAT is noticed too.
//
// Everything runs against a loopback server on an ephemeral port with an isolated HOME and CLAUDE_CONFIG_DIR and
// invented header values; no real server, no real config, no vault. Exit 0 = contract holds, 1 = it does not,
// 3 = no `claude` binary here (nothing was checked). Meant for doctor / release checks after a Claude Code update,
// not for the unit suite (CI has no claude, so a green unit test would prove nothing).
import { spawn, spawnSync } from 'node:child_process'
import { chmodSync, mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const probe = spawnSync('claude', ['--version'], { encoding: 'utf-8' })
if (probe.error || probe.status !== 0) {
  process.stdout.write('check-headers-helper-support: no claude binary on PATH, nothing checked\n')
  process.exit(3)
}

const seen = []
const server = createServer((req, res) => {
  seen.push({ authorization: req.headers.authorization ?? null })
  req.resume()
  res.writeHead(401, { 'content-type': 'application/json' }).end('{"error":"probe"}')
})
await new Promise(r => server.listen(0, '127.0.0.1', r))
const port = server.address().port

const work = mkdtempSync(join(tmpdir(), 'headers-helper-check-'))
const script = (name, body) => { const p = join(work, name); writeFileSync(p, `#!/bin/bash\n${body}\n`); chmodSync(p, 0o755); return p }
const good = script('good.sh', `printf '{"Authorization":"Bearer fixture-helper-value"}\\n'`)
const failing = script('failing.sh', 'exit 1')
const junk = script('junk.sh', 'echo not-json')

// Async on purpose: the probe server lives in THIS process, a blocking spawn would starve it.
async function attempt(server_) {
  seen.length = 0
  const cfg = join(work, 'cfg'), home = join(work, 'home'), proj = join(work, 'proj')
  for (const d of [cfg, home, proj]) mkdirSync(d, { recursive: true })
  writeFileSync(join(cfg, '.claude.json'), JSON.stringify({ mcpServers: { probe: { type: 'http', url: `http://127.0.0.1:${port}/mcp`, ...server_ } } }))
  await new Promise(resolve => {
    const child = spawn('claude', ['mcp', 'list'], {
      cwd: proj, stdio: 'ignore', env: { PATH: process.env.PATH ?? '', HOME: home, CLAUDE_CONFIG_DIR: cfg },
    })
    const timer = setTimeout(() => child.kill('SIGKILL'), 90_000)
    child.on('close', () => { clearTimeout(timer); resolve() })
  })
  return seen.map(s => s.authorization)
}

const results = [
  ['H1 helper header reaches the server', await attempt({ headersHelper: good }), a => a.length > 0 && a.every(x => x === 'Bearer fixture-helper-value')],
  ['H3 failing helper sends no Authorization', await attempt({ headersHelper: failing }), a => a.length > 0 && a.every(x => x === null)],
  ['H3 helper printing non-JSON sends no Authorization', await attempt({ headersHelper: junk }), a => a.length > 0 && a.every(x => x === null)],
  ['H4 failing helper + static header falls back to the static one', await attempt({ headersHelper: failing, headers: { Authorization: 'Bearer fixture-static-value' } }), a => a.length > 0 && a.every(x => x === 'Bearer fixture-static-value')],
]

server.close()
rmSync(work, { recursive: true, force: true })

let ok = true
for (const [label, got, test] of results) {
  const pass = test(got)
  ok = ok && pass
  process.stdout.write(`${pass ? 'PASS' : 'FAIL'}  ${label}  (server saw ${got.length} request(s))\n`)
}
process.stdout.write(`claude ${probe.stdout.trim()}: headersHelper contract ${ok ? 'holds' : 'BROKEN'}\n`)
process.exit(ok ? 0 : 1)
