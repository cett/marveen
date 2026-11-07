import type { SkillActor } from '../db/skill-revisions.js'
import type { RouteContext } from './routes/types.js'
import { OPERATOR_TOKEN_NAME } from '../reserved-token-names.js'

/**
 * Who a skill write made through a route is attributed to in skill_revisions.
 *
 * Only what the credential proves counts: a dashboard session is a person (the session user); a token that
 * belongs to an agent (tokenAgentId, set from the credential, never from the X-Agent-Id header the caller wrote
 * itself) is that agent; the operator's own named admin token is the operator; any other token is an agent
 * caller named by the token label when it has one (the legacy file-based dashboard token has no label, so no
 * name). Anything else that reached a skill write is 'system' with no name: honest "unknown" instead of a
 * made-up identity.
 *
 * The operator class comes from the credential row, not from the request: the token label is the api_tokens row
 * name, and the server reserves the exact name 'operator' (the admin API refuses to create a token with it, see
 * reserved-token-names.ts), so only the CLI-issued token carries it. A token that names an agent is an agent
 * first, whatever its label.
 */
export function skillActorFromRoute(ctx: Pick<RouteContext, 'auth' | 'tokenAgentId'>): SkillActor {
  const auth = ctx.auth
  if (auth?.kind === 'session' && auth.user) return { kind: 'human', id: auth.user }
  if (ctx.tokenAgentId) return { kind: 'agent', id: ctx.tokenAgentId }
  if (auth?.kind === 'token' && auth.tokenName === OPERATOR_TOKEN_NAME) return { kind: 'operator', id: OPERATOR_TOKEN_NAME }
  if (auth?.kind === 'token') return { kind: 'agent', id: auth.tokenName ?? null }
  return { kind: 'system', id: null }
}
