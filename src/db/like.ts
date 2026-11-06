// db/like.ts -- the one place that turns the user's search text into a LIKE pattern.

/** The user's text with the LIKE wildcards (% and _) and the escape character itself escaped, for a
 *  LIKE ... ESCAPE '\' pattern. The one escape implementation: likeContains and likePrefix both use it. */
function escapeLikeText(text: string): string {
  return text.replace(/[\\%_]/g, (c) => `\\${c}`)
}

/** A "contains" pattern for LIKE ... ESCAPE '\': the wildcards of the user's text (% and _) and the escape
 *  character itself match literally, so a query of "%" or "_" is not a match-everything search. */
export function likeContains(text: string): string {
  return `%${escapeLikeText(text)}%`
}

/** A "starts with" pattern for LIKE ... ESCAPE '\': the text matches literally (a prefix of "a_" does not
 *  match "aX/..."), then anything may follow. An empty text is "%": every row. */
export function likePrefix(text: string): string {
  return `${escapeLikeText(text)}%`
}
