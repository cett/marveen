-- PostgreSQL vector embeddings (phase 3, step 6b). The embedding of a memory, a workspace document and an artifact lives
-- in a side table with a cascading foreign key to its parent, not in a column of the parent row: the main statements of
-- the three tables stay as they are, and no route can return a 768-float column by accident. One embedding per parent (the
-- primary key); a delete of the parent removes the embedding. The dimension is the SQLite embedding size (768 float32, the
-- embedding_blob columns). No vector index yet: the search is an exact scan. The SQLite blob columns stay and keep being
-- written until the SQLite branch is retired (dual storage).
-- The extension is created here, so every migrated template carries it. A server without the vector extension fails the
-- template build at this statement, on purpose.

CREATE EXTENSION IF NOT EXISTS vector;

CREATE TABLE memory_embeddings (
  memory_id bigint PRIMARY KEY REFERENCES memories (id) ON DELETE CASCADE,
  embedding vector(768) NOT NULL
);

CREATE TABLE workspace_doc_embeddings (
  doc_id    text PRIMARY KEY REFERENCES workspace_docs (id) ON DELETE CASCADE,
  embedding vector(768) NOT NULL
);

CREATE TABLE artifact_embeddings (
  artifact_id text PRIMARY KEY REFERENCES artifacts (id) ON DELETE CASCADE,
  embedding   vector(768) NOT NULL
);
