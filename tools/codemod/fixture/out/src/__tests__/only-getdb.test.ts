import { dbx } from '../db.js'

declare const it: (name: string, fn: () => unknown) => void
declare const expect: any

it('the getDb import becomes the dbx import when nothing else reads the handle', async () => {
  expect(await dbx.get('SELECT 1 AS n')).toEqual({ n: 1 })
})
