// Prints a dashboard URL that enrolls a browser: `<origin>/?enroll=<one-time code>`.
//
// Usage:
//   npm run dashboard-url
//   npm run dashboard-url -- --base https://dashboard.example.net
//
// The code is asked from the RUNNING dashboard (POST /api/admin/browser-enroll-codes, signed with
// the operator token), valid for 10 minutes and good for one browser: opening the URL trades it
// for that browser's own named, revocable admin token. The shared dashboard token is never read
// or printed. --base is the origin the browser will use (a tunnel or LAN host); it defaults to
// http://localhost:<WEB_PORT>.

import { WEB_PORT } from '../src/config.js'
import { enrollUrl } from '../src/web/browser-enroll-codes.js'
// @ts-expect-error plain .mjs, no declaration file
import { agentApi } from './lib/agent-api.mjs'

function die(msg: string): never {
  console.error(msg)
  process.exit(1)
}

function parseBase(argv: string[]): string {
  const i = argv.indexOf('--base')
  if (i < 0) return `http://localhost:${WEB_PORT}`
  const v = argv[i + 1]
  if (!v || !/^https?:\/\/[^\s/]+(:\d+)?\/?$/.test(v)) die('--base needs an origin such as https://dashboard.example.net')
  return v
}

const base = parseBase(process.argv.slice(2))

let res: { ok: boolean; status: number; body: unknown }
try {
  res = await agentApi('POST', '/api/admin/browser-enroll-codes', {}, { kind: 'operator' })
} catch {
  die('The dashboard did not answer. Start it first, then run this again.')
}
const code = (res.body as { code?: unknown } | null)?.code
if (!res.ok || typeof code !== 'string' || !code) {
  die(`The dashboard refused to issue an enrollment code (HTTP ${res.status}).`)
}
console.log(enrollUrl(base, code))
