// Maps audit-table rows to OTLP log records (OTel H5a). Pure: rows in, JSON out, no I/O.
//
// What leaves the machine, per record: an event name, a severity, the time, and a handful of bounded
// identifiers (decision, role, permission, setting key, entity, action). What never does:
//   - content: config values (old_value / new_value), audit `detail`, approval `ref`, the raw request path;
//     the DB layer does not even select those columns (src/db/otel-logs.ts);
//   - a name: every actor (user, token, device, agent) is replaced by marveen.actor.hash, an HMAC with a
//     per-install salt, so the same actor is the same value across records but cannot be read back.
// A free-text column that the writer fills with a machine token (reason, event, key ...) is passed through
// token(), which keeps only a short run of identifier characters: anything else becomes '_other', so a value
// with spaces or a path in it cannot ride out as an attribute.

import { createHmac } from 'node:crypto'
import type {
  OtelLogRows, OtelLogSource, ApprovalEventLogRow, RbacDecisionLogRow, ConfigChangeExportRow, AgentAuditExportRow,
} from './db/otel-logs.js'

const SEVERITY_INFO = 9
const SEVERITY_WARN = 13

const TOKEN_RE = /^[A-Za-z0-9_.:-]{1,64}$/
const UNRESOLVED_TENANT = 'unresolved'
export const LOG_SCOPE_NAME = 'marveen.audit'

interface LogAttribute {
  key: string
  value: { stringValue?: string }
}

export interface OtelLogRecord {
  timeUnixNano: string
  observedTimeUnixNano: string
  severityNumber: number
  severityText: string
  body: { stringValue: string }
  attributes: LogAttribute[]
}

// A bounded machine token, or '_other'. Empty input has no token (null).
export function token(value: unknown): string | null {
  if (value === null || value === undefined) return null
  const s = String(value)
  if (s === '') return null
  return TOKEN_RE.test(s) ? s : '_other'
}

// Actor pseudonym: HMAC-SHA256(salt, actor), 16 hex chars. Null for an empty actor (nothing to pseudonymise).
export function actorHash(actor: unknown, salt: string): string | null {
  if (actor === null || actor === undefined || actor === '') return null
  return createHmac('sha256', salt).update(String(actor)).digest('hex').slice(0, 16)
}

function secToNano(sec: number): string {
  return (BigInt(Math.max(0, Math.floor(Number(sec) || 0))) * 1_000_000_000n).toString()
}

function attr(key: string, value: string | null): LogAttribute[] {
  return value === null ? [] : [{ key, value: { stringValue: value } }]
}

function record(
  eventName: string,
  severity: number,
  tsSec: number,
  observedNano: string,
  attributes: LogAttribute[],
): OtelLogRecord {
  return {
    timeUnixNano: secToNano(tsSec),
    observedTimeUnixNano: observedNano,
    severityNumber: severity,
    severityText: severity >= SEVERITY_WARN ? 'WARN' : 'INFO',
    body: { stringValue: eventName },
    attributes: [{ key: 'event.name', value: { stringValue: eventName } }, ...attributes],
  }
}

function tenantAttr(tenantId: string | null): LogAttribute[] {
  return attr('marveen.tenant.id', token(tenantId) ?? UNRESOLVED_TENANT)
}

function approvalRecord(r: ApprovalEventLogRow, salt: string, observed: string): OtelLogRecord {
  const event = token(r.event) ?? '_other'
  // A refusal is the signal an audit looks for; consume / decide events are routine.
  const refused = /refused|denied/.test(event)
  return record(`marveen.approval.${event}`, refused ? SEVERITY_WARN : SEVERITY_INFO, r.created_at, observed, [
    ...attr('marveen.approval.id', token(r.approval_id)),
    ...attr('marveen.approval.event', event),
    ...attr('marveen.approval.reason', token(r.reason)),
    ...attr('marveen.actor.hash', actorHash(r.actor, salt)),
    ...tenantAttr(r.tenant_id),
  ])
}

function rbacRecord(r: RbacDecisionLogRow, salt: string, observed: string): OtelLogRecord {
  const decision = token(r.decision) ?? '_other'
  return record(`marveen.rbac.${decision}`, SEVERITY_WARN, r.ts, observed, [
    ...attr('marveen.rbac.decision', decision),
    ...attr('http.request.method', token(r.method)),
    ...attr('marveen.rbac.permission', token(r.permission)),
    ...attr('marveen.rbac.role', token(r.role)),
    ...attr('marveen.rbac.reason', token(r.reason)),
    ...attr('marveen.principal.kind', token(r.principal_kind)),
    ...attr('marveen.actor.hash', actorHash(r.principal, salt)),
    ...tenantAttr(r.tenant_id),
  ])
}

function configRecord(r: ConfigChangeExportRow, salt: string, observed: string): OtelLogRecord {
  return record('marveen.config.changed', SEVERITY_INFO, r.created_at, observed, [
    ...attr('marveen.config.key', token(r.key)),
    ...attr('marveen.actor.hash', actorHash(r.actor, salt)),
  ])
}

function agentAuditRecord(r: AgentAuditExportRow, salt: string, observed: string): OtelLogRecord {
  const entity = token(r.entity) ?? '_other'
  const action = token(r.action) ?? '_other'
  return record(`marveen.audit.${entity}.${action}`, SEVERITY_INFO, r.created_at, observed, [
    ...attr('marveen.audit.entity', entity),
    ...attr('marveen.audit.action', action),
    // agent_audit_log.agent_id is an agent id OR the session user / token / device behind a request.
    ...attr('marveen.actor.hash', actorHash(r.agent_id, salt)),
  ])
}

export interface MappedLogBatch {
  records: OtelLogRecord[]
  // The highest row id included per source: the cursor to store once the collector has the batch.
  cursors: Partial<Record<OtelLogSource, number>>
}

export function mapLogBatch(rows: OtelLogRows, salt: string, nowMs: number = Date.now()): MappedLogBatch {
  const observed = (BigInt(Math.floor(nowMs)) * 1_000_000n).toString()
  const records: OtelLogRecord[] = []
  const cursors: Partial<Record<OtelLogSource, number>> = {}
  const take = <T extends { id: number }>(source: OtelLogSource, list: T[], map: (r: T) => OtelLogRecord) => {
    for (const r of list) records.push(map(r))
    if (list.length > 0) cursors[source] = list[list.length - 1].id
  }
  take('approval_events', rows.approval_events, (r) => approvalRecord(r, salt, observed))
  take('rbac_shadow_log', rows.rbac_shadow_log, (r) => rbacRecord(r, salt, observed))
  take('config_change_log', rows.config_change_log, (r) => configRecord(r, salt, observed))
  take('agent_audit_log', rows.agent_audit_log, (r) => agentAuditRecord(r, salt, observed))
  return { records, cursors }
}

export function logsToOtelJson(
  records: OtelLogRecord[],
  serviceNamespace: string,
  instanceId: string,
): { resourceLogs: unknown[] } {
  return {
    resourceLogs: [{
      resource: {
        attributes: [
          { key: 'service.name', value: { stringValue: 'marveen-dashboard' } },
          { key: 'service.namespace', value: { stringValue: serviceNamespace } },
          { key: 'service.instance.id', value: { stringValue: instanceId } },
        ],
      },
      scopeLogs: [{ scope: { name: LOG_SCOPE_NAME, version: '1' }, logRecords: records }],
    }],
  }
}
