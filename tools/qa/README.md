# tools/qa

Mechanical QA checks that need the TypeScript type checker. They run from the isolated
`tools/eslint` toolchain (TypeScript 6.0, the classic API that TypeScript 7 does not ship):
`npm ci --prefix tools/eslint --ignore-scripts` once, then the commands below from the repo root.
Every tool writes a JSON report to stdout and a one-line-per-finding summary to stderr.

## Scanners

| Tool | Finds | Mode in CI |
|---|---|---|
| `promise-misuse-scan.mjs` | a Promise-typed expression in a non-awaiting position: call argument, template, object property, condition, `!`, `==`, spread, array element, property access, a callback that returns a Promise | report (job summary + artifact), a null check on an in-flight promise is legitimate |
| `vacuous-notthrow-scan.mjs` | `expect(() => <Promise>).not.toThrow()`, which can never fail | fails the pull request (the tree has none) |

```
node tools/qa/promise-misuse-scan.mjs --base <sha>      # the lines base..HEAD added under src/
node tools/qa/promise-misuse-scan.mjs --all             # the whole src/ tree
node tools/qa/vacuous-notthrow-scan.mjs --base <sha>    # or --all
```

Options: `--root <repo>`, `--tsconfig <rel>`, `--src <dir>` (promise scan), `--fail-on-findings`.

## Per-await mutation sweep

`await-mutants.mjs` removes, one at a time, every `await` the diff `base..HEAD` added to `src/` and runs the tests
that import the file (`vitest related --bail`). A mutant that no test fails on SURVIVED: that await is not
protected by a test.

```
node tools/qa/await-mutants.mjs --base <sha> --list                 # the mutant list, nothing runs
node tools/qa/await-mutants.mjs --base <sha> --workers 4 > mutants.json
node tools/qa/compare-mutants.mjs serial.json parallel.json         # validation: same status per mutant
```

- Runs from COPIES of the committed HEAD (`git archive`, one per worker, each with its own empty git repository
  because `vitest.config.ts` asks git for the main checkout), so the working directory stays free and only the
  commit is tested. Commit before you sweep.
- Every mutant gets its own `MARVEEN_STORE_DIR` and `HOME`.
- Phase 1 runs the unmutated related tests of each touched file. A test that fails there (it depends on the
  checkout path or the host) cannot kill a mutant: a mutant is killed only by a failure outside that set.
- Statuses: `killed` (with the first failing test), `survived`, `no-tests`, `baseline-error`, `timeout`, `error`,
  and `flaky` with `--confirm-kills` (a killed mutant is run a second time; one that is not killed again is flaky).
- `--workers` defaults to 4; `--only <text>` limits the files, `--work-dir`, `--keep`, `--timeout-sec` as in the header
  of the script.

## T1: the machine part of a QA run, in one command

`node tools/qa/t1.mjs [--root <repo>] [--json <path>] [--vitest full|related|none] [--base-sha <sha>] [--ci] [--build]`
runs the table a QA agent used to run by hand and writes one JSON report (step, rc, seconds, first line of
trouble) plus a one-line-per-step summary on stderr. Exit 0 only when every step answered rc 0; a failing step does
not stop the others.

- Default profile (the rows of the manual T1 table): `ci.yml` parity, `npm run typecheck`, the README fork-diff
  check, the 5 ratchets, the async lint of `src`, the async lint of the tests, its ratchet, and the full vitest suite.
- `--ci` adds what the CI jobs run on top of that and needs no network: the CSS guard, the commit-subject check and
  the CHANGELOG check (both need `--base-sha`, they are skipped with a note without it), the two lint self-tests, the
  codemod self-test, the shell tests and the python tests. `--build` also runs `npm run build`. `npm audit` and the
  `security` job are not part of it.
