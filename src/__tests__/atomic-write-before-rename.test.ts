import { describe, it, expect, vi, afterEach } from 'vitest'
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { atomicWriteFileSync } from '../web/atomic-write.js'

// The optional beforeRename(tmpPath) callback of atomicWriteFileSync: a throw cancels the write and removes the
// tmp file; without the callback nothing differs from the plain atomic write every other caller relies on.
const dirs: string[] = []
function fresh(): { dir: string, target: string } {
  const dir = mkdtempSync(join(tmpdir(), 'atomic-before-'))
  dirs.push(dir)
  return { dir, target: join(dir, 'file.json') }
}
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }) })

describe('atomicWriteFileSync beforeRename', () => {
  it('runs once with the tmp file before the rename: the tmp holds the new data, the target still the old', () => {
    const { dir, target } = fresh()
    writeFileSync(target, 'old')
    const cb = vi.fn((tmp: string) => {
      expect(tmp.startsWith(target + '.')).toBe(true)
      expect(readFileSync(tmp, 'utf-8')).toBe('new')
      expect(statSync(tmp).mode & 0o777).toBe(0o600)
      expect(readFileSync(target, 'utf-8')).toBe('old')
    })
    atomicWriteFileSync(target, 'new', { mode: 0o600, beforeRename: cb })
    expect(cb).toHaveBeenCalledTimes(1)
    expect(readFileSync(target, 'utf-8')).toBe('new')
    expect(readdirSync(dir)).toEqual(['file.json'])
  })

  it('T4 a throw cancels the write: the same error goes up, the tmp file is gone, the target is untouched', () => {
    const { dir, target } = fresh()
    writeFileSync(target, 'old')
    let tmpSeen = ''
    const boom = new Error('refused')
    expect(() => atomicWriteFileSync(target, 'new', { mode: 0o600, beforeRename: tmp => { tmpSeen = tmp; expect(existsSync(tmp)).toBe(true); throw boom } })).toThrow(boom)
    expect(tmpSeen).not.toBe('')
    expect(existsSync(tmpSeen)).toBe(false)
    expect(readdirSync(dir)).toEqual(['file.json'])
    expect(readFileSync(target, 'utf-8')).toBe('old')
  })

  it('a throw on a target that does not exist yet leaves no file at all', () => {
    const { dir, target } = fresh()
    expect(() => atomicWriteFileSync(target, 'new', { beforeRename: () => { throw new Error('no') } })).toThrow('no')
    expect(readdirSync(dir)).toEqual([])
  })

  it('a throw after the callback already removed the tmp file still rethrows the callback error (the clean-up is best effort)', () => {
    const { target } = fresh()
    const boom = new Error('own error')
    expect(() => atomicWriteFileSync(target, 'new', { beforeRename: tmp => { rmSync(tmp); throw boom } })).toThrow(boom)
  })

  it('T5 without the callback it is the plain atomic write: new content, requested mode, no leftover (all other callers)', () => {
    const { dir, target } = fresh()
    writeFileSync(target, 'old')
    atomicWriteFileSync(target, 'new', { mode: 0o600 })
    expect(readFileSync(target, 'utf-8')).toBe('new')
    expect(statSync(target).mode & 0o777).toBe(0o600)
    expect(readdirSync(dir)).toEqual(['file.json'])
    atomicWriteFileSync(target, 'again') // no opts at all
    expect(readFileSync(target, 'utf-8')).toBe('again')
    atomicWriteFileSync(target, 'third', { beforeRename: undefined }) // an explicit undefined is the same as absent
    expect(readFileSync(target, 'utf-8')).toBe('third')
  })
})
