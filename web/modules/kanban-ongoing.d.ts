export const KANBAN_ONGOING_LABEL_NAMES: string[]

export function isOngoingLabelName(name: unknown, names?: string[]): boolean

export function isOngoingCard(
  card: { status?: string; labels?: Array<{ name?: string | null }> | null } | null | undefined,
  names?: string[],
): boolean
