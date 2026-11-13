// The failure-injection helper refuseInsert (helpers/refuse-insert.ts), on whichever backend the run uses: SQLite in the
// default suite, PostgreSQL in the module run (the file is in the ported list). The cells are about the helper itself:
// an injection that silently injects nothing would turn every test built on it into a test of the happy path.
import { describe, expect, it } from 'vitest'
import { useTestDb } from './helpers/with-test-db.js'
import { refuseInsert, refuseInsertSql } from './helpers/refuse-insert.js'

const { dbx } = useTestDb()

const count = async (table: string): Promise<number> => ((await dbx.get(`SELECT COUNT(*) AS n FROM ${table}`)) as { n: number }).n
const insertKey = (key: string) => dbx.run("INSERT INTO config_change_log (key, old_value, new_value, actor, created_at) VALUES (?, '1', '2', 'agent-a', 1)", key)

describe('refuseInsert', () => {
  it('refuses every INSERT into the table with the given message, and writes nothing', async () => {
    await refuseInsert(dbx, { name: 'no_inserts', table: 'config_change_log', message: 'insert refused' })
    await expect(insertKey('key-a')).rejects.toThrow('insert refused')
    expect(await count('config_change_log')).toBe(0)
  })

  it('with a condition it refuses only the matching rows', async () => {
    await refuseInsert(dbx, { name: 'no_key_b', table: 'config_change_log', message: 'key b refused', when: { column: 'key', equals: 'key-b' } })
    await insertKey('key-a')
    await expect(insertKey('key-b')).rejects.toThrow('key b refused')
    expect(await count('config_change_log')).toBe(1)
  })

  it('does not touch the other tables, and a refused insert inside a transaction rolls the transaction back', async () => {
    await refuseInsert(dbx, { name: 'no_inserts', table: 'config_change_log', message: 'insert refused' })
    await dbx.run("INSERT INTO hook_audit_log (ts, hook_type, verdict) VALUES (1, 'Stop', 'allow')")
    await expect(dbx.tx(async (tx) => {
      await tx.run("INSERT INTO hook_audit_log (ts, hook_type, verdict) VALUES (2, 'Stop', 'allow')")
      await tx.run("INSERT INTO config_change_log (key, old_value, new_value, actor, created_at) VALUES ('key-a', '1', '2', 'agent-a', 1)")
    })).rejects.toThrow('insert refused')
    expect(await count('hook_audit_log')).toBe(1)
  })

  it('rejects a name, table, column, message or value that could carry SQL', () => {
    const ok = { name: 'no_inserts', table: 'config_change_log', message: 'insert refused' }
    for (const bad of [
      { ...ok, name: 'x; DROP TABLE y' },
      { ...ok, table: 'a b' },
      { ...ok, message: "it's" },
      { ...ok, message: 'a$$b' },
      { ...ok, when: { column: 'k', equals: "x' OR '1'='1" } },
      { ...ok, when: { column: 'k = 1 --', equals: 'x' } },
    ]) expect(() => refuseInsertSql('sqlite', bad)).toThrow(/not allowed/)
    expect(() => refuseInsertSql('pg', ok)).not.toThrow()
  })

  it('writes the dialect it is asked for: RAISE(ABORT) on SQLite, a plpgsql function and trigger on PostgreSQL', () => {
    const o = { name: 'no_inserts', table: 'config_change_log', message: 'insert refused', when: { column: 'key', equals: 'key-b' } }
    expect(refuseInsertSql('sqlite', o)).toBe("CREATE TRIGGER no_inserts BEFORE INSERT ON config_change_log WHEN NEW.key = 'key-b' BEGIN SELECT RAISE(ABORT, 'insert refused'); END")
    const pg = refuseInsertSql('pg', o)
    expect(pg).toContain('RETURNS trigger LANGUAGE plpgsql')
    expect(pg).toContain("RAISE EXCEPTION 'insert refused'")
    expect(pg).toContain("FOR EACH ROW WHEN (NEW.key = 'key-b') EXECUTE FUNCTION no_inserts()")
  })
})
