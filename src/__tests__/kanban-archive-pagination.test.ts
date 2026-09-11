// Contract guard: kanban archive client-side pagination (#862, #859 ST3).
//
// web/app.js has no jsdom/happy-dom execution harness in this repo, so this
// guards the structure statically -- same approach as lazy-load-modules.test.ts.
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const APP_JS = readFileSync(join(__dirname, '../../web/app.js'), 'utf-8')
const INDEX_HTML = readFileSync(join(__dirname, '../../web/index.html'), 'utf-8')

describe('kanban archive pagination: structure', () => {
  it('app.js imports the shared paginator component', () => {
    expect(APP_JS).toMatch(/import\s*\{\s*renderPaginator\s*\}\s*from\s*'\.\/modules\/paginator\.js'/)
  })

  it('index.html has the archived-page paginator container', () => {
    expect(INDEX_HTML).toContain('id="archivedPagination"')
  })

  it('app.js wires renderPaginator into the archived pagination container', () => {
    expect(APP_JS).toContain("renderPaginator(document.getElementById('archivedPagination')")
  })

  it('pagination is client-side: the archived-cards fetch carries no offset param', () => {
    // GET /api/kanban/archived stays a single, unpaginated fetch per search --
    // the page slicing happens entirely in the browser (archivedCards.slice()).
    const fetchCall = APP_JS.match(/fetch\('\/api\/kanban\/archived\?' \+ params\.toString\(\)\)/)
    expect(fetchCall).not.toBeNull()
    expect(APP_JS).not.toMatch(/params\.set\('offset'/)
  })

  it('archivedCards is sliced client-side for rendering', () => {
    expect(APP_JS).toContain('archivedCards.slice(archivedOffset, archivedOffset + ARCHIVED_PAGE_LIMIT)')
  })

  it('a new search resets the page back to offset 0', () => {
    const searchFn = APP_JS.slice(APP_JS.indexOf('async function doArchivedSearch'))
    expect(searchFn).toContain('archivedOffset = 0')
  })

  it('Prev/Next callbacks re-render client-side without refetching', () => {
    const renderFn = APP_JS.slice(
      APP_JS.indexOf('function renderArchivedPage'),
      APP_JS.indexOf('async function doArchivedSearch'),
    )
    expect(renderFn).toContain('onPrev: () => { archivedOffset = Math.max(0, archivedOffset - ARCHIVED_PAGE_LIMIT); renderArchivedPage() }')
    expect(renderFn).toContain('onNext: () => { archivedOffset += ARCHIVED_PAGE_LIMIT; renderArchivedPage() }')
  })
})
