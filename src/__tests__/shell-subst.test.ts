import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
// @ts-expect-error -- plain .mjs hook helper, no types
import { topBodies } from '../../scripts/shell-subst.mjs'

// scripts/shell-subst.mjs is the JS twin of scripts/hooks/shell_subst.py: the same shared case list
// (scripts/hooks/shell-subst-cases.json, also run by scripts/__tests__/shell-subst.test.py) must give
// the same bodies in both. A twin that drifts is a gate that passes in one language and not the other.

const ROOT = join(__dirname, '..', '..')
const CASES: Array<{ name: string; command: string; bodies: string[] }> = JSON.parse(
  readFileSync(join(ROOT, 'scripts', 'hooks', 'shell-subst-cases.json'), 'utf-8'),
)

function allBodies(text: string, acc: string[] = []): string[] {
  for (const b of topBodies(text) as string[]) {
    acc.push(b)
    allBodies(b, acc)
  }
  return acc
}

describe('topBodies: the shared case list', () => {
  it('is not trivially small', () => {
    expect(CASES.length).toBeGreaterThanOrEqual(40)
  })
  for (const c of CASES) {
    it(c.name, () => {
      expect(topBodies(c.command)).toEqual(c.bodies)
    })
  }
})

describe('topBodies: recursion reaches every level', () => {
  it('three levels of mixed quoting', () => {
    expect(allBodies('echo "$(echo "$(echo `rm x`)")"')).toEqual(['echo "$(echo `rm x`)"', 'echo `rm x`', 'rm x'])
  })
  for (const cmd of [
    'a "$(b "$(c "$(rm x)")")"',
    'a `b \\`c \\\\\\`rm x\\\\\\` \\``',
    'cat <<EOF\n$(b "$(rm x)")\nEOF\n',
    'a <(b <(rm x))',
    'a $(b $(c $(rm x)))',
  ]) {
    it(JSON.stringify(cmd), () => {
      expect(allBodies(cmd).some((b) => b.trim() === 'rm x')).toBe(true)
    })
  }
})

describe('topBodies: never throws', () => {
  it('garbage', () => {
    let seed = 11
    const rnd = () => {
      seed = (seed * 1103515245 + 12345) & 0x7fffffff
      return seed / 0x7fffffff
    }
    const atoms = ['$(', ')', '`', "'", '"', '\\', '<<', '<<-', 'EOF', '\n', '#', '<(', '>(', "$'", ' ', 'a', '$((', '<<<']
    for (let i = 0; i < 5000; i++) {
      let text = ''
      const n = Math.floor(rnd() * 30)
      for (let k = 0; k < n; k++) text += atoms[Math.floor(rnd() * atoms.length)]
      expect(Array.isArray(topBodies(text))).toBe(true)
      expect(Array.isArray(topBodies(text, true))).toBe(true)
    }
  })
})

describe('topBodies: linear on hostile input', () => {
  const SIZE = 262144
  const rep = (s: string, n: number) => s.repeat(n)
  const shapes: Array<[string, string]> = [
    ['unterminated $(', rep('$(', SIZE / 2)],
    ['unterminated "$(', rep('"$(', Math.floor(SIZE / 3))],
    ['backticks', rep('`a', SIZE / 2)],
    ['heredoc openers', rep('<<A\n', SIZE / 4)],
    ['many bodies', rep('echo "$(a)" ', Math.floor(SIZE / 12))],
    ['parens', rep('(', SIZE)],
    ['quotes', rep("'a' ", SIZE / 4)],
    ['backslashes', rep('\\', SIZE)],
    ['long heredoc word', 'cat <<' + rep('a', SIZE)],
    ['long quoted heredoc word', 'cat <<' + rep("'a'", Math.floor(SIZE / 3))],
  ]
  for (const [name, text] of shapes) {
    it(name, () => {
      const t0 = Date.now()
      topBodies(text)
      const ms = Date.now() - t0
      expect(ms, `${name}: ${ms} ms`).toBeLessThan(2000)
    })
  }
})
