import { describe, it, expect } from 'vitest'
import { execFileSync } from 'node:child_process'
import { join } from 'node:path'
import { addGeneratedHeader, stripGeneratedHeader, readGeneratedHeader } from '../skill-header.js'

const FM = '---\nname: demo\ndescription: d\n---\n'

describe('generated SKILL.md header', () => {
  it('goes after the frontmatter, never before it (the loader needs frontmatter first)', () => {
    const out = addGeneratedHeader(`${FM}# Body\n`, 'global/demo')
    expect(out.startsWith(FM)).toBe(true)
    const lines = out.split('\n')
    expect(lines[4]).toMatch(/^<!-- GENERATED from the skills DB \(skill global\/demo\)\./)
    expect(lines[5]).toBe('# Body')
  })

  it('round-trips: strip(add(x)) === x for the shapes real skills have', () => {
    const shapes = [
      `${FM}# Body\n`,
      `${FM}`,
      '---\nname: x\n---',                 // frontmatter closes at EOF, no newline
      '---\nname: x\n---\n',
      'no frontmatter at all\nsecond line\n',
      '',
      `${FM}line\n\n\ntrailing blanks\n\n`,
      '---\r\nname: crlf\r\n---\r\nbody\r\n',
    ]
    for (const s of shapes) {
      expect(stripGeneratedHeader(addGeneratedHeader(s, 'global/demo'))).toBe(s)
    }
  })

  it('is idempotent: adding twice yields one header', () => {
    const once = addGeneratedHeader(`${FM}body\n`, 'global/demo')
    expect(addGeneratedHeader(once, 'global/demo')).toBe(once)
    expect(once.match(/GENERATED from the skills DB/g)).toHaveLength(1)
  })

  it('strip leaves content without a header untouched, and only removes the marker line', () => {
    const plain = `${FM}mentions GENERATED from the skills DB in prose, not as a comment line\n`
    expect(stripGeneratedHeader(plain)).toBe(plain)
  })

  it('reads back the skill id and the tenant flag', () => {
    expect(readGeneratedHeader(addGeneratedHeader(FM, 'agent/zed/my-skill'))).toEqual({ id: 'agent/zed/my-skill', tenant: false })
    expect(readGeneratedHeader(addGeneratedHeader(FM, 'acme-my-skill', { tenant: true }))).toEqual({ id: 'acme-my-skill', tenant: true })
    expect(readGeneratedHeader(FM)).toBeNull()
  })

  it('never embeds an id that could break out of the comment', () => {
    const out = addGeneratedHeader(FM, 'evil --> <script>')
    expect(out.match(/-->/g)).toHaveLength(1)   // only the real terminator
    expect(readGeneratedHeader(out)?.id).toBeNull()
  })

  it('the Python hook strips exactly what the TS side does (cross-language parity)', () => {
    const vectors = [
      addGeneratedHeader(`${FM}# Body\n`, 'global/demo'),
      addGeneratedHeader('---\nname: x\n---', 'global/x'),
      addGeneratedHeader('plain\n', 'global/p'),
      `${FM}no header\n`,
      '',
    ]
    const hook = join(__dirname, '../../scripts/hooks/skill-sql-sync.py')
    const py = `import importlib.util,json,sys
spec=importlib.util.spec_from_file_location('h', sys.argv[1]); m=importlib.util.module_from_spec(spec); spec.loader.exec_module(m)
print(json.dumps([m.strip_generated_header(v) for v in json.loads(sys.stdin.read())]))`
    const out = JSON.parse(execFileSync('python3', ['-c', py, hook], { input: JSON.stringify(vectors), encoding: 'utf-8' }))
    expect(out).toEqual(vectors.map(stripGeneratedHeader))
  })
})
