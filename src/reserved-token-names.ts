// Names the server gives its own api tokens (agent-tokens issue / rotate-shared, the dashboard token bootstrap).
// A token created through the admin API must not carry one of them: `agent-tokens check` looks tokens up by
// name (a second active row under `main-agent:<id>` is reported as multiple_active, and the suggested
// `issue --rotate` revokes it together with the real one), and the token name is the audit principal, so a
// look-alike name would let an admin token write audit entries that read as another identity.

export const MAIN_AGENT_TOKEN_PREFIX = 'main-agent:'
export const FLEET_AGENT_TOKEN_PREFIX = 'fleet-agent:'
export const OPERATOR_TOKEN_NAME = 'operator'
export const DASHBOARD_TOKEN_NAME = 'dashboard'

const RESERVED_NAMES: readonly string[] = [OPERATOR_TOKEN_NAME, DASHBOARD_TOKEN_NAME]
const RESERVED_PREFIXES: readonly string[] = [MAIN_AGENT_TOKEN_PREFIX, FLEET_AGENT_TOKEN_PREFIX]

// Characters that read as a hyphen or a colon: hyphen, non-breaking hyphen, en and em dash, minus sign
// (all -> '-'); ratio, modifier letter colon, Armenian full stop (all -> ':').
const HYPHEN_LOOKALIKES = /[\u2010\u2011\u2013\u2014\u2212]/g
const COLON_LOOKALIKES = /[\u2236\uA789\u0589]/g
// Characters that render as nothing or as blank space but are not whitespace or format characters:
// combining marks (also the variation selectors and the combining grapheme joiner), the Hangul fillers and
// the braille blank. NFKC already folds U+3164 and U+FFA0 to U+1160 and U+2011 to U+2010; they stay listed so
// the class does not depend on that.
const INVISIBLE_FILLERS = /[\p{M}\u3164\u115F\u1160\uFFA0\u2800]/gu

/**
 * True when `name` is one of the server's token names or starts with one of its prefixes, regardless of
 * letter case, of any whitespace (also inside the name), of invisible format characters and fillers and of
 * hyphen or colon look-alikes; NFKC folds look-alike forms such as full-width letters. Only the comparison
 * is folded, the stored name is not changed. Visual homoglyphs from another script (Cyrillic or Greek
 * letters) are NOT caught: that needs a confusables skeleton. The effect is limited to how an audit entry
 * reads, the name check of `agent-tokens` itself is an exact match.
 */
export function isReservedTokenName(name: string): boolean {
  const folded = name.normalize('NFKC').toLowerCase()
    .replace(HYPHEN_LOOKALIKES, '-')
    .replace(COLON_LOOKALIKES, ':')
    .replace(/[\s\p{Cf}]/gu, '')
    .replace(INVISIBLE_FILLERS, '')
  return RESERVED_NAMES.includes(folded) || RESERVED_PREFIXES.some(prefix => folded.startsWith(prefix))
}
