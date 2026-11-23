# Local pgvector for the PostgreSQL test harness

The PostgreSQL test suite (`npm run test:pg`) and the pg-parity CI job run against
the `pgvector/pgvector` image, pinned by tag and digest in
`.github/workflows/ci.yml`. The image is the official `postgres:16` image with
the `vector` extension preinstalled.

Pinned image: `pgvector/pgvector:0.8.7-pg16@sha256:484e838076e04939d27d3e176e91c86eea96236126023be8d3059761122e579f`
GitHub source tag: `v0.8.7` (commit `f37c13f68b57d2c3472b2214fbcff699d6d34876`)

## Local setup (macOS, Homebrew PostgreSQL 16)

Homebrew's PostgreSQL 16 does not ship the pgvector files. Build the extension
against the same tag. Nothing here needs sudo, and no server restart is needed:
the extension is loaded by `CREATE EXTENSION`.

    cd "$(mktemp -d)" && git clone --branch v0.8.7 --depth 1 https://github.com/pgvector/pgvector.git && cd pgvector
    make PG_CONFIG=/opt/homebrew/opt/postgresql@16/bin/pg_config
    make PG_CONFIG=/opt/homebrew/opt/postgresql@16/bin/pg_config install
    createdb vtest && psql vtest -c "CREATE EXTENSION vector; SELECT '[1,2,3]'::vector <-> '[4,5,6]'::vector;" ; dropdb vtest

Expected output: one row, `5.196152`.

To remove it: run `make uninstall` with the same `PG_CONFIG`.

## After a Homebrew upgrade

`brew upgrade postgresql@16` can move the server files to a new Cellar directory
and drop the pgvector files. Re-run the build steps above against the new
`pg_config`.

## Fail-closed behaviour

Once the vector migration is in place, a machine without the extension
fails every PostgreSQL test file at the template build. The error names the missing
extension. This is intentional.
