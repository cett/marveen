import { describe, it, expect } from 'vitest'
// @ts-expect-error -- plain .mjs hook script, no types
import { gateDecision, schedulerMatch, schedulerReadMatch, makePrefixedMatcher, MAX_CMD_CHARS } from '../../scripts/self-pace-gate.mjs'

// The scheduler check of the self-pace gate was one regex, quadratic on a long run of `(` or backticks. It is now a
// procedural linear matcher. The language must be EXACTLY the old regex's (narrowing `\S*` would stop catching
// `X=$(nohup crontab -)`), so the old regexes are kept here, literally, as the ORACLE of a differential fuzz.

const SCHED_PREFIX = String.raw`(?:(?:[A-Za-z_]\w*=\S*|sudo|env|command|exec|nice|builtin|time)\s+)*(?:\S*/)?`
const SCHED_BOUNDARY = '[;&|(`]'
const AT_INVOCATION = String.raw`(?=\s*$|\s+-|\s*<|\s+(?:now|noon|midnight|teatime|today|tomorrow|next\b|\+\s*\d|\d{1,2}:\d{2}|\d{3,4}\b|\d{1,2}\s*(?:am|pm)\b|\d{1,2}[./]\d{1,2}|(?:mon|tue|wed|thu|fri|sat|sun)|(?:jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)))`
const LAUNCHCTL_SUBCOMMAND = String.raw`(?=\s*$|\s+-|\s+[a-z][a-z-]*(?:\s|$))`
const ORACLE_SCHEDULER_RX = new RegExp(
  String.raw`(^|${SCHED_BOUNDARY}\s*)${SCHED_PREFIX}(?:(?:crontab|systemd-run)\b(?!-)(?!\s*=)|launchctl\b(?!-)(?!\s*=)${LAUNCHCTL_SUBCOMMAND}|(?:batch|at)\b(?!-)(?!\s*=)${AT_INVOCATION})`,
  'i',
)
const ORACLE_READ_RX = new RegExp(String.raw`(^|${SCHED_BOUNDARY}\s*)${SCHED_PREFIX}(crontab\s+-l\b|launchctl\s+(?:list|print|dumpstate|blame|examine)\b|atq\b)`, 'i')

const oracleDeny = (seg: string) => ORACLE_SCHEDULER_RX.test(seg) && !ORACLE_READ_RX.test(seg)

