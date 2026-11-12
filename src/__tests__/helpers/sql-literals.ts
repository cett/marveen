// Pulls the SQL statement texts out of TypeScript source, for the translator fuzz cell. It is a small scanner for string
// literals, not a parser: comments are skipped, a regex literal is skipped (a quote inside one is not a string), a template
// literal is read with its `${...}` parts replaced by the identifier `x`. A literal counts as SQL when it starts with a
// statement keyword. Good enough to read src/db/, and the cell asserts a floor on how many it found, so a scanner that
// loses its way cannot pass by finding nothing.

const KEYWORD = /^\s*(?:SELECT|INSERT|UPDATE|DELETE|WITH|REPLACE)\b/i
// after one of these a `/` starts a regex literal; after an identifier, a number or `)` / `]` it is a division
const REGEX_AFTER = /[(,=:[!&|?{};+\-*%<>~^]$|\breturn$|^$/

export interface SqlLiteral {
  text: string
  line: number
}

export function extractSqlLiterals(source: string): SqlLiteral[] {
  const found: SqlLiteral[] = []
  scan(source, 0, found, false)
  return found.filter((l) => KEYWORD.test(l.text))
}

const lineAt = (source: string, index: number): number => {
  let n = 1
  for (let i = 0; i < index; i++) if (source[i] === '\n') n++
  return n
}

// Scans from `start`; when `inTemplateExpr`, stops at the `}` that closes the `${` and returns the index after it.
function scan(source: string, start: number, out: SqlLiteral[], inTemplateExpr: boolean): number {
  let i = start
  let depth = 0
  let before = '' // the code seen so far on this level, to decide what a `/` is
  while (i < source.length) {
    const c = source[i]!
    if (c === '/' && source[i + 1] === '/') {
      while (i < source.length && source[i] !== '\n') i++
    } else if (c === '/' && source[i + 1] === '*') {
      const end = source.indexOf('*/', i + 2)
      i = end === -1 ? source.length : end + 2
    } else if (c === '/' && REGEX_AFTER.test(before.trimEnd())) {
      i++
      let inClass = false
      while (i < source.length && (source[i] !== '/' || inClass) && source[i] !== '\n') {
        if (source[i] === '\\') i++
        else if (source[i] === '[') inClass = true
        else if (source[i] === ']') inClass = false
        i++
      }
      i++
      while (/[a-z]/.test(source[i] ?? '')) i++
      before += 'r'
    } else if (c === "'" || c === '"') {
      const begin = i
      i++
      let text = ''
      while (i < source.length && source[i] !== c && source[i] !== '\n') {
        if (source[i] === '\\') {
          text += source[i + 1] ?? ''
          i += 2
        } else {
          text += source[i]
          i++
        }
      }
      i++
      out.push({ text, line: lineAt(source, begin) })
      before += 's'
    } else if (c === '`') {
      const begin = i
      i++
      let text = ''
      while (i < source.length && source[i] !== '`') {
        if (source[i] === '\\') {
          text += source[i + 1] ?? ''
          i += 2
        } else if (source[i] === '$' && source[i + 1] === '{') {
          i = scan(source, i + 2, out, true)
          text += 'x'
        } else {
          text += source[i]
          i++
        }
      }
      i++
      out.push({ text, line: lineAt(source, begin) })
      before += 's'
    } else if (inTemplateExpr && c === '{') {
      depth++
      i++
      before += c
    } else if (inTemplateExpr && c === '}') {
      if (depth === 0) return i + 1
      depth--
      i++
      before += c
    } else {
      before += c
      if (before.length > 64) before = before.slice(-64)
      i++
    }
  }
  return i
}
