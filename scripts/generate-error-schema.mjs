// Updates the Error.error enum in docs/openapi.yaml from src/api-error-catalog.ts.
// Usage: node scripts/generate-error-schema.mjs
// Run automatically as part of npm run generate:sdk.
import { readFileSync, writeFileSync } from 'node:fs'

const src = readFileSync('src/api-error-catalog.ts', 'utf8')
const match = src.match(/ERROR_TOKENS = \[([\s\S]*?)\] as const/)
if (!match) { console.error('Cannot find ERROR_TOKENS array in src/api-error-catalog.ts'); process.exit(1) }
// Comments are cut BEFORE the tokens are read. The array carries explanatory `// ...` comments, and a comment may hold
// an apostrophe ("secret's"): matched on the raw text, that quote pairs with the opening quote of the NEXT token and
// yields a bogus token ("s grantee list does not ...") while the real token vanishes. It stayed hidden while the last
// array element was the only one after such a comment.
const body = match[1].replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '')
const tokens = (body.match(/'([^']+)'/g) ?? []).map(t => t.replace(/'/g, ''))
// Fail closed: the enum is the public contract, so a token that is not plain snake_case (or a duplicate) stops the
// run instead of being written into openapi.yaml.
const bad = tokens.filter(t => !/^[a-z][a-z0-9_]*$/.test(t))
if (bad.length) { console.error(`ERROR_TOKENS holds a value that is not a snake_case token: ${JSON.stringify(bad)}`); process.exit(1) }
if (new Set(tokens).size !== tokens.length) { console.error('ERROR_TOKENS holds a duplicate token'); process.exit(1) }

let yaml = readFileSync('docs/openapi.yaml', 'utf8')
const enumBlock = tokens.map(t => `            - ${t}`).join('\n')
yaml = yaml.replace(
  /(components:\n[\s\S]*?properties:\n\s+error:\n\s+type: string[\s\S]*?\n\s+enum:\n)([\s\S]*?)(\n\s+hint:)/,
  // $3 already carries the newline that separates the enum block from `hint:`
  // (its leading \n\s+ is what the regex anchors on) -- prepending another \n
  // here compounds by one blank line on every run, since the next run's lazy
  // $2 match absorbs the previous blank line into $3 instead of $2.
  `$1${enumBlock}$3`,
)
writeFileSync('docs/openapi.yaml', yaml)
console.log(`Updated openapi.yaml Error enum: ${tokens.length} tokens`)
