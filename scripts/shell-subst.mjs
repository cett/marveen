// shell-subst.mjs -- the command-substitution bodies of a shell command line.
//
// Twin of scripts/hooks/shell_subst.py (same rules, same results: the shared case list
// scripts/hooks/shell-subst-cases.json is run against both). Read that file's header for the
// why; short form: a gate that matches on the text BEFORE the shell expands it does not see
// what a command substitution runs (`echo "$(rm -rf x)"`), so it needs the bodies, judged as
// commands of their own.
//
// Where the shell expands: unquoted text and double quotes (`$( )`, backticks, `<( )`/`>( )`
// in command position, an unquoted heredoc body). Where it does not: single quotes, $'...',
// a heredoc with a quoted or backslashed delimiter, a comment, a backslash-escaped marker.
//
// LINEAR: one pass, an explicit stack, no regex backtracking. topBodies() returns only the
// OUTERMOST bodies; the caller recurses on each (so it can count depth and fail closed).
// Unbalanced input never throws: an unterminated substitution takes the rest of the text.
//
// KNOWN, ACCEPTED LIMIT: the closing `)` of a `case` pattern inside `$( )` ends that body
// early (`$(case x in a) rm y;; esac)`). A determined construction, not an accident.

// Delimiter word after `<<` / `<<-`; the alternatives start with disjoint characters.
const HEREDOC_WORD = /(-?)[ \t]*((?:[^\s;&|<>()'"\\]|\\[\s\S]|'[^']*'|"[^"]*")+)/y
const BT_UNESCAPE = /\\([\\$`])/g
const COMMENT_AFTER = ' \t\n;&|('

function delimOf(word) {
  const quoted = word.includes("'") || word.includes('"') || word.includes('\\')
  const plain = word.replace(/\\([\s\S])|['"]/g, (_m, g) => g ?? '')
  return { delim: plain, quoted }
}

// Bodies of the heredocs waiting for the newline just before `start`.
// Returns { bodies (expanding ones), pos (just after the last closing line) }.
function heredocBodies(text, start, pending) {
  const n = text.length
  const out = []
  let pos = start
  for (const { delim, quoted, strip } of pending) {
    const bodyStart = pos
    let bodyEnd
    for (;;) {
      if (pos >= n) { bodyEnd = n; pos = n; break }
      const e = text.indexOf('\n', pos)
      const lineEnd = e < 0 ? n : e
      let line = text.slice(pos, lineEnd)
      if (strip) line = line.replace(/^\t+/, '')
      if (line === delim) { bodyEnd = pos; pos = lineEnd + 1; break }
      pos = lineEnd + 1
    }
    if (!quoted) out.push(text.slice(bodyStart, bodyEnd))
  }
  return { bodies: out, pos }
}

// The outermost substitution bodies of `text`, in order of appearance. `limit`: stop reading once MORE than that many
// were found (the caller denies past its own limit, so the rest of a hostile text is not worth reading). heredocBody=true reads
// `text` as an unquoted heredoc body: only `$( )`, backticks and backslashes mean anything.
export function topBodies(text, heredocBody = false, limit = Infinity) {
  const n = text.length
  const out = []
  const stack = [] // frames: { kind, bodyStart, parens, record }
  let cmdFrames = 0 // frames that are command context (everything but a double quote)
  let pending = [] // heredocs opened on the current line
  const base = heredocBody ? 'hd' : 'cmd'
  let full = false
  let i = 0

  const push = (kind, bodyStart) => {
    stack.push({ kind, bodyStart, parens: 1, record: cmdFrames === 0 })
    if (kind !== 'dq') cmdFrames++
  }
  const close = (end) => {
    const f = stack.pop()
    if (f.kind === 'dq') return
    cmdFrames--
    if (f.record) {
      const body = text.slice(f.bodyStart, end)
      out.push(f.kind === 'bt' ? body.replace(BT_UNESCAPE, '$1') : body)
      if (out.length > limit) full = true
    }
  }

  while (i < n && !full) {
    const c = text[i]
    const kind = stack.length ? stack[stack.length - 1].kind : base

    if (kind === 'bt') {
      // Closes at the first unescaped backtick, whatever quotes are inside.
      if (c === '\\') i += 2
      else if (c === '`') { close(i); i++ }
      else i++
      continue
    }

    if (kind === 'dq' || kind === 'hd') {
      if (c === '\\') i += 2
      else if (c === '"' && kind === 'dq') { stack.pop(); i++ }
      else if (c === '$' && text[i + 1] === '(') { push('sub', i + 2); i += 2 }
      else if (c === '`') { push('bt', i + 1); i++ }
      else i++
      continue
    }

    // command context: top level, $( ), <( ), >( )
    if (c === '\\') {
      i += 2
    } else if (c === "'") {
      const j = text.indexOf("'", i + 1)
      i = j < 0 ? n : j + 1
    } else if (c === '"') {
      push('dq', i + 1)
      i++
    } else if (c === '$') {
      const nxt = text[i + 1]
      if (nxt === '(') { push('sub', i + 2); i += 2 }
      else if (nxt === "'") {
        let j = i + 2
        while (j < n && text[j] !== "'") j += text[j] === '\\' ? 2 : 1
        i = j + 1
      } else i++
    } else if (c === '`') {
      push('bt', i + 1)
      i++
    } else if ((c === '<' || c === '>') && text[i + 1] === '(') {
      push('proc', i + 2)
      i += 2
    } else if (c === '#' && (i === 0 || COMMENT_AFTER.includes(text[i - 1]))) {
      const j = text.indexOf('\n', i)
      i = j < 0 ? n : j
    } else if (c === '(' && stack.length) {
      stack[stack.length - 1].parens++
      i++
    } else if (c === ')' && stack.length) {
      const top = stack[stack.length - 1]
      top.parens--
      if (top.parens === 0) close(i)
      i++
    } else if (c === '<' && text.startsWith('<<<', i)) {
      i += 3 // a here-string, not a heredoc: its word is read as ordinary text
    } else if (c === '<' && !stack.length && base === 'cmd' && text.startsWith('<<', i)) {
      HEREDOC_WORD.lastIndex = i + 2
      const m = HEREDOC_WORD.exec(text)
      if (m) {
        const { delim, quoted } = delimOf(m[2])
        pending.push({ delim, quoted, strip: m[1] === '-' })
        i = HEREDOC_WORD.lastIndex
      } else i += 2
    } else if (c === '\n' && pending.length && !stack.length) {
      const r = heredocBodies(text, i + 1, pending)
      pending = []
      i = r.pos
      // The expanding heredoc body is text, not a command: only the substitutions in it run.
      for (const b of r.bodies) for (const x of topBodies(b, true, limit)) out.push(x)
      if (out.length > limit) full = true
    } else {
      i++
    }
  }

  while (stack.length && !full) close(n) // an unterminated substitution takes the rest of the text
  return out
}
