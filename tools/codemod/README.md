# db codemod

Moves a `src/db/<module>.ts` onto the async db facade (`dbx`) and follows the change through the callers. Own toolchain
(ts-morph with its own TypeScript), not imported by the build. Header of `codemod.mjs` lists what it rewrites and what it only reports.

```
npm ci --prefix tools/codemod --ignore-scripts      # once
node tools/codemod/codemod.mjs --dry-run --report /path/outside/the/repo/first-run.json src/db/<module>.ts ...
node tools/codemod/codemod.mjs --report /path/outside/the/repo/first-run.json src/db/<module>.ts ...    # writes
node tools/codemod/selftest.mjs                      # fixture self-test, a few seconds
node tools/codemod/codemod.mjs --tests --report /path/outside/the/repo/tests.json src/__tests__/<file>.test.ts ...   # test files
```

## `--tests`: the raw handle in the test files

The targets are test files whose bodies read or write through the raw SQLite handle. The handle is recognised as `db` imported
from `db.js` / `db/index.js` / `db/connection.js`, as `getDb()` and as a local alias `const x = getDb()`. The rewrites are the
same as for a module (`db.prepare(sql).get|all|run(...)` -> `await dbx.get|all|run(sql, ...)`, `db.exec` -> `await dbx.exec`), with
these differences: the callbacks of `it`/`test`/`beforeEach`/`afterEach`/`beforeAll`/`afterAll` become async, a `describe` callback
never does, `db.transaction` is never rewritten (reported: the transaction shape is a manual decision), an unrecognised `db`
variable (a handle the test opened itself) is reported as `other-db-variable`, and the `dbx` import is merged into the `db.js`
import of the file (the `db` / `getDb` specifier goes away when nothing reads it). A rewritten test runs on SQLite too, so the
conversion must not touch an assertion: a thrown-error assertion on a converted call (`expect(() => f()).toThrow()`) is reported
and rewritten by hand as `await expect(f()).rejects.toThrow()`.

## Keep the report of the FIRST real run

The manual checklist of a module is the `manual` list of the report of the first run that writes. A second run finds no
`db.prepare` left in the module, so its list is empty: the boot-synchronous callers (`src/db/index.ts`), the callbacks that
expect a synchronous value, the function values and the tests that need `useTestDb` are gone from it, although nothing was
resolved. So: run with `--report <file>` OUTSIDE the repository (a work document, not a loose file in the tree), upload the
JSON or its `manual` list to the work-document store (`workspace_docs`, e.g. `notes/<card>-codemod-report-<module>`) and work
through it; the PR material quotes the counts (functions converted, awaits added, manual places per kind). The console
output ends with a `SUMMARY` line per kind (count, files, the three biggest) for a long list.

## What the self-test pins

`fixture/in` is run through the codemod and compared with `fixture/out`. Besides the rewrites it pins the safety rules, each
one with a case that fails when the rule is taken out: a callback of `map`, `forEach`, `setInterval` or one expecting `void`
is reported and left as it is (otherwise it would silently become async: an array of Promises, a floating Promise); a function
with a stored statement is skipped as a whole; an already-async transaction body is left alone; `return` of a Promise stays a
plain `return` outside try/catch/finally; a boot-synchronous caller and a function value are reported; a second run changes nothing.
