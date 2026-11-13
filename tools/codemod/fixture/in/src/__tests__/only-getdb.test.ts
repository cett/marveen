import { getDb } from '../db.js'

declare const it: (name: string, fn: () => unknown) => void
declare const expect: any

it('the getDb import becomes the dbx import when nothing else reads the handle', () => {
  const h = getDb()
  expect(h.prepare('SELECT 1 AS n').get()).toEqual({ n: 1 })
})
