// Text hygiene shared by the places that compare agent-written strings: control, format and zero-width
// code points render as nothing, so they must not make two strings differ. Kept dependency-free so the
// database layer can use it too (the approval module reaches the database, which would be a cycle).

// Ranges are listed as numbers so the source carries no invisible character itself.
const INVISIBLE_RANGES: ReadonlyArray<readonly [number, number]> = [
  [0x0000, 0x001f], [0x007f, 0x009f], [0x00ad, 0x00ad], [0x061c, 0x061c], [0x180e, 0x180e],
  [0x200b, 0x200f], [0x2028, 0x202e], [0x2060, 0x206f], [0xfeff, 0xfeff],
]

export function stripInvisible(s: string): string {
  let out = ''
  for (const ch of s) {
    const cp = ch.codePointAt(0) ?? 0
    if (!INVISIBLE_RANGES.some(([lo, hi]) => cp >= lo && cp <= hi)) out += ch
  }
  return out
}
