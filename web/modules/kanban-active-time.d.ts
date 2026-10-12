export interface StatusEvent {
  id?: number
  to_status: string
  created_at: number
}

export function sumInProgressSeconds(
  events: StatusEvent[],
  nowSec: number,
  card?: { status?: string; updated_at?: number },
): number | null

export function formatActiveTime(
  sec: number | null | undefined,
  t: (key: string, vars?: Record<string, unknown>) => string,
): string | null
