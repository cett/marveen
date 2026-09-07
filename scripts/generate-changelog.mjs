#!/usr/bin/env node
/**
 * generate-changelog.mjs
 *
 * Incrementally appends conventional commits to the [Unreleased] section of
 * CHANGELOG.md. A hidden `<!-- changelog-auto-sha: <sha> -->` marker inside
 * [Unreleased] records the HEAD commit as of the last run; each run only
 * reads commits after that marker and prepends them into the matching
 * section (existing hand-written [Unreleased] entries are never touched).
 *
 * First run against a [Unreleased] section that has content but no marker
 * yet (e.g. the first run after this script changed from full-recompute to
 * incremental) does not touch that content either -- it just stamps the
 * marker at HEAD so every following run is incremental from here on.
 *
 * If the marker commit can no longer be resolved (rebase, gc, shallow
 * clone), the run falls back to the last git tag and recomputes the whole
 * section, same as the old behaviour, with a warning on stderr.
 *
 * With --release <version>, promotes [Unreleased] to that version
 * header and resets [Unreleased] to empty (marker included). Also updates
 * package.json.
 *
 * Usage:
 *   node scripts/generate-changelog.mjs
 *   node scripts/generate-changelog.mjs --release 1.34.0
 *   node scripts/generate-changelog.mjs --since v1.32.0   # explicit full recompute from a tag
 */

import { execFileSync } from 'node:child_process'
import { readFileSync, writeFileSync } from 'node:fs'

// Commit scopes that are considered API-facing (get [API] label).
const API_SCOPES = new Set(['api', 'openapi', 'sdk', 'sdk-gen', 'versioning'])

const TYPE_TO_SECTION = {
  feat:     'Added',
  fix:      'Fixed',
  refactor: 'Changed',
  perf:     'Changed',
  docs:     'Documentation',
  chore:    'Infrastructure',
  test:     'Infrastructure',
  style:    'Infrastructure',
  build:    'Infrastructure',
  ci:       'Infrastructure',
}

const SECTION_ORDER = ['Added', 'Fixed', 'Changed', 'Documentation', 'Infrastructure']

const MARKER_RE = /^<!--\s*changelog-auto-sha:\s*([0-9a-f]{7,40})\s*-->$/

// ---------------------------------------------------------------------------

function parseConventionalCommit(subject) {
  const m = /^(\w+)(?:\(([^)]+)\))?(!)?:\s*(.+)$/.exec(subject)
  if (!m) return null
  return { type: m[1], scope: m[2] ?? '', breaking: m[3] === '!', description: m[4] }
}

function isApiScope(scope) {
  return API_SCOPES.has(scope) || scope.startsWith('api')
}

function getLastTag() {
  try {
    return execFileSync('git', ['describe', '--tags', '--abbrev=0'], { encoding: 'utf-8' }).trim()
  } catch {
    return null
  }
}

function getCommitSubjects(since) {
  const rangeArgs = since ? [`${since}..HEAD`] : ['HEAD']
  const raw = execFileSync(
    'git', ['log', ...rangeArgs, '--no-merges', '--format=%s'],
    { encoding: 'utf-8' }
  ).trim()
  return raw ? raw.split('\n') : []
}

function getHeadSha() {
  return execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf-8' }).trim()
}

// Returns true if `ref` resolves to a commit reachable in this repo (i.e.
// it's safe to use as the left side of `ref..HEAD`).
function refResolves(ref) {
  try {
    execFileSync('git', ['rev-parse', '--verify', '--quiet', `${ref}^{commit}`], { encoding: 'utf-8' })
    return true
  } catch {
    return false
  }
}

function buildSections(subjects) {
  const sections = {}
  for (const subject of subjects) {
    const parsed = parseConventionalCommit(subject)
    if (!parsed) continue
    // Skip "chore(release): vX.Y.Z" commits -- they are changelog noise.
    if (parsed.type === 'chore' && /^v?\d+\.\d+/.test(parsed.description)) continue
    const section = TYPE_TO_SECTION[parsed.type] ?? 'Changed'
    if (!sections[section]) sections[section] = []
    const apiTag = isApiScope(parsed.scope) ? '**[API]** ' : ''
    const breakTag = parsed.breaking ? '**BREAKING** ' : ''
    sections[section].push(`- ${breakTag}${apiTag}${parsed.description}`)
  }
  return sections
}

function formatUnreleasedBlock(sections) {
  const lines = []
  for (const sec of SECTION_ORDER) {
    if (!sections[sec]?.length) continue
    lines.push(`### ${sec}`, '', ...sections[sec], '')
  }
  // Trim trailing blank lines from the block (one will be added by serialiser).
  while (lines.length && lines.at(-1) === '') lines.pop()
  return lines
}

// ---------------------------------------------------------------------------
// [Unreleased] body parsing/merging -- incremental append, marker tracking
// ---------------------------------------------------------------------------

