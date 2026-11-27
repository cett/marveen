// The pg-parity job runs the restore-drill test (scripts/__tests__/pg-restore-drill.pg.test.ts), which needs the REAL
// pg_dump / pg_restore / psql of the SERVER's major and treats a missing client as an error, never a skip. The runner has no such
// client in a place the test looks, so the job installs it. This file pins that wiring: the step exists, it runs before the PG
// tests, it installs the major of the service image, and it refuses a client of any other major. No network, no PostgreSQL.
import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { load as yamlLoad } from 'js-yaml'

const ROOT = path.resolve(__dirname, '..', '..')

interface Step { name?: string; run?: string }
interface Job { steps?: Step[]; services?: Record<string, { image?: string }> }
const doc = yamlLoad(readFileSync(path.join(ROOT, '.github/workflows/ci.yml'), 'utf-8')) as { jobs: Record<string, Job> }
const job = doc.jobs['pg-parity']
const steps = job.steps ?? []
const indexOfRun = (needle: string): number => steps.findIndex((s) => (s.run ?? '').includes(needle))

/** The server major, from the service image tag (pgvector/pgvector:<ver>-pg<major>@sha256:...). */
function serverMajor(): number {
  const m = /-pg(\d+)(?:@|$)/.exec(job.services?.postgres?.image ?? '')
  expect(m, 'the service image tag names its PostgreSQL major (-pg<N>)').not.toBeNull()
  return Number(m![1])
}

describe('pg-parity installs the PostgreSQL client tools the restore drill needs', () => {
  const at = indexOfRun('postgresql-client-')
  const install = steps[at]?.run ?? ''

  it('has an install step, and it runs before the PG tests that include the drill', () => {
    expect(at, 'an install step with postgresql-client-<major>').toBeGreaterThan(-1)
    expect(indexOfRun('npm run test:pg')).toBeGreaterThan(at)
  })

  it('installs the major of the service image (a client of another major makes the drill refuse to run)', () => {
    expect(install).toContain(`postgresql-client-${serverMajor()}`)
    expect(install).not.toMatch(new RegExp(`postgresql-client-(?!${serverMajor()}\\b)\\d+`))
  })

  it('gets the client from the PostgreSQL project repository (the distribution one does not reliably carry that major)', () => {
    expect(install).toContain('/usr/share/postgresql-common/pgdg/apt.postgresql.org.sh')
  })

  it('refuses a client that is not that major, for all three tools, in the directory the drill looks in', () => {
    for (const tool of ['pg_dump', 'pg_restore', 'psql']) expect(install).toContain(tool)
    expect(install).toContain(`/usr/lib/postgresql/${serverMajor()}/bin/`)
    expect(install).toContain(`*" ${serverMajor()}."*) ;;`)
    expect(install).toMatch(/\*\) echo .*exit 1/)
  })

  it('retries the install (the job is part of the required context) but ends red after the last failed attempt', () => {
    expect(install).toMatch(/for attempt in 1 2 3/)
    expect(install).toMatch(/\[ "\$attempt" -eq 3 \]; then\s+exit 1/)
  })
})