// seeded PRNG (mulberry32): a failing case reproduces
function prng(seed: number) {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

const TOKENS = [
  ';', '&', '|', '(', '`', '$(', '&&', '||', ' ', ' ', ' ', '\t', '\n', ' ', '/', '/usr/bin/', './', '=', 'A=', 'A=1', '_x=', 'x1=', '1=',
  'nohup', 'sudo', 'env', 'command', 'exec', 'nice', 'builtin', 'time', 'SUDO', 'sudoers', 'envx', 'crontab', 'CRONTAB', 'crontabs', 'crontab-',
  'systemd-run', 'launchctl', 'list', 'print', 'dumpstate', 'blame', 'examine', 'load', 'at', 'AT', 'batch', 'atq', 'now', '5:30', 'noon', '-l', '-r',
  '-', '-x', '<', '$', 'a', 'x', 'foo', '12', '2pm', 'tomorrow', '+1',
]

function randomCase(rand: () => number): string {
  const len = 1 + Math.floor(rand() * 14)
  let s = ''
  for (let i = 0; i < len; i++) s += TOKENS[Math.floor(rand() * TOKENS.length)]
  return s
}

describe('linear scheduler matcher == the old regexes (differential fuzz)', () => {
  it('SCHEDULER: 200k seeded random segments agree with the oracle', () => {
    const rand = prng(20261104)
    let positives = 0
    for (let i = 0; i < 200_000; i++) {
      const s = randomCase(rand)
      const want = ORACLE_SCHEDULER_RX.test(s)
      if (want) positives++
      if (schedulerMatch(s) !== want) throw new Error(`SCHEDULER differs on ${JSON.stringify(s)}: oracle ${want}`)
    }
    // the fuzz must exercise both verdicts, or it agrees on a constant
    expect(positives).toBeGreaterThan(5_000)
    expect(200_000 - positives).toBeGreaterThan(5_000)
  })

  it('READ: 200k seeded random segments agree with the oracle', () => {
    const rand = prng(11042026)
    let positives = 0
    for (let i = 0; i < 200_000; i++) {
      const s = randomCase(rand)
      const want = ORACLE_READ_RX.test(s)
      if (want) positives++
      if (schedulerReadMatch(s) !== want) throw new Error(`READ differs on ${JSON.stringify(s)}: oracle ${want}`)
    }
    expect(positives).toBeGreaterThan(1_000)
    expect(200_000 - positives).toBeGreaterThan(5_000)
  })

  it('the combined deny (scheduler && !read) agrees on 100k segments', () => {
    const rand = prng(7)
    for (let i = 0; i < 100_000; i++) {
      const s = randomCase(rand)
      if ((schedulerMatch(s) && !schedulerReadMatch(s)) !== oracleDeny(s)) throw new Error(`deny differs on ${JSON.stringify(s)}`)
    }
  })

  it('shapes built around real invocations (wrappers, paths, boundaries) agree', () => {
    const rand = prng(99)
    const wrappers = ['', 'sudo ', 'env ', 'A=1 ', 'nohup ', 'A=$(nohup ', 'time ', 'X=a/b ', '/usr/bin/', './', 'sudo -n ', 'command ', 'exec ']
    const bounds = ['', ';', '&&', '|', '(', '`', '$(', ' ; ', '\n', 'echo hi; ', 'x ']
    const bodies = ['crontab -', 'crontab -r', 'crontab -l', 'CRONTAB -e', 'systemd-run --user x', 'launchctl load x', 'launchctl list', 'launchctl com.x PID 5',
      'launchctl print gui/1', 'at now', 'at 5:30', 'at least 80%', 'batch', 'batch size 50', 'atq', 'at=$(x)', 'crontab-helper.sh', 'crontab =', 'netstat -an']
    for (let i = 0; i < 100_000; i++) {
      let s = ''
      const parts = 1 + Math.floor(rand() * 3)
      for (let p = 0; p < parts; p++) {
        s += bounds[Math.floor(rand() * bounds.length)] + wrappers[Math.floor(rand() * wrappers.length)] + (rand() < 0.2 ? ' ' : '') + bodies[Math.floor(rand() * bodies.length)]
        if (rand() < 0.3) s += ' ' + TOKENS[Math.floor(rand() * TOKENS.length)]
      }
      if (schedulerMatch(s) !== ORACLE_SCHEDULER_RX.test(s)) throw new Error(`SCHEDULER differs on ${JSON.stringify(s)}`)
      if (schedulerReadMatch(s) !== ORACLE_READ_RX.test(s)) throw new Error(`READ differs on ${JSON.stringify(s)}`)
    }
  })
})

describe('pinned verdicts (oracle and gate agree, one by one)', () => {
  const pins: Array<[string, boolean]> = [
    ['crontab -', true],
    ['crontab -r', true],
    ['sudo crontab -r', true],
    ['/usr/bin/at now', true],
    ['PATH=/bin crontab -', true],
    ['env FOO=1 crontab -', true],
    ['X=$(crontab -)', true],
    ['X=`crontab -r`', true],
    ['X=$(nohup crontab -)', true], // unlisted wrapper word swallowed by the assignment value
    ['echo hi; systemd-run --user sleep 5', true],
    ['echo hi && launchctl load ~/x.plist', true],
    ['at 5:30', true],
    ['batch', true],
    ['CRONTAB -e', true],
    ['crontab -l', false],
    ['sudo crontab -l', false],
    ['launchctl list', false],
    ['launchctl print gui/501', false],
    ['atq', false],
    ['netstat -an', false],
    ['crontab-helper.sh run', false],
    ['at=$(date)', false],
    ['at least 80% done', false],
    ['batch size 50', false],
    ['launchctl com.marveen.channels PID 555', false],
    ['echo crontab -r', false], // not command position
    ['grep crontab notes.txt', false],
  ]
  for (const [cmd, deny] of pins) {
    it(`${deny ? 'deny ' : 'allow'}  ${JSON.stringify(cmd)}`, () => {
      expect(oracleDeny(cmd), 'the pin disagrees with the OLD regex').toBe(deny)
      expect(gateDecision('Bash', { command: cmd }).deny, 'gate').toBe(deny)
    })
  }
  it('a leading space at the string start skips the ^ branch, as the regex did', () => {
    expect(ORACLE_SCHEDULER_RX.test(' crontab -')).toBe(false)
    expect(schedulerMatch(' crontab -')).toBe(false)
    expect(schedulerMatch(';  crontab -')).toBe(true)
  })
})

describe('hostile shapes at the cap run linear', () => {
  const n = MAX_CMD_CHARS - 10
  // The old regex took 1.5-3.6 s of CPU on the parens shapes. The matcher is a few passes over the string; 1 s is a
  // wide ceiling that still fails a return to a quadratic scan (a 64 KB quadratic run is seconds).
  const CEILING_MS = 1000
  const rep = (u: string) => u.repeat(Math.floor(n / u.length))
  const shapes: Array<[string, string]> = [
    ['parens', '('.repeat(n)],
    ['backticks', '`'.repeat(n)],
    ['assignment after a paren', rep('(a=')],
    ['path after a paren', rep('(a/')],
    ['dollar parens', rep('$(')],
    ['backtick pairs', rep('`a')],
    ['wrapper chain', rep('A=1 ')],
    ['wrapper chain with boundary inside the word', rep('A=; ')],
    ['sudo chain', rep('sudo ')],
    ['slashes', '/'.repeat(n)],
    ['slash words', rep('a/')],
    ['one long word with slashes', 'a/'.repeat(Math.floor(n / 2))],
    ['at chain', rep('at ')],
    ['spaces', ' '.repeat(n)],
    ['boundary then spaces', rep('; ')],
    ['tabs and nbsp', rep('\t ')],
  ]
  for (const [name, command] of shapes) {
    it(name, () => {
      const c0 = process.cpuUsage()
      schedulerMatch(command)
      schedulerReadMatch(command)
      const c = process.cpuUsage(c0)
      const ms = Math.round((c.user + c.system) / 1000)
      expect(ms, `${name}: ${ms} ms of CPU`).toBeLessThan(CEILING_MS)
    })
  }
  it('scales linearly: 8x the input costs well under 64x the time', () => {
    const cost = (len: number) => {
      const s = '(a='.repeat(Math.floor(len / 3))
      const c0 = process.cpuUsage()
      schedulerMatch(s)
      const c = process.cpuUsage(c0)
      return c.user + c.system
    }
    cost(8000) // warm up
    const small = Math.max(cost(8000), 1000)
    const big = cost(64000)
    expect(big).toBeLessThan(small * 40)
  })
})

describe('makePrefixedMatcher', () => {
  it('builds a matcher for any tail, with the same prefix language', () => {
    const m = makePrefixedMatcher(String.raw`(?:zzz\b)`)
    expect(m('zzz')).toBe(true)
    expect(m('sudo A=1 /bin/zzz')).toBe(true)
    expect(m('x=$(nohup zzz)')).toBe(true)
    expect(m('echo zzz')).toBe(false)
    expect(m('')).toBe(false)
  })
})
