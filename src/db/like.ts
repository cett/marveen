// db/like.ts -- the one place that turns the user's search text into a LIKE pattern.

/** A "contains" pattern for LIKE ... ESCAPE '\': the wildcards of the user's text (% and _) and the escape
 *  character itself match literally, so a query of "%" or "_" is not a match-everything search. */
export function likeContains(text: string): string {
  return `%${text.replace(/[\\%_]/g, (c) => `\\${c}`)}%`
}
