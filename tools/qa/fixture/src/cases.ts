// Fixture of tools/qa/check-scanners.mjs: promise-misuse-scan must report exactly the lines marked
// `// expect: <kind>` and nothing else. Keep one construct per line.
declare function fetchValue(): Promise<number>
declare function takes(v: unknown): void

export async function misuse(): Promise<unknown[]> {
  const v = fetchValue()
  takes(fetchValue()) // expect: call-arg
  const t = `${fetchValue()}` // expect: template
  const o = { v: fetchValue() } // expect: object-prop
  const s = { v } // expect: object-shorthand
  if (v) { takes(1) } // expect: condition
  const b = v == null // expect: binary
  const n = v ? 1 : 2 // expect: ternary-cond
  const x = !v // expect: not
  const sp = { ...v } // expect: spread
  const arr = [v] // expect: array-el
  const p = v.constructor // expect: prop-access
  const f = [1, 2].filter(async (e) => e > 1) // expect: callback-returns-promise
  void sp
  return [t, o, s, b, n, x, arr, p, f]
}

// None of these is a finding.
export function fine(): Promise<unknown[]> {
  const v = fetchValue()
  const awaited = fetchValue()
  const all = Promise.all([v, fetchValue()])
  const chained = v.then((e) => e + 1)
  const caught = v.catch(() => 0)
  const direct = fetchValue()
  return Promise.all([awaited, all, chained, caught, direct, v])
}
