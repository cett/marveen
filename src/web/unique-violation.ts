// Recognises the SQLite UNIQUE failure of one column, so a route can answer a lost race with 409
// instead of letting the raw driver error become a 500. Anything else (another column, another
// constraint kind, a non-driver error) is not matched and keeps propagating.

export function isUniqueViolationOn(err: unknown, column: string): boolean {
  if (!(err instanceof Error)) return false
  const code = (err as Error & { code?: unknown }).code
  if (code !== 'SQLITE_CONSTRAINT_UNIQUE') return false
  return err.message.includes(`UNIQUE constraint failed: ${column}`)
}