- Vitest: `full` (default) runs the whole suite through `scripts/vitest-guard.py` with a fresh `MARVEEN_STORE_DIR`
  and `HOME` (never the production store), one full suite at a time on the machine (a lock file under the OS temp
  directory, a dead holder's lock is released), and sorts the failed test files with two small reruns of only
  those files: green on a rerun with the same override is reported as a flake (load, a timing test), red with it
  and green without it as override-dependent, red without it too as a real failure. A green rerun alone cannot
  tell the first two apart, hence the extra rerun. `related` hands over to `scripts/ci-vitest-related.sh <base-sha>`
  (the same rule as a PR in CI: the tests that reach the changed files, the whole suite only when the test
  configuration changed). `none` (also `--skip-vitest`) skips it. The choice is the QA agent's; t1 never picks it.
- Preflight: a fresh worktree has no `tools/eslint/node_modules` (gitignored); t1 runs
  `npm ci --prefix tools/eslint --ignore-scripts` once when it is missing (with `--ci` also `tools/codemod`) and says so.
- Parity: the first row, `ci-parity`, fails when a `run:` step of the `build-checks` or `test` job in `ci.yml` is
  neither covered by a t1 row nor on the commented exclusion list in `t1.mjs`, so a new CI step cannot quietly
  drift away from T1.

## Delta class: what a delta is made of

`node tools/qa/delta-class.mjs --base <sha> [--root <repo>] [--ts-root <dir>] [--json <path>]` counts, from
`git diff base..HEAD`, what a delta QA used to count by hand ("this is docs/tests only", "src changed by N lines").
JSON on stdout, a three-line summary on stderr, exit 0 when the report was made (2 on a bad argument or a base that is
no commit).

| Field | Meaning |
|---|---|
| `files[]` | per file: `path`, `oldPath` (renames), `status` (A/M/D/R/C), `class`, `oldClass` (only when a rename changed class), `added`, `deleted`, `binary` |
| `counts` | files per class |
| `srcLinesChanged` | lines added plus lines deleted in `src` files (a rename counts when either path is `src`) |
| `awaitsAdded` | awaits added to `src`: the length of the `await-mutants.mjs --list` list (same code, `lib/mutants.mjs`); `null` plus `awaitsError` when the TypeScript of `tools/eslint` is not installed (nobody counted, so not 0) |
| `migrations` | the migration files the delta touches |
| `touchesGateFiles` | any gate file touched (either path of a rename) |
| `testsOnly`, `docsOnly` | every file is a test / every file is docs; false for an empty delta |
| `depsChanged` | a `package.json` or `package-lock.json` (any directory, so `tools/eslint` and `tools/codemod` too) is in the delta, either path of a rename. Data only: the class stays `ci/tools`, and the lines of a lock file are not in `srcLinesChanged` (thousands of them would bury the number) |
| `dirty` | a tracked file has an uncommitted change (the awaits are read from the working tree, the rest from the commits) |

Classes, first matching rule wins: `migracio` (`src/migrations/*.sql`), `kapu-fajl` (`scripts/hooks/` and
`scripts/lib/` except tests, a `scripts/` file with "gate" in its name, the gate-adjacent scripts and sources
`self-pace-gate.mjs` guards, the secret-gate workflow), `teszt` (`__tests__/`, `*.test.*`, `*.spec.*`, `test_*.py`,
`test/` and `tests/` directories), `docs` (`*.md`, `LICENSE`, and prose or assets under `docs/`: txt, rst, images,
pdf, html; but a Markdown file under `src/`, `seed-skills/`, `web/`, `agents/`, `personas/` or `templates/` is loaded
by the product and stays `src`, and so does any other file under `docs/`: `docs/openapi.yaml` is the API contract the
SDK is generated from, not prose), `ci/tools` (`.github/`, `tools/`, package
manifests and lock files, `tsconfig*`, the vitest and eslint config), and `src` for everything else, so "no src
lines" is never claimed for a path the rules do not know. `classifyPath` in `delta-class.mjs` is the one list; a
test pins every rule.

The report decides nothing: there is no "QA not needed" field. What the facts mean stays with the QA agent.

## Self-test

`node tools/qa/check-scanners.mjs` runs both scanners over `tools/qa/fixture` and fails unless they report
exactly the lines marked `// expect: <kind>` there. Add a marked line when a scanner learns a construct.
`node tools/qa/check-mutants.mjs` checks the mutant list of the sweep against a throwaway git repository.
