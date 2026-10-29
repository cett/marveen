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
- Statuses: `killed` (with the first failing test), `survived`, `no-tests`, `baseline-error`, `timeout`, `error`.
- `--workers` defaults to 4; `--only <text>` limits the files, `--work-dir`, `--keep`, `--timeout-sec` as in the header
  of the script.

## Self-test

`node tools/qa/check-scanners.mjs` runs both scanners over `tools/qa/fixture` and fails unless they report
exactly the lines marked `// expect: <kind>` there. Add a marked line when a scanner learns a construct.
`node tools/qa/check-mutants.mjs` checks the mutant list of the sweep against a throwaway git repository.
