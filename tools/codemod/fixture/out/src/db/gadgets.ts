import { dbx } from './facade.js'

export async function gadgetCount(): Promise<number> {
  return ((await dbx.get('SELECT COUNT(*) AS c FROM gadgets')) as { c: number }).c
}
