// The argument rules of the HTTP MCP headers helper, in ONE place with no imports.
//
// The helper (http-mcp-header-helper.ts) refuses any argument outside these rules and then sends no
// Authorization at all. The migration (http-mcp-header-migrate.ts) writes the helper command into a config,
// so it must judge the very same rules: a command the helper refuses would be a silent loss of
// authentication. Keeping the rules here, and not in the helper (which imports the vault), lets the migration
// share them without pulling the vault into its import graph.

export const SECRET_ID = /^[A-Za-z0-9._-]{1,128}$/
export const HEADER_NAME = /^[A-Za-z0-9][A-Za-z0-9-]{0,63}$/
export const MAX_PREFIX = 32

/**
 * The text put before the secret value. Printable ASCII only: a control character in the prefix would be a
 * header-injection vector. At most MAX_PREFIX characters.
 */
export function isValidHelperPrefix(prefix: string): boolean {
  return prefix.length <= MAX_PREFIX && /^[\x20-\x7e]*$/.test(prefix)
}
