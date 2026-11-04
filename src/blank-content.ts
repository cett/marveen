// One definition of "this text is blank" for every path that writes a memory's content.
//
// `String.prototype.trim()` strips what the language calls whitespace (spaces, tabs, line breaks,
// NBSP, the Unicode space separators, the BOM). It does not strip the zero-width characters, so a
// text of nothing but U+200B passed `content.trim() === ''` and replaced a memory with something
// nobody can see. The set below is the whitespace set plus those invisible characters.
//
// The same set is written out by hand in the memories.content triggers (migration 0087,
// `trim(NEW.content, char(...))`), because SQLite cannot call this function. A test holds the two
// lists equal, so changing one without the other fails.

/** Invisible characters that `\s` does not match. */
const INVISIBLE_CODE_POINTS: readonly number[] = [
  0x00ad, // soft hyphen
  0x180e, // Mongolian vowel separator
  0x200b, // zero width space
  0x200c, // zero width non-joiner
  0x200d, // zero width joiner
  0x2060, // word joiner
]

const INVISIBLE = new Set<number>(INVISIBLE_CODE_POINTS)

/** True when `text` has no visible character: empty, whitespace only, or whitespace and invisible characters only. */
export function isBlankContent(text: string): boolean {
  for (const ch of text) {
    if (INVISIBLE.has(ch.codePointAt(0)!)) continue
    if (/\s/.test(ch)) continue
    return false
  }
  return true
}

/** Every BMP code point `isBlankContent` treats as blank on its own. Exposed for the SQL parity test. */
export function blankCodePoints(): number[] {
  const out: number[] = []
  for (let cp = 0; cp <= 0xffff; cp++) {
    if (cp >= 0xd800 && cp <= 0xdfff) continue
    if (isBlankContent(String.fromCharCode(cp))) out.push(cp)
  }
  return out
}

/** Thrown by the DB layer when a write would leave a memory with blank content. */
export class BlankContentError extends Error {
  constructor(where: string) {
    super(`${where}: content must not be blank`)
    this.name = 'BlankContentError'
  }
}
