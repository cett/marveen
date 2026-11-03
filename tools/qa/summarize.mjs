#!/usr/bin/env node
// Prints a scanner report (promise-misuse-scan / vacuous-notthrow-scan JSON) as a Markdown list for the
// job summary: node tools/qa/summarize.mjs <report.json> >> "$GITHUB_STEP_SUMMARY"
import { readFileSync } from 'node:fs'
import process from 'node:process'

const file = process.argv[2]
if (!file) {
  process.stderr.write('usage: summarize.mjs <report.json>\n')
  process.exit(2)
}
const r = JSON.parse(readFileSync(file, 'utf8'))
const lines = [`### ${r.tool} (${r.mode}): ${r.total} finding(s)`, '']
for (const f of r.findings) lines.push(`- \`${f.file}:${f.line}\` [${f.kind}] \`${String(f.text).replace(/`/g, "'")}\``)
process.stdout.write(lines.join('\n') + '\n')
