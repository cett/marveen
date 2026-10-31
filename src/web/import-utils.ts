import { decodeHTMLStrict } from 'entities'

// Extensions whose raw content is markup and should be stripped to plain text
// before storage and embedding, so cosine similarity finds content neighbours.
export const HTML_LIKE_EXTS = new Set(['.html', '.htm', '.xml', '.svg'])

// A complete entity: named (&ouml;), decimal (&#337;) or hex (&#x151;), with
// the closing semicolon. The semicolon is required on purpose: the HTML
// legacy "no semicolon" forms would turn `?a=1&copy=2` in a URL into text.
const ENTITY_RE = /&(?:#[xX][0-9a-fA-F]{1,8}|#[0-9]{1,10}|[A-Za-z][A-Za-z0-9]{1,31});/g

// Decodes HTML character references in already tag-free text. One pass over
// the original string, so `&amp;lt;` becomes the text `&lt;` and is never
// decoded a second time. An unknown name, an out-of-range code point (0,
// surrogates, above U+10FFFF) and a control character stay as the original
// text instead of being replaced or dropped.
export function decodeEntities(text: string): string {
  return text.replace(ENTITY_RE, (m) => {
    const d = decodeHTMLStrict(m)
    if (d === m) return m
    // The decoder answers U+FFFD for an invalid numeric reference; keep the
    // reference unless the document really asked for U+FFFD.
    if (d === '\uFFFD' && !/^&#(?:[xX]0*[fF]{3}[dD]|0*65533);$/.test(m)) return m
    if (/^[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]$/.test(d)) return m
    return d
  })
}

// Strip HTML/XML/SVG markup down to plain text: removes script/style blocks and
// all tags, then decodes character references, then normalises whitespace.
// Decoding comes AFTER the tag strip: an escaped `&lt;script&gt;` in the source
// is document text and must survive as the text `<script>`, while a decode
// first would let it be mistaken for a real tag and be cut out.
//
// Linear in the text length. The three patterns this used to run (a lazy body up to
// `</script>`, the same for `</style>`, and a run of "anything but '>'" up to a '>') each
// searched the rest of the text again from every opener that had no closer, so a page of
// many openers (500 KB of `<a `) held the dashboard's event loop for tens of seconds. The
// openers are still found by a pattern; the closer is looked up once with indexOf / a
// sticky search and reused by every later opener (the algorithm of scrubSecurityTags in
// src/prompt-safety.ts). The output is the same as the old patterns gave.
export function stripMarkup(raw: string): string {
  return decodeEntities(
    stripAngleTags(
      removeBlocks(removeBlocks(raw, /<script/gi, /<\/script>/gi), /<style/gi, /<\/style>/gi),
    ),
  )
    .replace(/\s+/g, ' ')
    .trim()
}

/** Cut every `open ... close` block (an opener, then everything up to the FIRST closer after
 *  it; case per the flags). An opener inside a cut block is part of it; an opener with no
 *  closer after it stays. Same result as replace(/open[\s\S]*?close/g, ''). */
function removeBlocks(text: string, open: RegExp, close: RegExp): string {
  let out = ''
  let copied = 0 // text[0, copied) is already in `out` or cut
  let closeAt = -2 // first closer at or after the last probe; -1 = none left, -2 = not probed yet
  let closeEnd = -1
  for (const m of text.matchAll(open)) {
    const start = m.index
    const end = start + m[0].length
    if (start < copied) continue
    if (closeAt !== -1 && closeAt < end) {
      close.lastIndex = end
      const c = close.exec(text)
      closeAt = c ? c.index : -1
      closeEnd = c ? c.index + c[0].length : -1
    }
    if (closeAt === -1) break // no closer left, so no later opener can close either
    out += text.slice(copied, start)
    copied = closeEnd
  }
  return out + text.slice(copied)
}

/** Replace every `<...>` tag (at least one character between '<' and the first '>') with a
 *  space. Same result as replace(/<[^>]+>/g, ' '), in one pass: the '>' is looked up once and
 *  reused by every later '<'. */
export function stripAngleTags(text: string): string {
  let out = ''
  let copied = 0 // text[0, copied) is already in `out`
  let scan = 0 // next position to look for a '<'
  let gt = -2 // first '>' at or after the last probe; -1 = none left, -2 = not probed yet
  for (;;) {
    const lt = text.indexOf('<', scan)
    if (lt === -1) break
    if (gt !== -1 && gt <= lt) gt = text.indexOf('>', lt + 1)
    if (gt === -1) break // no '>' left, so no later '<' can close either
    if (gt === lt + 1) { scan = lt + 1; continue } // "<>": no body, not a tag
    out += text.slice(copied, lt) + ' '
    copied = scan = gt + 1
  }
  return out + text.slice(copied)
}

/** The text between each `open` and the first `close` after it, left to right, as plain
 *  string searches (case-sensitive). Same result as exec-ing /open([\s\S]*?)close/g, at most
 *  `limit` blocks; an `open` with no `close` after it ends the scan. */
export function literalBlocks(text: string, open: string, close: string, limit = Infinity): string[] {
  const out: string[] = []
  let pos = 0
  while (out.length < limit) {
    const o = text.indexOf(open, pos)
    if (o === -1) break
    const bodyStart = o + open.length
    const c = text.indexOf(close, bodyStart)
    if (c === -1) break // none after the first opener means none after any later one
    out.push(text.slice(bodyStart, c))
    pos = c + close.length
  }
  return out
}
