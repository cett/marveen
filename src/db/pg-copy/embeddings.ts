// The embeddings stage of the SQLite -> PostgreSQL copy (P-G1, spec 2.5). The copy carries the blob columns over, so the side
// tables of memories and workspace docs are filled from them (backfillPgEmbeddings, keyset, resumable). The artifacts have
// no blob on PostgreSQL, so they are re-embedded from their title and meta (reembedArtifacts, P-G4). Both are idempotent: a
// second run embeds nothing, and an interrupted run continues where the side rows stop.
// It runs on the app-role backend (booted by the CLI through bootPgBackend) in a system context for the job, so it also
// proves that the serving role can write the side tables. A row the embedder does not answer for is `pending`, not an error.

import { runAs } from '../context.js'
import { dbx } from '../facade.js'
import { backfillPgEmbeddings, type VectorBackfillResult } from '../vector.js'
import { reembedArtifacts, type ArtifactReembedResult } from '../artifacts.js'

export interface EmbeddingsStageReport {
  memory: VectorBackfillResult
  workspace_doc: VectorBackfillResult
  artifacts: ArtifactReembedResult
}

/**
 * The side tables are written by the app role, which cannot suspend a user trigger (ALTER TABLE needs the owner). A user trigger
 * on one of them would run for every side row, so the stage refuses by name, before any write (c4 placement of the 2026-11-24
 * trigger decision).
 */
export async function assertNoUserTriggersOnSideTables(): Promise<void> {
  const rows = await dbx.all<{ table_name: string; name: string }>(
    `SELECT c.relname::text AS table_name, t.tgname::text AS name
       FROM pg_trigger t
       JOIN pg_class c ON c.oid = t.tgrelid
      WHERE NOT t.tgisinternal
        AND c.relname IN ('memory_embeddings', 'workspace_doc_embeddings', 'artifact_embeddings')
      ORDER BY 1, 2`,
  )
  const first = rows[0]
  if (first !== undefined) {
    throw new Error(
      `embeddings side table ${first.table_name} has user trigger ${first.name}: the stage cannot suspend it, move the trigger first`,
    )
  }
}

export async function runEmbeddingsStage(): Promise<EmbeddingsStageReport> {
  await assertNoUserTriggersOnSideTables()
  const { memory, workspace_doc } = await runAs.system('embeddings-stage', async () => ({
    memory: await backfillPgEmbeddings('memory'),
    workspace_doc: await backfillPgEmbeddings('workspace_doc'),
  }))
  const artifacts = await reembedArtifacts()
  return { memory, workspace_doc, artifacts }
}
