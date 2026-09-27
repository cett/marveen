// Help viewer (#help or #help/<doc-path>): with a doc path it fetches a
// user-guide/fork-guide chapter's raw markdown from GET /api/docs/<doc-path>
// and renders it with the shared renderMarkdown() -- the same renderer the
// Skills/Artifacts/Memories panels use. Without one (bare '#help', reached
// from the sidebar's Súgó nav link) it renders an index of every chapter in
// both guides, language-aware, each linking to its own #help/<doc-path>.
// Per-view "? Súgó" links (renderHelpLinks() in app-core.js) open a specific
// chapter directly in a new tab; the doc path itself is resolved by
// app-core.js's routeFromHash() and read here via getHelpDocPath().
import { renderMarkdown } from './docs-research.js'
import { t, getLang, onLangChange } from './i18n.js'
import { getHelpDocPath } from './app-core.js'
import { escapeHtml, escapeAttr } from './util.js'

// Slugs mirror the actual docs/user-guide and docs/fork-guide filenames
// (hu/en trees, path-traversal-allowlisted server-side by DOC_PATH_PATTERN
// in src/web/routes/docs.ts). Titles are separate i18n keys (help.chapter.*)
// rather than reusing the sidebar's nav.* labels, since two user-guide
// chapters (knowledge/09, connections/16) each cover several distinct nav
// pages and have no single matching nav label.
const USER_GUIDE_CHAPTERS = [
  { key: 'introduction', hu: '00-bevezeto', en: '00-introduction' },
  { key: 'overview', hu: '01-attekintes', en: '01-overview' },
  { key: 'kanban', hu: '02-kanban', en: '02-kanban' },
  { key: 'approvals', hu: '03-jovahagyasok', en: '03-approvals' },
  { key: 'agents', hu: '04-agensek', en: '04-agents' },
  { key: 'messages', hu: '05-uzenetek', en: '05-messages' },
  { key: 'tasks', hu: '06-feladatok', en: '06-tasks' },
  { key: 'memories', hu: '07-memoria', en: '07-memories' },
  { key: 'skills', hu: '08-keszsegek', en: '08-skills' },
  { key: 'knowledge', hu: '09-tudastar', en: '09-knowledge' },
  { key: 'statistics', hu: '10-statisztikak', en: '10-statistics' },
  { key: 'settings', hu: '11-beallitasok', en: '11-settings' },
  { key: 'vault', hu: '12-vault', en: '12-vault' },
  { key: 'audit', hu: '13-audit', en: '13-audit' },
  { key: 'backups', hu: '14-adatmentes', en: '14-backups' },
  { key: 'users', hu: '15-felhasznalok', en: '15-users' },
  { key: 'connections', hu: '16-kapcsolatok', en: '16-connections' },
  { key: 'updates', hu: '17-frissitesek', en: '17-updates' },
  { key: 'profile', hu: '18-profil', en: '18-profile' },
]

const FORK_GUIDE_CHAPTERS = [
  { key: 'prerequisites', hu: 'F00-elofeltetelek', en: 'F00-prerequisites' },
  { key: 'installation', hu: 'F01-telepites', en: 'F01-installation' },
  { key: 'configuration', hu: 'F02-konfiguracio', en: 'F02-configuration' },
  { key: 'operations', hu: 'F03-uzemeltetes', en: 'F03-operations' },
  { key: 'architecture', hu: 'F04-architektura', en: 'F04-architecture' },
  { key: 'channels', hu: 'F05-csatornak', en: 'F05-channels' },
  { key: 'mcp', hu: 'F06-mcp', en: 'F06-mcp' },
  { key: 'fleet', hu: 'F07-fleet', en: 'F07-fleet' },
]

function chaptersForTree(tree) {
  return tree === 'fork-guide' ? FORK_GUIDE_CHAPTERS : USER_GUIDE_CHAPTERS
}

// docPath is always '<tree>/<lang>/<slug>.md' (see DOC_PATH_PATTERN in
// src/web/routes/docs.ts) -- split it into its three parts, or null if it
// doesn't match (e.g. a stale/hand-typed hash).
function parseDocPath(docPath) {
  const m = /^(user-guide|fork-guide)\/(hu|en)\/([^/]+)\.md$/.exec(docPath || '')
  return m ? { tree: m[1], lang: m[2], slug: m[3] } : null
}

function chapterIndexForSlug(chapters, slug) {
  return chapters.findIndex(c => c.hu === slug || c.en === slug)
}

// Re-express a doc path in another language, keeping the same chapter (the
// hu/en filenames differ per chapter, see USER_GUIDE_CHAPTERS/FORK_GUIDE_CHAPTERS
// above). Returns null if the path doesn't parse or the chapter is unknown.
function mapDocPathToLang(docPath, lang) {
  const parsed = parseDocPath(docPath)
  if (!parsed) return null
  const chapters = chaptersForTree(parsed.tree)
  const idx = chapterIndexForSlug(chapters, parsed.slug)
  if (idx === -1) return null
  const slug = chapters[idx][lang] || chapters[idx].en
  return `${parsed.tree}/${lang}/${slug}.md`
}

