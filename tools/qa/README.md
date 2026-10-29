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

## Self-test

`node tools/qa/check-scanners.mjs` runs both scanners over `tools/qa/fixture` and fails unless they report
exactly the lines marked `// expect: <kind>` there. Add a marked line when a scanner learns a construct.
