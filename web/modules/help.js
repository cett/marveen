// Help viewer (#help/<doc-path>): fetches a docs/user-guide chapter's raw
// markdown from GET /api/docs/<doc-path> and renders it with the shared
// renderMarkdown() -- the same renderer the Skills/Artifacts/Memories panels
// use. Opened in a new tab from renderHelpLinks() (app-core.js); the doc path
// is resolved by app-core.js's routeFromHash() and read here via getHelpDocPath().
import { renderMarkdown } from './docs-research.js'
import { t } from './i18n.js'
import { getHelpDocPath } from './app-core.js'

export function initHelp() {
  // No one-time wiring needed yet -- the page has no interactive controls
  // beyond the rendered content itself.
}

export async function loadHelpPage() {
  const contentEl = document.getElementById('helpContent')
  if (!contentEl) return

  const docPath = getHelpDocPath()
  if (!docPath) {
    contentEl.className = 'empty-state'
    contentEl.textContent = t('help.not_found')
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
