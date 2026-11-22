# Recall/quality baseline harness

Freezes what the current retrieval pipeline (FTS5 + sqlite-vec + RRF, optional cross-encoder rerank)
returns for a fixed query set, so a later PostgreSQL backend (tsvector + pgvector) can be compared
against it with the accepted thresholds (vector recall@10 >= 0.99, final top-5 overlap >= 0.95,
nDCG@10 drop <= 0.01). It measures drift against the baseline, not absolute retrieval quality: there
are no human relevance judgements, the baseline ranking is the pseudo ground truth.

```
npx tsx scripts/eval/recall-eval.ts prepare     --out store/eval          # COPY of the live DB; orphan vec rows dropped from the copy only
npx tsx scripts/eval/recall-eval.ts gen-queries --dir store/eval          # seeded, reproducible query set
npx tsx scripts/eval/recall-eval.ts embed       --dir store/eval          # one-time Ollama call per query, cached
MARVEEN_STORE_DIR=$PWD/store/eval \
npx tsx scripts/eval/recall-eval.ts snapshot    --dir store/eval --out store/eval/baseline-sqlite.json
npx tsx scripts/eval/recall-eval.ts compare     --base baseline-sqlite.json --cand baseline-pg.json
```

Design points
- Deterministic: frozen clock (`Date.now`), query embeddings only from the cache (a cache miss is an
  error, never a live call), seeded query generation. Two snapshots of the same prepared dir must
  compare as identical (determinism self-check).
- Safe: `snapshot` refuses to run unless `MARVEEN_STORE_DIR` is the prepared eval dir, which carries a
  marker file; the live DB is only ever read through the SQLite backup API.
- Stages per query: `fts`, `vec_prod` (what production does: ANN top-k, then filter, recency sort),
  `vec_exact` (filter first, then exact L2 top-10 = what `ORDER BY embedding <-> $1 LIMIT 10` returns on
  pgvector), `final` (the real `hybridSearch` / `hybridSearchDocs` / `searchArtifactsByVector`).
- Metric parity: the vec0 tables use the default L2 distance and the stored embeddings are NOT
  normalised (norm about 17-20), so pgvector must use `<->` (vector_l2_ops); cosine (`<=>`) would
  change about 12% of the top-10 members (measured on 30 probe vectors: L2 vs cosine overlap 0.877).
- Private data: the real query set, the embedding cache and the snapshots contain memory-derived
  text/ids. They live under `store/` (gitignored); only this harness and the synthetic unit tests are
  committed. Never commit a real snapshot.

A PostgreSQL candidate snapshot writes the same JSON schema (`Snapshot` in
`recall-eval-lib.ts`), with the same query set and embedding cache.

## PostgreSQL side (full-text stage only)

The same prepared eval copy can be loaded into a scratch PostgreSQL database and its full-text stage snapshotted
through the production search functions (`recall-eval-pg.ts`). The admin URL comes from `MARVEEN_PG_EVAL_URL`
(never from the command line); the scratch database is named `marveen_eval_<suffix>` and every other name is refused.

```
MARVEEN_PG_EVAL_URL=postgres://... npx tsx scripts/eval/recall-eval-pg.ts load     --dir store/eval   # scratch DB, migrations, preflight, copy
MARVEEN_PG_EVAL_URL=postgres://... npx tsx scripts/eval/recall-eval-pg.ts snapshot --dir store/eval --out store/eval/pg-fts.json
npx tsx scripts/eval/recall-eval-pg.ts compare-fts --base store/eval/baseline-sqlite.json --cand store/eval/pg-fts.json
```

- The PostgreSQL snapshot has the `fts` stage only (memory, doc, artifact); the vector stages are skipped and named in
  the snapshot meta until the vector step. `compare-fts` compares the `fts` stage (top-10, top-5, nDCG@10) and exits 3
  (STOP) when a kind's mean top-10 overlap is below 0.85: that is a ranking question for the architect, not a tuning one.
- The baseline has no `fts` stage for artifacts, so artifacts are listed as not compared.
- The copy goes into PostgreSQL through its own columns: a SQLite-only column is reported as dropped, the generated
  full-text column is left to PostgreSQL, and a text value bound for a bytea column is stored as its UTF-8 bytes.
