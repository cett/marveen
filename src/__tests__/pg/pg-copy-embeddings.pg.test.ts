// The embeddings stage of the copy (P-G1 c4): the side tables of memories and workspace docs are filled from their blobs, the
// artifacts are re-embedded, a row the embedder does not answer for stays pending, and a second run embeds nothing. The CLI
// subcommand runs the same stage as the app role, in a spawned process, with the embedder unreachable.
// PostgreSQL only: needs MARVEEN_PG_TEST_URL (the admin URL of a throwaway server).
import { spawnSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createPgDbx } from '../../db/pg/index.js'
import { useDbxBackend as setBackend } from '../../db/facade.js'
import { runEmbeddingsStage } from '../../db/pg-copy/embeddings.js'
import { EMBEDDING_DIM, floatsToBlob } from '../../db/vector.js'
import { createPgTestDb, type PgTestDb } from '../helpers/pg-test-db.js'

const repo = fileURLToPath(new URL('../../../', import.meta.url))
const tsx = join(repo, 'node_modules', '.bin', 'tsx')
const runner = join(repo, 'scripts', 'with-config.ts')

interface CliReport {
  memory: { embedded: number; skipped: number; batches: number }
  workspace_doc: { embedded: number; skipped: number; batches: number }
  artifacts: { embedded: number; pending: number; skipped: number; batches: number }
}

const GOOD_VEC = (): number[] => Array.from({ length: EMBEDDING_DIM }, (_, i) => Math.sin(i + 1) * 0.5)

/** Two memories and one text doc with a valid blob, one memory with a blob that is not an embedding, one binary doc (not
 * selected), and two artifacts without a side row: one the embedder answers for, one it does not (its text holds FAIL). */
async function seed(t: PgTestDb): Promise<void> {
  const now = Math.floor(Date.now() / 1000)
  const good = floatsToBlob(GOOD_VEC())
  for (const content of ['memory-a', 'memory-b']) {
    await t.pool.query(
      `INSERT INTO memories (chat_id, content, sector, created_at, accessed_at, agent_id, category, tenant_id, embedding_blob)
       VALUES ('chat-st', $1, 'semantic', $2, $2, 'agent-st', 'warm', 'default', $3)`,
      [content, now, good],
    )
  }
  await t.pool.query(
    `INSERT INTO memories (chat_id, content, sector, created_at, accessed_at, agent_id, category, tenant_id, embedding_blob)
     VALUES ('chat-st', 'memory-bad', 'semantic', $1, $1, 'agent-st', 'warm', 'default', $2)`,
    [now, Buffer.alloc(8)],
  )
  await t.pool.query(
    "INSERT INTO workspace_docs (id, agent_id, tenant_id, title, content, content_type, embedding_blob) VALUES ('doc-text', 'agent-st', 'default', 't', 'body', 'text', $1)",
    [good],
  )
  await t.pool.query(
    "INSERT INTO workspace_docs (id, agent_id, tenant_id, title, content, content_type, embedding_blob) VALUES ('doc-binary', 'agent-st', 'default', 't', 'body', 'binary', $1)",
    [good],
  )
  await t.pool.query(
    "INSERT INTO artifacts (id, agent_id, title, kind, mime, content, meta, tenant_id) VALUES ('art-ok', 'agent-st', 'Quarterly plan', 'text', 'text/plain', $1, '{\"kind\":\"plan\"}', 'default')",
    [Buffer.from('body')],
  )
  await t.pool.query(
    "INSERT INTO artifacts (id, agent_id, title, kind, mime, content, meta, tenant_id) VALUES ('art-fail', 'agent-st', 'FAIL minutes', 'text', 'text/plain', $1, '{}', 'default')",
    [Buffer.from('body')],
  )
}

async function sideCounts(t: PgTestDb): Promise<{ memory: number; doc: number; artifact: number }> {
  const count = async (sql: string): Promise<number> => Number((await t.pool.query<{ n: string }>(sql)).rows[0]!.n)
  return {
    memory: await count('SELECT count(*)::text AS n FROM memory_embeddings'),
    doc: await count('SELECT count(*)::text AS n FROM workspace_doc_embeddings'),
    artifact: await count('SELECT count(*)::text AS n FROM artifact_embeddings'),
  }
}

/** The embedder spy: every call is counted. It answers for every prompt except one that holds FAIL (an empty answer, which the
 * re-embed counts as pending), until `answerFail` is set. The memory and doc backfill never calls it: they read the blobs. */
let embedCalls = 0
let answerFail = false
function stubEmbedder(): void {
  embedCalls = 0
  answerFail = false
  vi.stubGlobal('fetch', vi.fn((_url: string, init: { body: string }) => {
    embedCalls++
    const prompt = (JSON.parse(init.body) as { prompt: string }).prompt
    const body = prompt.includes('FAIL') && !answerFail ? {} : { embedding: GOOD_VEC() }
    return Promise.resolve({ json: () => Promise.resolve(body) })
  }))
}

let open: PgTestDb | undefined
let envDir: string | undefined

afterEach(async () => {
  vi.unstubAllGlobals()
  setBackend(null)
  if (open) await open.close()
  open = undefined
  if (envDir) rmSync(envDir, { recursive: true, force: true })
  envDir = undefined
})

