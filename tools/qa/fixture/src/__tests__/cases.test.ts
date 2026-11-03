// Fixture of tools/qa/check-scanners.mjs: vacuous-notthrow-scan must report exactly the lines marked
// `// expect: <kind>` and nothing else.
declare function expect(v: unknown): { not: { toThrow(): void }; toThrow(): void }
declare function work(): Promise<void>

expect(() => work()).not.toThrow() // expect: vacuous-not-toThrow
expect(async () => { await work() }).not.toThrow() // expect: vacuous-not-toThrow
expect(() => 1).not.toThrow()
expect(() => { throw new Error('x') }).toThrow()
expect(() => work()).toThrow()
