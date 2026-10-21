import { db } from './connection.js'

export interface Widget { id: number; name: string }

export function getWidget(id: number): Widget | undefined {
  return db.prepare('SELECT id, name FROM widgets WHERE id = ?').get(id) as Widget | undefined
}

export function listWidgets(): Widget[] {
  return db.prepare('SELECT id, name FROM widgets').all() as Widget[]
}

export function renameWidget(id: number, name: string): number {
  const res = db.prepare('UPDATE widgets SET name = ? WHERE id = ?').run(name, id)
  return res.changes
}

export function resetWidgets(): void {
  db.exec('DELETE FROM widgets')
}

export function swapWidgets(a: number, b: number): void {
  db.transaction(() => {
    db.prepare('UPDATE widgets SET name = name || ? WHERE id = ?').run('-a', a)
    db.prepare('UPDATE widgets SET name = name || ? WHERE id = ?').run('-b', b)
  }).immediate()
}

// kept by hand: a statement stored in a variable
export function importWidgets(names: string[]): number {
  const stmt = db.prepare('INSERT INTO widgets (name) VALUES (?)')
  let n = 0
  for (const name of names) n += stmt.run(name).changes
  return n
}

// inside try the await decides who catches: it must stay
export function safeWidget(id: number): Widget | undefined {
  try {
    return db.prepare('SELECT id, name FROM widgets WHERE id = ?').get(id) as Widget | undefined
  } catch {
    return undefined
  }
}

export function getWidgetQa(id: number): { id: number } | undefined {
  return db.prepare('SELECT id FROM widgets WHERE id = ?').get(id) as { id: number } | undefined
}

// kept by hand: a stored statement next to a supported chain blocks the whole function
export function mixedWidgets(names: string[]): number {
  const stmt = db.prepare('INSERT INTO widgets (name) VALUES (?)')
  const before = db.prepare('SELECT COUNT(*) AS c FROM widgets').get() as { c: number }
  for (const name of names) stmt.run(name)
  return before.c
}

// kept by hand: better-sqlite3 transactions are synchronous, an async body is not a shape the codemod knows
export function asyncTx(): void {
  db.transaction(async () => {
    db.prepare('DELETE FROM widgets').run()
  })()
}