describe('the embeddings stage: the side tables fill from the blobs, the artifacts are re-embedded, a second run embeds nothing', () => {
  it('first run embeds the valid rows, counts the bad blob as skipped and the unanswered artifact as pending; the second run embeds nothing', async () => {
    open = await createPgTestDb()
    await seed(open)
    setBackend(createPgDbx(open.pool), 'pg')
    stubEmbedder()
    // no insert attempt counter: PostgreSQL refuses ON CONFLICT on a table with a rule, and the stage refuses a trigger. The NOT
    // EXISTS guard is checked by the counts and by the embedder calls of each run below.

    const first = await runEmbeddingsStage()
    expect(first.memory).toEqual({ embedded: 2, skipped: 1, batches: 1 })
    expect(first.workspace_doc).toEqual({ embedded: 1, skipped: 0, batches: 1 })
    expect(first.artifacts).toEqual({ embedded: 1, pending: 1, skipped: 0, batches: 1 })
    // the binary doc has no side row on either write path: it is not selected, so it is not in the count
    expect(await sideCounts(open)).toEqual({ memory: 2, doc: 1, artifact: 1 })
    // the embedder is asked once per artifact that has no side row: the ok one and the FAIL one
    expect(embedCalls).toBe(2)

    const second = await runEmbeddingsStage()
    // the bad blob and the unanswered artifact have no side row, so they are read and counted again; nothing is embedded
    expect(second.memory).toEqual({ embedded: 0, skipped: 1, batches: 1 })
    expect(second.workspace_doc).toEqual({ embedded: 0, skipped: 0, batches: 0 })
    expect(second.artifacts).toEqual({ embedded: 0, pending: 1, skipped: 0, batches: 1 })
    expect(await sideCounts(open)).toEqual({ memory: 2, doc: 1, artifact: 1 })
    // the embedder is asked only for the pending artifact
    expect(embedCalls).toBe(3)

    // the embedder answers now: the pending artifact gets its vector, and once every artifact has one, a run asks nothing
    answerFail = true
    const third = await runEmbeddingsStage()
    expect(third.artifacts).toEqual({ embedded: 1, pending: 0, skipped: 0, batches: 1 })
    expect(embedCalls).toBe(4)
    expect(await sideCounts(open)).toEqual({ memory: 2, doc: 1, artifact: 2 })

    const fourth = await runEmbeddingsStage()
    expect(fourth.memory).toEqual({ embedded: 0, skipped: 1, batches: 1 })
    expect(fourth.artifacts).toEqual({ embedded: 0, pending: 0, skipped: 0, batches: 0 })
    expect(embedCalls).toBe(4)
  })

  it('the CLI subcommand boots the app role, prints the counts and exits 0 with the embedder unreachable (artifacts pending)', async () => {
    open = await createPgTestDb()
    await seed(open)
    // The embedder address is a closed port. The config reads OLLAMA_URL from the .env file of CLAUDECLAW_ENV_DIR (not from the
    // process env), so the CLI gets a directory of its own holding that one line. The artifacts are pending, the run completes.
    // Without this the run would reach a local Ollama.
    envDir = mkdtempSync(join(tmpdir(), 'pgcopy-emb-'))
    writeFileSync(join(envDir, '.env'), 'OLLAMA_URL=http://127.0.0.1:9\n')
    const run = (): { status: number | null; report: CliReport; stderr: string } => {
      const r = spawnSync(tsx, [runner, 'migrate-sqlite-to-pg', 'embeddings'], {
        cwd: repo,
        encoding: 'utf8',
        timeout: 120000,
        // no LOG_TO_STDERR here: the runner sets it, so the operator's command is the one under test
        env: { ...process.env, CLAUDECLAW_ENV_DIR: envDir!, MARVEEN_PG_URL: open!.appUrl },
      })
      return { status: r.status, report: r.stdout ? JSON.parse(r.stdout) as CliReport : ({} as CliReport), stderr: r.stderr }
    }

    const first = run()
    expect(first.status, first.stderr).toBe(0)
    expect(first.report.memory).toEqual({ embedded: 2, skipped: 1, batches: 1 })
    expect(first.report.workspace_doc).toEqual({ embedded: 1, skipped: 0, batches: 1 })
    expect(first.report.artifacts).toEqual({ embedded: 0, pending: 2, skipped: 0, batches: 1 })
    expect(await sideCounts(open)).toEqual({ memory: 2, doc: 1, artifact: 0 })

    const second = run()
    expect(second.status, second.stderr).toBe(0)
    expect(second.report.memory.embedded).toBe(0)
    expect(second.report.workspace_doc.embedded).toBe(0)
  }, 180000)
})

describe('the side tables carry no user trigger: the stage refuses by name, before any write (c4)', () => {
  it('a user trigger on a side table: the stage stops, names the table and the trigger, and writes no side row', async () => {
    open = await createPgTestDb()
    await seed(open)
    setBackend(createPgDbx(open.pool), 'pg')
    stubEmbedder()
    await open.pool.query("CREATE FUNCTION noop_side() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RETURN NEW; END $$")
    await open.pool.query('CREATE TRIGGER noop_side BEFORE INSERT ON memory_embeddings FOR EACH ROW EXECUTE FUNCTION noop_side()')
    await expect(runEmbeddingsStage()).rejects.toThrow(/memory_embeddings has user trigger noop_side/)
    expect(await sideCounts(open)).toEqual({ memory: 0, doc: 0, artifact: 0 })
  })
})
