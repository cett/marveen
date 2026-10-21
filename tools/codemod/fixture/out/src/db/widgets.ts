import { db } from './connection.js'
import { dbx } from './facade.js'

export interface Widget { id: number; name: string }

export async function getWidget(id: number): Promise<Widget | undefined> {
  return await dbx.get<Widget>('SELECT id, name FROM widgets WHERE id = ?', id)
}

export async function listWidgets(): Promise<Widget[]> {
  return await dbx.all<Widget>('SELECT id, name FROM widgets')
}

export async function renameWidget(id: number, name: string): Promise<number> {
  const res = await dbx.run('UPDATE widgets SET name = ? WHERE id = ?', name, id)
  return res.changes
}

export async function resetWidgets(): Promise<void> {
  await dbx.exec('DELETE FROM widgets')
}

export async function swapWidgets(a: number, b: number): Promise<void> {
  await dbx.tx(async (tx) => {
    await tx.run('UPDATE widgets SET name = name || ? WHERE id = ?', '-a', a)
    await tx.run('UPDATE widgets SET name = name || ? WHERE id = ?', '-b', b)
  }, { mode: 'immediate' })
}

// kept by hand: a statement stored in a variable
export function importWidgets(names: string[]): number {
  const stmt = db.prepare('INSERT INTO widgets (name) VALUES (?)')
  let n = 0
  for (const name of names) n += stmt.run(name).changes
  return n
}
