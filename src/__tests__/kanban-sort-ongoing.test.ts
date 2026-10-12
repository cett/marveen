// Kanban column sort and the Ongoing band: the pure functions
// (web/modules/kanban-sort.js, kanban-ongoing.js) and the wiring in the board
// (string-grep contract, like the other kanban UI tests).
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { kanbanCardSorter, normalizeKanbanSort, isManualSort, KANBAN_SORT_MODES } from '../../web/modules/kanban-sort.js'
import { isOngoingCard, isOngoingLabelName, KANBAN_ONGOING_LABEL_NAMES } from '../../web/modules/kanban-ongoing.js'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..')
const read = (p: string) => readFileSync(join(ROOT, p), 'utf8')

const ids = (cards: Array<{ id: string }>) => cards.map((c) => c.id)

describe('kanbanCardSorter', () => {
  const cards = [
    { id: 'a', sort_order: 2, seq: 10, created_at: 100, updated_at: 500 },
    { id: 'b', sort_order: 0, seq: 30, created_at: 300, updated_at: 100 },
    { id: 'c', sort_order: 1, seq: 20, created_at: 200, updated_at: 300 },
  ]

  it('manual: the board\'s own drag order', () => {
    expect(ids([...cards].sort(kanbanCardSorter('manual')))).toEqual(['b', 'c', 'a'])
  })

  it('number: ascending and descending by seq', () => {
    expect(ids([...cards].sort(kanbanCardSorter('number_asc')))).toEqual(['a', 'c', 'b'])
    expect(ids([...cards].sort(kanbanCardSorter('number_desc')))).toEqual(['b', 'c', 'a'])
  })

  it('created and updated: newest first', () => {
    expect(ids([...cards].sort(kanbanCardSorter('created')))).toEqual(['b', 'c', 'a'])
    expect(ids([...cards].sort(kanbanCardSorter('updated')))).toEqual(['a', 'c', 'b'])
  })

  it('a card with no seq or time goes last in either direction', () => {
    const withGap = [{ id: 'x', sort_order: 0 }, { id: 'y', sort_order: 1, seq: 5, created_at: 1 }, { id: 'z', sort_order: 2, seq: 9, created_at: 2 }]
    expect(ids([...withGap].sort(kanbanCardSorter('number_asc')))).toEqual(['y', 'z', 'x'])
    expect(ids([...withGap].sort(kanbanCardSorter('number_desc')))).toEqual(['z', 'y', 'x'])
    expect(ids([...withGap].sort(kanbanCardSorter('created')))).toEqual(['z', 'y', 'x'])
  })

  it('the comparator itself puts a missing value after a present one, from either side', () => {
    for (const mode of ['number_asc', 'number_desc', 'created', 'updated']) {
      const sorter = kanbanCardSorter(mode)
      const none = { sort_order: 0 }
      const some = { sort_order: 1, seq: 4, created_at: 4, updated_at: 4 }
      expect(sorter(none, some)).toBeGreaterThan(0)
      expect(sorter(some, none)).toBeLessThan(0)
    }
  })

  it('a tie falls back to the manual order, so the order is stable', () => {
    const tie = [{ id: 'p', sort_order: 5, seq: 1 }, { id: 'q', sort_order: 2, seq: 1 }]
    expect(ids([...tie].sort(kanbanCardSorter('number_asc')))).toEqual(['q', 'p'])
  })

  it('an unknown or missing mode is the manual order, and only manual allows dragging', () => {
    expect(normalizeKanbanSort('nonsense')).toBe('manual')
    expect(normalizeKanbanSort(null)).toBe('manual')
    expect(KANBAN_SORT_MODES.filter(isManualSort)).toEqual(['manual'])
    expect(isManualSort(undefined)).toBe(true)
    expect(isManualSort('created')).toBe(false)
  })
})

