// skillTouchesPrivilege / privilegeBlocks: the narrow, mechanical rule that decides whether a change to a skill goes
// to review. Every case below is a line of that rule; a looser or a stricter rule fails one of them.
import { describe, it, expect } from 'vitest'
import { privilegeBlocks, skillTouchesPrivilege, type SkillFileFacts } from '../skill-privilege.js'

const md = (front: string, body = '# body\n') => `---\n${front}\n---\n${body}`
const file = (rel_path: string, text: string, mode = 0o644): SkillFileFacts => ({ rel_path, mode, content: Buffer.from(text) })
const BASE = md('name: demo\ndescription: does a thing')

describe('privilegeBlocks', () => {
  it('reads the privilege keys with their continuation lines, and nothing else', () => {
    const b = privilegeBlocks(md('name: demo\nallowed-tools:\n  - Read\n  - Bash\nmodel: fast\ndescription: >\n  folded\n  text'))
    expect([...b.keys()].sort()).toEqual(['allowed-tools', 'description'])
    expect(b.get('allowed-tools')).toBe('\n- Read\n- Bash')
    expect(b.get('description')).toBe('>\nfolded\ntext')
  })
  it('is case-insensitive on the key and keeps the last block of a duplicated key', () => {
    const b = privilegeBlocks(md('Allowed-Tools: Read\nallowed-tools: Bash'))
    expect(b.get('allowed-tools')).toBe('Bash')
  })
  it('a file with no frontmatter, or a frontmatter that never closes, has no blocks', () => {
    expect(privilegeBlocks('# just text\n').size).toBe(0)
    expect(privilegeBlocks('---\ndescription: x\nno closing line\n').size).toBe(0)
  })
  it('CRLF line endings read the same as LF', () => {
    expect(privilegeBlocks(md('description: x').replace(/\n/g, '\r\n')).get('description')).toBe('x')
  })
})

describe('skillTouchesPrivilege: frontmatter', () => {
  const v = (afterFront: string, before = BASE) => skillTouchesPrivilege({ content: before, files: [] }, { content: md(afterFront), files: [] })

  it('a body-only edit and an edit of another key are plain edits', () => {
    expect(skillTouchesPrivilege({ content: BASE, files: [] }, { content: md('name: demo\ndescription: does a thing', '# other body\n'), files: [] }).touches).toBe(false)
    expect(v('name: renamed\ndescription: does a thing').touches).toBe(false)
  })
  it.each([
    ['a changed description', 'name: demo\ndescription: does another thing'],
    ['a new allowed-tools block', 'name: demo\ndescription: does a thing\nallowed-tools: Bash'],
    ['a new tools block', 'name: demo\ndescription: does a thing\ntools: Bash'],
    ['a new hooks block', 'name: demo\ndescription: does a thing\nhooks:\n  PreToolUse: x'],
    ['a removed description', 'name: demo'],
  ])('%s touches privilege', (_n, front) => {
    const r = v(front)
    expect(r.touches).toBe(true)
    expect(r.reasons).toEqual(['frontmatter'])
  })
  it('a change in a CONTINUATION line of an allowed-tools list counts (the whole block is compared)', () => {
    const before = md('allowed-tools:\n  - Read')
    expect(skillTouchesPrivilege({ content: before, files: [] }, { content: md('allowed-tools:\n  - Read\n  - Bash'), files: [] }).touches).toBe(true)
  })
  it('the same blocks, reformatted only by surrounding blanks, are unchanged', () => {
    expect(skillTouchesPrivilege({ content: md('description:   does a thing  '), files: [] }, { content: md('description: does a thing'), files: [] }).touches).toBe(false)
  })
})

describe('skillTouchesPrivilege: runnable files', () => {
  const same = { content: BASE }
  it('a new script touches privilege', () => {
    const r = skillTouchesPrivilege({ ...same, files: [] }, { ...same, files: [file('scripts/run.sh', 'echo hi', 0o755)] })
    expect(r).toEqual({ touches: true, reasons: ['script'] })
  })
  it('a changed script (same path, other bytes) touches privilege', () => {
    expect(skillTouchesPrivilege({ ...same, files: [file('scripts/run.sh', 'a', 0o755)] }, { ...same, files: [file('scripts/run.sh', 'b', 0o755)] }).touches).toBe(true)
  })
  it('a plain file that only gains the execute bit touches privilege', () => {
    expect(skillTouchesPrivilege({ ...same, files: [file('ref/a.md', 'x')] }, { ...same, files: [file('ref/a.md', 'x', 0o755)] }).touches).toBe(true)
  })
  it('an executable file outside scripts/ counts as runnable', () => {
    expect(skillTouchesPrivilege({ ...same, files: [] }, { ...same, files: [file('bin/tool', 'x', 0o755)] }).touches).toBe(true)
  })
  it('an unchanged script, a removed script and a plain reference file are NOT a privilege change', () => {
    const s = file('scripts/run.sh', 'a', 0o755)
    expect(skillTouchesPrivilege({ ...same, files: [s] }, { ...same, files: [s] }).touches).toBe(false)
    expect(skillTouchesPrivilege({ ...same, files: [s] }, { ...same, files: [] }).touches).toBe(false)
    expect(skillTouchesPrivilege({ ...same, files: [] }, { ...same, files: [file('references/a.md', 'text')] }).touches).toBe(false)
  })
  it('both reasons are reported together', () => {
    const r = skillTouchesPrivilege({ content: BASE, files: [] }, { content: md('description: new'), files: [file('scripts/a.sh', 'x', 0o755)] })
    expect(r.reasons).toEqual(['script', 'frontmatter'])
  })
})

describe('skillTouchesPrivilege: no live state yet', () => {
  it('a new skill with only a name/description does NOT touch privilege: there is no approved value to diverge from', () => {
    expect(skillTouchesPrivilege(null, { content: BASE, files: [] }).touches).toBe(false)
    expect(skillTouchesPrivilege(null, { content: '# nothing\n', files: [] }).touches).toBe(false)
  })
  it.each([
    ['allowed-tools', 'name: demo\ndescription: does a thing\nallowed-tools: Bash'],
    ['tools', 'name: demo\ndescription: does a thing\ntools: Bash'],
    ['hooks', 'name: demo\ndescription: does a thing\nhooks:\n  PreToolUse: x'],
  ])('a new skill with a %s block touches privilege, description alone does not grant it that', (_k, front) => {
    const r = skillTouchesPrivilege(null, { content: md(front), files: [] })
    expect(r).toEqual({ touches: true, reasons: ['frontmatter'] })
  })
  it('a new skill with a runnable file touches privilege regardless of its frontmatter', () => {
    const r = skillTouchesPrivilege(null, { content: BASE, files: [file('scripts/run.sh', 'echo hi', 0o755)] })
    expect(r).toEqual({ touches: true, reasons: ['script'] })
  })
})
