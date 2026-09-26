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
import { t, getLang } from './i18n.js'
import { getHelpDocPath } from './app-core.js'
import { escapeHtml } from './util.js'

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
  // No one-time wiring needed yet -- the index/chapter links are plain
  // <a href="#..."> anchors, native hash navigation handles the rest.
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
    contentEl.innerHTML = renderMarkdown(data.content)
  } catch {
    contentEl.className = 'empty-state'
    contentEl.textContent = t('help.load_error')
  }
}
