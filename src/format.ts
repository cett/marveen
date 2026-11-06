const MAX_MESSAGE_LENGTH = 4096

// [A-Za-z0-9_], the class `\w` of the pattern this replaces (no `u` flag, so ASCII only).
function isWordCode(c: number): boolean {
  return (c >= 48 && c <= 57) || (c >= 65 && c <= 90) || (c >= 97 && c <= 122) || c === 95
}

// Replaces every fenced block, as the pattern /```(\w*)\n?([\s\S]*?)```/g did: the language is the word right after the
// opening fence, one newline after it is dropped, the body runs to the NEXT fence. The pattern was quadratic on an
// opening fence with no closing one (it re-scanned the rest of the text for each shorter language it backtracked to).
// The language and the newline hold no backtick, so the first closing fence after the opening one is the same for
// every way the pattern could split them, and when there is none no later opening fence has one either: the scan
// stops there and the rest stays text, exactly as the pattern left it.
function takeCodeBlocks(text: string, codeBlocks: string[]): string {
  let out = ''
  let last = 0
  let from = 0
  for (;;) {
    const open = text.indexOf('```', from)
    if (open === -1) break
    let langEnd = open + 3
    while (langEnd < text.length && isWordCode(text.charCodeAt(langEnd))) langEnd++
    const bodyStart = text.charCodeAt(langEnd) === 10 ? langEnd + 1 : langEnd
    const close = text.indexOf('```', bodyStart)
    if (close === -1) break
    const lang = text.slice(open + 3, langEnd)
    const escaped = escapeHtml(text.slice(bodyStart, close).trimEnd())
    out += text.slice(last, open) + `\x00CB${codeBlocks.length}\x00`
    codeBlocks.push(lang ? `<pre><code class="language-${lang}">${escaped}</code></pre>` : `<pre>${escaped}</pre>`)
    last = close + 3
    from = last
  }
  return out + text.slice(last)
}

// Replaces every [text](url), as /\[(.+?)\]\((.+?)\)/g did, on each line (`.` does not cross a line terminator, so
// neither does a link). The pattern was quadratic, and cubic with `](` and no `)`, on a line full of `[`: every `[`
// searched the rest of the line again. For the `[` at i the link is the FIRST `](` at i+2 or later (the text is at least
// one character) and the first `)` at p+3 or later (so is the url); when the first `](` has no `)` after it, no later one
// has. Both answers can only move right as the scan moves right, so they are remembered and each line is read once.
function linkifyLine(line: string): string {
  let out = ''
  let last = 0
  let pairFrom = -1
  let pairAt = -1
  let closeFrom = -1
  let closeAt = -1
  let i = line.indexOf('[')
  while (i !== -1) {
    const pFrom = i + 2
    if (!(pairFrom !== -1 && pairFrom <= pFrom && (pairAt === -1 || pairAt >= pFrom))) {
      pairFrom = pFrom
      pairAt = line.indexOf('](', pFrom)
    }
    if (pairAt === -1) break
    const qFrom = pairAt + 3
    if (!(closeFrom !== -1 && closeFrom <= qFrom && (closeAt === -1 || closeAt >= qFrom))) {
      closeFrom = qFrom
      closeAt = line.indexOf(')', qFrom)
    }
    if (closeAt === -1) break
    out += `${line.slice(last, i)}<a href="${line.slice(pairAt + 2, closeAt)}">${line.slice(i + 1, pairAt)}</a>`
    last = closeAt + 1
    i = line.indexOf('[', last)
  }
  return out + line.slice(last)
}

// The four line terminators a `.` does not match: LF, CR, U+2028, U+2029 (built from code points: a literal U+2028 in the
// source would itself end a line).
const LINE_TERMINATORS = new RegExp(`([${String.fromCharCode(10, 13, 0x2028, 0x2029)}])`)

function linkify(text: string): string {
  // The odd entries are the line terminators the split keeps.
  return text.split(LINE_TERMINATORS).map((part, k) => (k % 2 === 0 ? linkifyLine(part) : part)).join('')
}

export function formatForTelegram(text: string): string {
  // Kódblokkok kimentése placeholderekbe
  const codeBlocks: string[] = []
  let result = takeCodeBlocks(text, codeBlocks)

  // Inline kód kimentése
  const inlineCodes: string[] = []
  result = result.replace(/`([^`]+)`/g, (_match, code) => {
    const idx = inlineCodes.length
    inlineCodes.push(`<code>${escapeHtml(code)}</code>`)
    return `\x00IC${idx}\x00`
  })

  // HTML escape a szöveges részeknél
  result = escapeHtml(result)

  // Markdown konverziók
  result = result.replace(/^#{1,6}\s+(.+)$/gm, '<b>$1</b>')
  result = result.replace(/\*\*(.+?)\*\*/g, '<b>$1</b>')
  result = result.replace(/__(.+?)__/g, '<b>$1</b>')
  result = result.replace(/(?<!\*)\*(?!\*)(.+?)(?<!\*)\*(?!\*)/g, '<i>$1</i>')
  result = result.replace(/(?<!_)_(?!_)(.+?)(?<!_)_(?!_)/g, '<i>$1</i>')
  result = result.replace(/~~(.+?)~~/g, '<s>$1</s>')
  result = linkify(result)
  result = result.replace(/^- \[ \]/gm, '☐')
  result = result.replace(/^- \[x\]/gm, '☑')

  // Elválasztók és nyers HTML eltávolítása
  result = result.replace(/^---+$/gm, '')
  result = result.replace(/^\*\*\*+$/gm, '')

  // Kódblokkok és inline kódok visszaállítása
  result = result.replace(/\x00CB(\d+)\x00/g, (_m, idx) => codeBlocks[parseInt(idx)])
  result = result.replace(/\x00IC(\d+)\x00/g, (_m, idx) => inlineCodes[parseInt(idx)])

  return result.trim()
}

export function escapeHtml(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}

export function splitMessage(text: string, limit = MAX_MESSAGE_LENGTH): string[] {
  if (text.length <= limit) return [text]

  const chunks: string[] = []
  let remaining = text

  while (remaining.length > 0) {
    if (remaining.length <= limit) {
      chunks.push(remaining)
      break
    }

    let splitAt = remaining.lastIndexOf('\n', limit)
    if (splitAt === -1 || splitAt < limit * 0.3) {
      splitAt = remaining.lastIndexOf(' ', limit)
    }
    if (splitAt === -1 || splitAt < limit * 0.3) {
      splitAt = limit
    }

    chunks.push(remaining.slice(0, splitAt))
    remaining = remaining.slice(splitAt).trimStart()
  }

  return chunks
}