// Parses the raw `lines` of the [Unreleased] section into its marker (if
// any), its section headings in encountered order, and each heading's
// bullet lines (trimmed of surrounding blank lines). Any non-blank content
// before the first heading (other than the marker) is preserved verbatim in
// `preamble` so nothing manually added up there is ever lost.
function parseUnreleasedBody(lines) {
  let marker = null
  const sections = new Map()
  const order = []
  const preamble = []
  let current = null
  for (const line of lines) {
    const markerMatch = MARKER_RE.exec(line.trim())
    if (markerMatch) { marker = markerMatch[1]; continue }
    const headingMatch = /^### (.+)$/.exec(line)
    if (headingMatch) {
      current = headingMatch[1]
      if (!sections.has(current)) { sections.set(current, []); order.push(current) }
      continue
    }
    if (current) {
      sections.get(current).push(line)
    } else if (line.trim() !== '') {
      preamble.push(line)
    }
  }
  for (const bullets of sections.values()) {
    while (bullets.length && bullets[0] === '') bullets.shift()
    while (bullets.length && bullets.at(-1) === '') bullets.pop()
  }
  return { marker, sections, order, preamble }
}

// Prepends each of `newSections`'s bullet lines to the matching heading in
// `parsed` (newest-first, matching how every section is already ordered).
// A heading that doesn't exist yet is created and inserted in SECTION_ORDER
// position relative to the headings already present.
function mergeSections(parsed, newSections) {
  const rank = name => {
    const i = SECTION_ORDER.indexOf(name)
    return i === -1 ? SECTION_ORDER.length : i
  }
  for (const sec of SECTION_ORDER) {
    const newLines = newSections[sec]
    if (!newLines?.length) continue
    if (parsed.sections.has(sec)) {
      parsed.sections.set(sec, [...newLines, ...parsed.sections.get(sec)])
    } else {
      parsed.sections.set(sec, [...newLines])
      const insertBefore = parsed.order.find(existing => rank(existing) > rank(sec))
      if (insertBefore) {
        parsed.order.splice(parsed.order.indexOf(insertBefore), 0, sec)
      } else {
        parsed.order.push(sec)
      }
    }
  }
}

// Inverse of parseUnreleasedBody -- rebuilds the raw `lines` array for the
// [Unreleased] section, stamping `markerSha` (or omitting the marker
// entirely when null, e.g. a freshly-cut release's empty [Unreleased]).
function serializeUnreleasedBody(parsed, markerSha) {
  const lines = []
  if (markerSha) lines.push(`<!-- changelog-auto-sha: ${markerSha} -->`, '')
  lines.push(...parsed.preamble)
  if (parsed.preamble.length) lines.push('')
  for (const sec of parsed.order) {
    const bullets = parsed.sections.get(sec)
    if (!bullets?.length) continue
    lines.push(`### ${sec}`, '', ...bullets, '')
  }
  while (lines.length && lines.at(-1) === '') lines.pop()
  return ['', ...lines, '']
}

// ---------------------------------------------------------------------------
// CHANGELOG parser / serialiser (line-based, preserves hand-written content)
// ---------------------------------------------------------------------------

function parseChangelog(content) {
  const lines = content.split('\n')
  const preamble = []
  const versionSections = []  // [{version, header, lines}]

  let current = null
  for (const line of lines) {
    const m = /^## \[([^\]]+)\](.*)$/.exec(line)
    if (m) {
      if (current) versionSections.push(current)
      current = { version: m[1], header: line, lines: [] }
    } else if (current) {
      current.lines.push(line)
    } else {
      preamble.push(line)
    }
  }
  if (current) versionSections.push(current)
  return { preamble, versionSections }
}

function serializeChangelog({ preamble, versionSections }) {
  const parts = [preamble.join('\n')]
  for (const { header, lines } of versionSections) {
    parts.push(header)
    parts.push(lines.join('\n'))
  }
  return parts.join('\n')
}

function today() {
  return new Date().toISOString().slice(0, 10)
}

// ---------------------------------------------------------------------------
// main
// ---------------------------------------------------------------------------

const args = process.argv.slice(2)
const releaseIdx = args.indexOf('--release')
const releaseVersion = releaseIdx >= 0 ? (args[releaseIdx + 1] ?? null) : null
const sinceIdx = args.indexOf('--since')
const sinceTag = sinceIdx >= 0 ? (args[sinceIdx + 1] ?? null) : null

const changelogPath = 'CHANGELOG.md'
let changelogContent
try {
  changelogContent = readFileSync(changelogPath, 'utf-8')
} catch {
  changelogContent = [
    '# Changelog',
    '',
    'All notable changes to this project are documented in this file.',
    'Format: [Keep a Changelog](https://keepachangelog.com/en/1.0.0/), SemVer.',
    '',
  ].join('\n')
}

const { preamble, versionSections } = parseChangelog(changelogContent)

