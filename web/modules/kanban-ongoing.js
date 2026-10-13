// The "Ongoing" band: long-running cards that are always in flight (a standing
// duty, a recurring chore) and would otherwise sit in a status column for good.
//
// A card is ongoing when it is open (not in the done column) and carries a label
// whose name is in KANBAN_ONGOING_LABEL_NAMES, compared case-insensitively. To
// recognise one more name, add it to the list: that is the only place. Labels
// belong to a tenant, so matching by name stays inside the caller's own tenant.
//
// Pure functions: no DOM, no fetch.

export const KANBAN_ONGOING_LABEL_NAMES = ['folyamatos', 'ongoing']

function normalize(name) {
  return String(name ?? '').trim().toLowerCase()
}

/** True when a label name is one of the ongoing names. */
export function isOngoingLabelName(name, names = KANBAN_ONGOING_LABEL_NAMES) {
  const n = normalize(name)
  return n !== '' && names.some((x) => normalize(x) === n)
}

/** True when an open card carries an ongoing label. Done cards stay in Done. */
export function isOngoingCard(card, names = KANBAN_ONGOING_LABEL_NAMES) {
  if (!card || card.status === 'done') return false
  return (card.labels || []).some((l) => isOngoingLabelName(l?.name, names))
}