describe('isOngoingCard', () => {
  const lab = (name: string) => ({ id: name, name })

  it('an open card with an ongoing label is ongoing, case-insensitively, in both languages', () => {
    for (const name of ['Folyamatos', 'ongoing', ' ONGOING ', 'folyamatos']) {
      expect(isOngoingCard({ status: 'in_progress', labels: [lab(name)] })).toBe(true)
    }
    for (const status of ['planned', 'waiting', 'testing']) {
      expect(isOngoingCard({ status, labels: [lab('Ongoing')] })).toBe(true)
    }
  })

  it('a done card stays in Done; a card without the label, or with none, is not ongoing', () => {
    expect(isOngoingCard({ status: 'done', labels: [lab('Ongoing')] })).toBe(false)
    expect(isOngoingCard({ status: 'planned', labels: [lab('urgent-ish')] })).toBe(false)
    expect(isOngoingCard({ status: 'planned', labels: [] })).toBe(false)
    expect(isOngoingCard({ status: 'planned', labels: null })).toBe(false)
    expect(isOngoingCard({ status: 'planned' })).toBe(false)
    expect(isOngoingCard(null)).toBe(false)
  })

  it('the name must match whole: a longer name or an empty one is not it', () => {
    expect(isOngoingLabelName('ongoing-ish')).toBe(false)
    expect(isOngoingLabelName('')).toBe(false)
    expect(isOngoingLabelName(undefined)).toBe(false)
    // a blank entry in the name list must not turn a blank label name into a match
    expect(isOngoingLabelName('  ', ['', 'ongoing'])).toBe(false)
  })

  it('the name list is one array: a name added there is recognised', () => {
    expect(KANBAN_ONGOING_LABEL_NAMES).toEqual(['folyamatos', 'ongoing'])
    expect(isOngoingCard({ status: 'planned', labels: [lab('Standing')] }, [...KANBAN_ONGOING_LABEL_NAMES, 'standing'])).toBe(true)
  })

  it('matches on the card\'s own labels, never the global registry (labels belong to a tenant)', () => {
    // A card of another tenant carries that tenant's label rows; the board only
    // ever holds the caller's tenant cards, and the band reads card.labels.
    const kanbanJs = read('web/modules/kanban.js')
    expect(kanbanJs).toContain('isOngoingCard(card)')
    expect(kanbanJs).not.toMatch(/isOngoingCard\(kanbanAllLabels/)
  })
})

describe('board wiring', () => {
  const kanbanJs = read('web/modules/kanban.js')

  it('a sorted column or an ongoing label forces the full load (no partial page)', () => {
    expect(kanbanJs).toContain('!isManualSort(kanbanSort) || ongoingLabelExists')
    expect(kanbanJs).toContain('kanbanAllLabels.some((l) => isOngoingLabelName(l?.name))')
  })

  it('both the flat board and the swimlane columns use the chosen sorter, not a fixed sort_order sort', () => {
    expect(kanbanJs.match(/\.sort\(kanbanCardSorter\(kanbanSort\)\)/g)?.length).toBeGreaterThanOrEqual(2)
    expect(kanbanJs).not.toContain('cards.sort((a, b) => a.sort_order - b.sort_order)')
    expect(kanbanJs).not.toContain('laneCardsByStatus[def.status].sort((a, b) => a.sort_order - b.sort_order)')
  })

  it('cards can be dragged (mouse and touch) only in the manual order', () => {
    expect(kanbanJs).toContain('el.draggable = _canWriteKanban && isManualSort(kanbanSort)')
    expect(kanbanJs).toContain('if (_canWriteKanban && isManualSort(kanbanSort)) _wireCardTouch?.(el, card)')
  })

  it('the sort choice is persisted and restored, and changing it goes through the filter-change path', () => {
    expect(kanbanJs).toContain("localStorage.setItem('marveen.kanbanSort', kanbanSort)")
    expect(kanbanJs).toContain("normalizeKanbanSort(localStorage.getItem('marveen.kanbanSort'))")
    expect(kanbanJs).toMatch(/getElementById\('kanbanSort'\)\.addEventListener\('change'[\s\S]*?_kanbanFilterChanged\(\)/)
  })

  it('an ongoing card leaves the columns, is never embedded, and its subtasks are not embedded in it', () => {
    expect(kanbanJs).toContain('if (ongoingIds.has(card.id)) continue')
    expect(kanbanJs).toContain('if (!card.parent_id || ongoingIds.has(card.id)) continue')
    expect(kanbanJs).toContain('ongoingIds.has(parent.id)) continue')
  })

  it('the band is a page element before the board, hidden while empty, and not a drop column', () => {
    const html = read('web/index.html')
    expect(html.indexOf('id="kanbanOngoingBand"')).toBeGreaterThan(0)
    expect(html.indexOf('id="kanbanOngoingBand"')).toBeLessThan(html.indexOf('id="kanbanBoard"'))
    expect(html).toMatch(/id="kanbanOngoingBand"[^>]*\shidden/)
    expect(kanbanJs).toContain('band.hidden = cards.length === 0')
    expect(html).not.toMatch(/kanbanOngoingBand[^>]*kanban-col-body/)
  })

  it('both languages carry the sort and band strings (the parity test keeps the keys equal)', () => {
    for (const lang of ['hu', 'en']) {
      const src = read(`web/lang/${lang}.js`)
      for (const key of ['kanban.sort.label', 'kanban.sort.manual', 'kanban.sort.number_asc', 'kanban.sort.number_desc', 'kanban.sort.created', 'kanban.sort.updated', 'kanban.ongoing.title']) {
        expect(src).toContain(`'${key}'`)
      }
    }
  })
})
