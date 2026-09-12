import { escapeHtml, escapeAttr } from './util.js'

// Minimal, dependency-free Markdown -> HTML renderer. Inputs are usually
// trusted (skill/artifact/workspace-doc content this fleet wrote itself), but
// we HTML-escape everything anyway and only emit a fixed set of tags. Covers
// the constructs our docs use: fenced code, headings, hr, tables,
// ordered/unordered lists, blockquotes, paragraphs, and inline code/bold/italic/links.
function mdInline(text) {
  let s = escapeHtml(text)
  s = s.replace(/`([^`]+)`/g, (m, c) => '<code>' + c + '</code>')
  s = s.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
  s = s.replace(/\*([^*]+)\*/g, '<em>$1</em>')
  s = s.replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, (m, txt, url) => {
    // Reject javascript:/data:/vbscript: schemes -- artifacts may come from untrusted sources
    // and renderMarkdown output is set via innerHTML (not sandboxed). Case-insensitive, trim first.
    const safeUrl = /^(?:javascript|data|vbscript):/i.test(url.trim()) ? '#' : url
    return '<a href="' + escapeAttr(safeUrl) + '" target="_blank" rel="noopener noreferrer">' + txt + '</a>'
  })
  return s
}

function renderMarkdown(md) {
  const lines = String(md).replace(/\r\n/g, '\n').split('\n')
  const out = []
  let i = 0
  const isBlockStart = (l) =>
    /^```/.test(l) || /^(#{1,6})\s/.test(l) || /^\s*[-*]\s+/.test(l) ||
    /^\s*\d+\.\s+/.test(l) || /^\s*\|.*\|\s*$/.test(l) || /^\s*>\s?/.test(l) ||
    /^\s*([-*_])\1{2,}\s*$/.test(l) || /^\s*$/.test(l)
  while (i < lines.length) {
    const line = lines[i]
    const fence = line.match(/^```(\w*)\s*$/)
    if (fence) {
      const code = []
      i++
      while (i < lines.length && !/^```\s*$/.test(lines[i])) { code.push(lines[i]); i++ }
      i++
      out.push('<pre><code' + (fence[1] ? ' class="language-' + escapeHtml(fence[1]) + '"' : '') + '>' + escapeHtml(code.join('\n')) + '</code></pre>')
      continue
    }
    const h = line.match(/^(#{1,6})\s+(.*)$/)
    if (h) { const lvl = h[1].length; out.push('<h' + lvl + '>' + mdInline(h[2].trim()) + '</h' + lvl + '>'); i++; continue }
    if (/^\s*([-*_])\1{2,}\s*$/.test(line)) { out.push('<hr>'); i++; continue }
    if (/^\s*\|.*\|\s*$/.test(line) && i + 1 < lines.length &&
        /^\s*\|?[\s:|-]+\|?\s*$/.test(lines[i + 1]) && lines[i + 1].includes('-')) {
      const parseRow = (r) => r.trim().replace(/^\|/, '').replace(/\|$/, '').split('|').map(c => c.trim())
      const headers = parseRow(line)
      i += 2
      const rows = []
      while (i < lines.length && /^\s*\|.*\|\s*$/.test(lines[i])) { rows.push(parseRow(lines[i])); i++ }
      let tbl = '<div class="table-wrap"><table class="table" data-variant="compact"><thead><tr>' + headers.map(c => '<th>' + mdInline(c) + '</th>').join('') + '</tr></thead><tbody>'
      for (const r of rows) tbl += '<tr>' + r.map(c => '<td>' + mdInline(c) + '</td>').join('') + '</tr>'
      tbl += '</tbody></table></div>'
      out.push(tbl)
      continue
    }
    if (/^\s*[-*]\s+/.test(line)) {
      const items = []
      while (i < lines.length && /^\s*[-*]\s+/.test(lines[i])) { items.push(lines[i].replace(/^\s*[-*]\s+/, '')); i++ }
      out.push('<ul>' + items.map(it => '<li>' + mdInline(it) + '</li>').join('') + '</ul>')
      continue
    }
    if (/^\s*\d+\.\s+/.test(line)) {
      const items = []
      while (i < lines.length && /^\s*\d+\.\s+/.test(lines[i])) { items.push(lines[i].replace(/^\s*\d+\.\s+/, '')); i++ }
      out.push('<ol>' + items.map(it => '<li>' + mdInline(it) + '</li>').join('') + '</ol>')
      continue
    }
    if (/^\s*>\s?/.test(line)) {
      const q = []
      while (i < lines.length && /^\s*>\s?/.test(lines[i])) { q.push(lines[i].replace(/^\s*>\s?/, '')); i++ }
      out.push('<blockquote>' + q.map(mdInline).join('<br>') + '</blockquote>')
      continue
    }
    if (/^\s*$/.test(line)) { i++; continue }
    const para = []
    while (i < lines.length && !isBlockStart(lines[i])) { para.push(lines[i]); i++ }
    if (para.length) out.push('<p>' + para.map(mdInline).join('<br>') + '</p>')
  }
  return out.join('\n')
}

// Shared with the Skills modal (skills.js), the Artifacts/Workspace-docs
// preview panels, and the Memories module, so all of them render markdown
// identically. Exported as a separate statement to keep the `function
// renderMarkdown` definition line intact (guarded by md-rendering-unify.test.ts).
// The docs/ folder viewer this module originally also backed (loadDocs/openDoc,
// reading from `/api/docs`) was removed -- project docs are read from the
// IDE/GitHub now -- leaving this file as the shared markdown renderer only.
export { renderMarkdown }

