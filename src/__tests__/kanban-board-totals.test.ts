// The kanban board totals and column counts (pure functions), and the CSS
// contract of the whole-card priority tone.
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { kanbanColumnCount, kanbanBoardTotals } from '../../web/modules/kanban-totals.js'
import { readAllCss } from './css-helper.js'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..')

describe('kanbanColumnCount', () => {
  it('counts the rendered cards when the board is not paged', () => {
    expect(kanbanColumnCount(7, undefined, false)).toBe(7)
    expect(kanbanColumnCount(7, { offset: 7, total: 40 }, false)).toBe(7)
  })

  it('adds the cards the server still holds when the board is paged (25 in the column, 20 loaded)', () => {
    expect(kanbanColumnCount(20, { offset: 20, total: 25 }, true)).toBe(25)
  })

  it('is exact once everything is loaded, and never goes below the rendered count', () => {
    expect(kanbanColumnCount(25, { offset: 25, total: 25 }, true)).toBe(25)
    expect(kanbanColumnCount(3, { offset: 5, total: 4 }, true)).toBe(3)
    expect(kanbanColumnCount(0, undefined, true)).toBe(0)
  })
})

describe('kanbanBoardTotals', () => {
  const paging = {
    planned: { offset: 20, total: 25 },
    in_progress: { offset: 3, total: 3 },
    done: { offset: 20, total: 60 },
  }

  it('paged mode: open and all come from the server totals, not the loaded page', () => {
    const t = kanbanBoardTotals({ cards: new Array(43).fill({ status: 'planned' }), pagedMode: true, paging, filtered: false, visibleCount: 43 })
    expect(t).toEqual({ open: 28, all: 88, shown: null })
  })

  it('full mode: counts the loaded cards, done ones are not open', () => {
    const cards = [{ status: 'planned' }, { status: 'waiting' }, { status: 'done' }, { status: 'done' }]
    expect(kanbanBoardTotals({ cards, pagedMode: false, paging: {}, filtered: false, visibleCount: 4 }))
      .toEqual({ open: 2, all: 4, shown: null })
  })

  it('reports how many are shown only while a filter is active', () => {
    const cards = [{ status: 'planned' }, { status: 'done' }, { status: 'planned' }]
    expect(kanbanBoardTotals({ cards, pagedMode: false, paging: {}, filtered: true, visibleCount: 1 }).shown).toBe(1)
    expect(kanbanBoardTotals({ cards, pagedMode: false, paging: {}, filtered: true, visibleCount: 0 }).shown).toBe(0)
  })

  it('an empty board reads 0 / 0', () => {
    expect(kanbanBoardTotals({ cards: [], pagedMode: true, paging: {}, filtered: false, visibleCount: 0 }))
      .toEqual({ open: 0, all: 0, shown: null })
  })
})

describe('kanban page wiring', () => {
  const kanbanJs = readFileSync(join(ROOT, 'web/modules/kanban.js'), 'utf8')

  it('the page has the totals element and both languages have the strings', () => {
    expect(readFileSync(join(ROOT, 'web/index.html'), 'utf8')).toContain('id="kanbanBoardTotals"')
    for (const lang of ['hu', 'en']) {
      const src = readFileSync(join(ROOT, `web/lang/${lang}.js`), 'utf8')
      expect(src).toContain("'kanban.totals'")
      expect(src).toContain("'kanban.totals_shown'")
    }
  })

  it('the column counters and the WIP badges both use the paged-aware count', () => {
    expect(kanbanJs).toContain('kanbanColumnCount(cards.length, _kanbanColumnPaging[status], _kanbanPagedMode)')
    expect(kanbanJs).toContain('columnCounts?.[status] ?? cards.length')
  })
})

describe('priority tone on the whole card', () => {
  const css = readAllCss()

  it('urgent and high tint the card fill and edge from theme tokens; no 3px priority stripe', () => {
    expect(css).toMatch(/\.kanban-card\[data-priority="urgent"\]\s*\{[^}]*background:\s*color-mix\([^)]*var\(--danger\)[^}]*border-color:/)
    expect(css).toMatch(/\.kanban-card\[data-priority="high"\]\s*\{[^}]*background:\s*color-mix\([^)]*var\(--accent\)[^}]*border-color:/)
    expect(css).not.toMatch(/\.kanban-card\[data-priority="[a-z]+"\]\s*\{\s*border-left:/)
  })

  it('has a stronger dark-theme tint, and no token that does not exist in this stylesheet set', () => {
    expect(css).toMatch(/\[data-theme="dark"\]\s+\.kanban-card\[data-priority="urgent"\]/)
    expect(css).toMatch(/\[data-theme="dark"\]\s+\.kanban-card\[data-priority="high"\]/)
    expect(css).not.toContain('--text-dim')
  })

  it('the aging stripe rule comes after the priority rules so a stale card keeps its stripe', () => {
    expect(css.lastIndexOf('.kanban-card[data-priority=')).toBeLessThan(css.indexOf('.kanban-card[data-aging]'))
  })
})