const unreleasedIdx = versionSections.findIndex(s => s.version === 'Unreleased')
const headSha = getHeadSha()

if (releaseVersion) {
  if (!releaseVersion.match(/^\d+\.\d+\.\d+$/)) {
    console.error(`Invalid version format: ${releaseVersion}  (expected X.Y.Z)`)
    process.exit(1)
  }

  // Fresh [Unreleased], stamped at the current HEAD so the next run only
  // picks up commits made after this release.
  const newUnreleased = {
    version: 'Unreleased',
    header: '## [Unreleased]',
    lines: serializeUnreleasedBody({ marker: null, sections: new Map(), order: [], preamble: [] }, headSha),
  }

  // Convert existing [Unreleased] to version entry (marker stripped -- it's
  // implementation metadata, not a changelog entry).
  if (unreleasedIdx >= 0) {
    const existing = versionSections[unreleasedIdx]
    versionSections.splice(unreleasedIdx, 1,
      newUnreleased,
      {
        version: releaseVersion,
        header: `## [${releaseVersion}] - ${today()}`,
        lines: existing.lines.filter(l => !MARKER_RE.test(l.trim())),
      }
    )
  } else {
    // No [Unreleased] -- full recompute since the last tag, insert a fresh
    // [Unreleased] plus the generated version block.
    const baseTag = sinceTag ?? getLastTag()
    const blockLines = formatUnreleasedBlock(buildSections(getCommitSubjects(baseTag)))
    versionSections.unshift(
      newUnreleased,
      {
        version: releaseVersion,
        header: `## [${releaseVersion}] - ${today()}`,
        lines: ['', ...blockLines, ''],
      }
    )
  }

  // Bump package.json
  const pkg = JSON.parse(readFileSync('package.json', 'utf-8'))
  const prev = pkg.version
  pkg.version = releaseVersion
  writeFileSync('package.json', JSON.stringify(pkg, null, 2) + '\n')

  writeFileSync(changelogPath, serializeChangelog({ preamble, versionSections }))
  console.log(`Released [${releaseVersion}] (was ${prev}).  package.json updated.`)
} else {
  const existingLines = unreleasedIdx >= 0 ? versionSections[unreleasedIdx].lines : []
  const parsedUnreleased = parseUnreleasedBody(existingLines)
  const hasExistingContent = parsedUnreleased.preamble.length > 0 || parsedUnreleased.order.length > 0

  let baseRef = null
  let appendMode = false

  if (sinceTag) {
    // Explicit override -- full recompute from the given tag, same as before.
    baseRef = sinceTag
  } else if (parsedUnreleased.marker) {
    if (refResolves(parsedUnreleased.marker)) {
      baseRef = parsedUnreleased.marker
      appendMode = true
    } else {
      console.warn(
        `changelog marker ${parsedUnreleased.marker} no longer resolves (rebase/gc/shallow clone?) -- ` +
        `falling back to a full recompute since the last tag.`
      )
      baseRef = getLastTag()
    }
  } else if (hasExistingContent) {
    // First run of the incremental generator against an [Unreleased]
    // section that already has content but no marker yet (migration from
    // the old full-recompute behaviour). Leave that content untouched and
    // just stamp the marker so every following run is incremental.
    versionSections[unreleasedIdx].lines = serializeUnreleasedBody(parsedUnreleased, headSha)
    writeFileSync(changelogPath, serializeChangelog({ preamble, versionSections }))
    console.log(`[Unreleased] left untouched (pre-existing content, no prior marker) -- stamped changelog-auto-sha at ${headSha}.`)
    process.exit(0)
  } else {
    // Fresh/empty [Unreleased] and no marker -- first-ever run.
    baseRef = getLastTag()
  }

  const subjects = getCommitSubjects(baseRef)
  const sections = buildSections(subjects)
  const count = Object.values(sections).reduce((s, a) => s + a.length, 0)

  let newLines
  if (appendMode) {
    mergeSections(parsedUnreleased, sections)
    newLines = serializeUnreleasedBody(parsedUnreleased, headSha)
  } else {
    // Full recompute: any pre-heading free text is kept, everything else is
    // replaced by the freshly computed section blocks.
    const blockLines = formatUnreleasedBlock(sections)
    const body = [...parsedUnreleased.preamble]
    if (body.length) body.push('')
    body.push(...blockLines)
    newLines = ['', `<!-- changelog-auto-sha: ${headSha} -->`, '', ...body, '']
  }

  if (unreleasedIdx >= 0) {
    versionSections[unreleasedIdx].lines = newLines
  } else {
    versionSections.unshift({ version: 'Unreleased', header: '## [Unreleased]', lines: newLines })
  }

  writeFileSync(changelogPath, serializeChangelog({ preamble, versionSections }))
  console.log(`[Unreleased] updated: ${count} entries from ${subjects.length} commits since ${baseRef ?? 'beginning'} (${appendMode ? 'incremental' : 'full recompute'}).`)
}
