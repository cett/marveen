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
export function stripMarkup(raw: string): string {
  return decodeEntities(
    raw
      .replace(/<script[\s\S]*?<\/script>/gi, '')
      .replace(/<style[\s\S]*?<\/style>/gi, '')
      .replace(/<[^>]+>/g, ' '),
  )
    .replace(/\s+/g, ' ')
    .trim()
}
