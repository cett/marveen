// Self-test input for the async lint toolchain (tools/eslint/check-fixture.mjs). Each line that must be
// reported ends in `// expect: <rule>`; every other line must stay clean. The check fails the build when the
// linter reports anything else or misses one, so a type the TypeScript 6.0 linter cannot resolve (a silent
// false negative while the TypeScript 7 build stays green) is caught here, not in the project's numbers.
//
// The node:fs case needs @types/node from the project's node_modules, which is exactly what is missing
// when the lint runs without the root `npm ci`.

import { readFileSync } from 'node:fs'

async function load(): Promise<number> {
  await Promise.resolve()
  return 1
}

export function floating(): void {
  load() // expect: no-floating-promises
}

export function promiseAsCondition(): void {
  if (load()) { /* a Promise is always truthy */ } // expect: no-misused-promises
}

export function asyncCallbackWhereVoidIsExpected(run: () => void): void {
  run()
}
asyncCallbackWhereVoidIsExpected(async () => { await load() }) // expect: no-misused-promises

export async function awaitOfAValueThatIsNotThenable(): Promise<void> {
  await readFileSync('fixture') // expect: await-thenable
}

export async function asyncWithoutAwait(): Promise<number> { // expect: require-await
  return 1
}

// Clean on purpose: none of these may be reported.
export async function handled(): Promise<void> {
  await load()
  void load()
  load().catch(() => undefined)
}
