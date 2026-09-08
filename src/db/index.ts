// Re-export surface for the split db.ts modules, plus the wired
// initDatabase() that orchestrates connection bootstrap + vector-domain
// post-migration setup. connection.ts never imports a domain module (kept
// acyclic on purpose -- every domain module imports connection.ts, not the
// other way round); this file is the one place allowed to know about all of
// them, so it is also the one place that sequences cross-domain boot steps.
//
// src/db.ts re-exports everything from here, so the 153 existing importers
// of '../../db.js' (or similar relative paths) keep working unchanged.
export * from './connection.js'
export * from './agents.js'
export * from './audit.js'
export * from './kanban.js'
export * from './memory.js'
export * from './misc.js'
export * from './observability.js'
export * from './sessions.js'
export * from './tasks.js'
export * from './vault.js'
export * from './vector.js'

import { initDatabase as connectionInitDatabase } from './connection.js'
import { backfillImportShadowRows, initVecSupport, migrateExistingEmbeddingsToBLOB } from './vector.js'
import { logger } from '../logger.js'

export function initDatabase(dbPathOverride?: string): void {
  connectionInitDatabase(dbPathOverride)

  // Convert any remaining JSON-text embeddings to compact Float32 BLOB and null
  // out the TEXT column. Idempotent: rows already having embedding_blob are
  // skipped; on fresh installs or after a full backfill this is a no-op.
  migrateExistingEmbeddingsToBLOB()

  // Load sqlite-vec extension and set up the ANN virtual table + sync triggers.
  // Safe no-op if the extension binary is unavailable; vectorSearch falls back
  // to full-scan BLOB cosine similarity in that case.
  initVecSupport()

  // Create shadow rows in memories for any import_memories entries that lack
  // them. Must run after initVecSupport so that vec0 is loaded and the
  // vec_memories virtual table exists before the backfill inserts into it.
  void backfillImportShadowRows().catch(err => logger.warn({ err }, 'Import shadow backfill failed'))
}