// Chapter footer: prev | table-of-contents | next, each a plain #help/...
// hash anchor -- native hash navigation (routeFromHash in app-core.js) handles
// the rest, same as the index links.
function renderChapterNavHtml(docPath) {
  const parsed = parseDocPath(docPath)
  if (!parsed) return ''
  const chapters = chaptersForTree(parsed.tree)
  const idx = chapterIndexForSlug(chapters, parsed.slug)
  if (idx === -1) return ''

  const hrefFor = (chapter) => {
    const slug = chapter[parsed.lang] || chapter.en
    return `#help/${parsed.tree}/${parsed.lang}/${slug}.md`
  }
  const prev = idx > 0 ? chapters[idx - 1] : null
  const next = idx < chapters.length - 1 ? chapters[idx + 1] : null

  const prevHtml = prev
    ? `<a class="help-nav-prev" href="${escapeAttr(hrefFor(prev))}">&laquo; ${escapeHtml(t('help.nav.prev'))}: ${escapeHtml(t('help.chapter.' + prev.key))}</a>`
    : '<span class="help-nav-prev"></span>'
  const nextHtml = next
    ? `<a class="help-nav-next" href="${escapeAttr(hrefFor(next))}">${escapeHtml(t('help.nav.next'))}: ${escapeHtml(t('help.chapter.' + next.key))} &raquo;</a>`
    : '<span class="help-nav-next"></span>'
  const tocHtml = `<a class="help-nav-toc" href="#help">${escapeHtml(t('help.nav.toc'))}</a>`

  return `<nav class="help-chapter-nav">${prevHtml}${tocHtml}${nextHtml}</nav>`
}

// Chapter content links another chapter with a plain relative filename (e.g.
// "17-frissitesek.md", see docs/user-guide/hu/13-audit.md) -- renderMarkdown()
// has no notion of the doc tree so it emits that as a dead relative href with
// target="_blank" (its default for every link, shared with Skills/Artifacts/
// Memories). Rewrite same-tree/lang relative .md links into #help/<doc-path>
// hash anchors and drop target/rel so they navigate in-page like the nav
// footer and index links, instead of 404-ing in a new tab.
function rewriteRelativeDocLinks(container, docPath) {
  const dir = docPath.replace(/[^/]*$/, '')
  container.querySelectorAll('a[href]').forEach(a => {
    const href = a.getAttribute('href')
    if (!href || href.startsWith('#') || href.startsWith('/') || /^[a-z][a-z0-9+.-]*:/i.test(href)) return
    let resolved
    try {
      resolved = new URL(href, 'https://help.invalid/' + dir).pathname.replace(/^\//, '')
    } catch {
      return
    }
    if (!/\.md$/i.test(resolved)) return
    a.setAttribute('href', '#help/' + resolved)
    a.removeAttribute('target')
    a.removeAttribute('rel')
  })
}

function renderChapterListHtml(chapters, tree, lang) {
  return chapters.map(c => {
    const slug = c[lang] || c.en
    const href = `#help/${tree}/${lang}/${slug}.md`
    return `<li><a href="${escapeHtml(href)}">${escapeHtml(t('help.chapter.' + c.key))}</a></li>`
  }).join('')
}

function renderIndexHtml() {
  const lang = getLang()
  return (
    `<h2>${escapeHtml(t('help.index.user_guide_heading'))}</h2>` +
    `<ul>${renderChapterListHtml(USER_GUIDE_CHAPTERS, 'user-guide', lang)}</ul>` +
    `<h2>${escapeHtml(t('help.index.fork_guide_heading'))}</h2>` +
    `<ul>${renderChapterListHtml(FORK_GUIDE_CHAPTERS, 'fork-guide', lang)}</ul>`
  )
}

export function initHelp() {
  // app-core.js's own onLangChange callback (registered in boot(), so it
  // always fires first) re-enters the current page on language change, which
  // reloads #help with the *same* docPath string -- fine for the bare index
  // (renderIndexHtml() reads getLang() itself) but wrong for a chapter, whose
  // language lives in the doc path (e.g. 'user-guide/hu/13-audit.md'). Remap
  // it to the new language's slug and re-route; the resulting hashchange
  // re-enters #help a second time with the corrected doc path.
  onLangChange(() => {
    const docPath = getHelpDocPath()
    if (!docPath) return
    const mapped = mapDocPathToLang(docPath, getLang())
    if (mapped && mapped !== docPath) location.hash = 'help/' + mapped
  })
}

export async function loadHelpPage() {
  const contentEl = document.getElementById('helpContent')
  if (!contentEl) return

  const docPath = getHelpDocPath()
  if (!docPath) {
    contentEl.className = 'markdown-body md-rendered'
    contentEl.innerHTML = renderIndexHtml()
    return
  }

  contentEl.className = 'empty-state'
  contentEl.textContent = t('help.loading')
  try {
    const res = await fetch('/api/docs/' + docPath)
    if (!res.ok) {
      contentEl.textContent = res.status === 404 ? t('help.not_found') : t('help.load_error')
      return
    }
    const data = await res.json()
    contentEl.className = 'markdown-body md-rendered'
    contentEl.innerHTML = renderMarkdown(data.content) + renderChapterNavHtml(docPath)
    rewriteRelativeDocLinks(contentEl, docPath)
  } catch {
    contentEl.className = 'empty-state'
    contentEl.textContent = t('help.load_error')
  }
}
