// The `name:` of a skill's frontmatter, read in LINEAR time.
//
// This is the same read as tenant_context_lib._frontmatter_name (the hook side) and used to be two regular expressions:
//   /^---\s*\n([\s\S]*?)\n---/   then   /^name:\s*(.+?)\s*$/m
// The second one is quadratic: `(.+?)\s*$` is a lazy run followed by a whitespace run, and on a line `name: x` + N spaces + `y` every
// step of the lazy run re-scans the rest of the spaces (40 000 spaces cost 3.4 s on the dashboard's event loop). A skill's content has
// no size ceiling and a tenant user writes it, so the read must not depend on the shape of the text.
//
// The result is EXACTLY what the pair gave (src/__tests__/skill-frontmatter-name.test.ts runs both on generated inputs): the first
// `name:` line whose value can be read, the value being the rest of the line without its trailing whitespace, then trimmed and
// stripped of surrounding quotes. A value that is only whitespace reads as '' (the caller drops it).
//
//   - line terminators are the ones a JavaScript `.` and `$` (with the m flag) know: \n, \r, U+2028 and U+2029
//   - after `name:` ONE whitespace run is skipped (it may cross lines, as `\s*` did), then the value is the rest of that line
//   - no value at all (only whitespace to the end of the block): a whitespace character that is not a terminator reads as the value
//     '' (that is how `.+?` could still match one), otherwise the next `name:` line is tried
const FRONTMATTER_RX = /^---\s*\n([\s\S]*?)\n---/
const NAME_LINE = /^name:/gm
const TERMINATOR = /[\n\r\u2028\u2029]/
const WS = /\s/

export function frontmatterName(content: string | null): string | null {
  const m = FRONTMATTER_RX.exec(content ?? '')
  if (!m) return null
  const block = m[1]!
  NAME_LINE.lastIndex = 0
  for (let hit = NAME_LINE.exec(block); hit !== null; hit = NAME_LINE.exec(block)) {
    const from = hit.index + 5
    let k = from
    while (k < block.length && WS.test(block[k]!)) k++
    if (k < block.length) {
      let e = k
      while (e < block.length && !TERMINATOR.test(block[e]!)) e++
      return block.slice(k, e).trim().replace(/^["']+|["']+$/g, '')
    }
    // only whitespace to the end: a non-terminator character in it is the one `.+?` could take
    for (let i = k - 1; i >= from; i--) if (!TERMINATOR.test(block[i]!)) return ''
  }
  return null
}
