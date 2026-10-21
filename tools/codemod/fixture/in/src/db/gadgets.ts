import { db } from './connection.js'

export function gadgetCount(): number {
  return (db.prepare('SELECT COUNT(*) AS c FROM gadgets').get() as { c: number }).c
}
