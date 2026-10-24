// The loot phase a Log entry is for, so the Log can show it beside the entry and be filtered by it. Pure, no imports, so Node tests it.
//
// An entry only lists the fields that changed, and the phase of what it is about is not always one of them, so the phase is worked out from what the entry is
// about: an award or a priority as it stands now (an award's phase can be corrected, a priority's never changes), else from the entries about the same
// thing (a priority that was deleted is no longer there, but its first and last entries say its phase), else from the entry itself. A drop list entry carries
// its phase in its document id, and a phase started or reopened is for the phase the guild is in afterwards. An entry whose phase cannot be told is none.

type EntryLike = { targetType: string; targetId: string; rev: number; action: string; changed: string[]; before: Record<string, unknown>; after: Record<string, unknown> }

export type PhaseLookups = {
  /** The phase of an award as it stands now, or undefined when the award is not known. */
  awardPhase: (awardId: string) => number | undefined
  /** The phase of a priority as it stands now (a hidden one included), or undefined when it is gone. */
  priorityPhase: (priorityId: string) => number | undefined
  /** The phase the entries about a thing say (see phasesFromEntries), keyed like `phaseKey`. */
  fromEntries: (key: string) => number | undefined
}

const phaseNumber = (value: unknown) => (typeof value === 'number' && Number.isInteger(value) && value >= 0 ? value : undefined)

export const phaseKey = (targetType: string, targetId: string) => `${targetType}:${targetId}`

/** The phase in a drop list document's id: `p{phase}`, `z{zone}_{phase}` or `s{zone}_{key}_{phase}`. */
export function tableDocPhase(targetId: string): number | undefined {
  const match = /^p(\d+)$/.exec(targetId) ?? /^[zs].*_(\d+)$/.exec(targetId)
  return match ? Number(match[1]) : undefined
}

/**
 * What the loaded entries say about the phase of each award and priority they are about: a create entry lists the phase (none listed means the first phase,
 * as it does for a priority or an award with no phaseNo), and a delete entry lists what the priority had.
 */
export function phasesFromEntries(entries: readonly EntryLike[]): Map<string, number> {
  const known = new Map<string, number>()
  for (const entry of entries) {
    if (entry.targetType !== 'award' && entry.targetType !== 'priority') continue
    const listed = phaseNumber(entry.after.phaseNo) ?? phaseNumber(entry.before.phaseNo)
    if (listed !== undefined) known.set(phaseKey(entry.targetType, entry.targetId), listed)
    else if (entry.action === 'create' && !known.has(phaseKey(entry.targetType, entry.targetId))) known.set(phaseKey(entry.targetType, entry.targetId), 0)
  }
  return known
}

export function entryPhase(entry: EntryLike, lookups: PhaseLookups): number | undefined {
  if (entry.targetType === 'phase') {
    // The history after the change lists the finished phases, so its length is the number of the phase the guild is in; a history taken away is the first phase.
    if (Array.isArray(entry.after.phaseHistory)) return entry.after.phaseHistory.length
    return entry.changed.includes('phaseHistory') ? 0 : undefined
  }
  if (entry.targetType === 'table') return tableDocPhase(entry.targetId)
  const key = phaseKey(entry.targetType, entry.targetId)
  if (entry.targetType === 'award') {
    // An award from before the Log began (revision 0) has the phase it has now; one with none is in the first phase.
    return lookups.awardPhase(entry.targetId) ?? lookups.fromEntries(key) ?? (entry.rev === 0 ? 0 : undefined)
  }
  if (entry.targetType === 'priority') return lookups.priorityPhase(entry.targetId) ?? lookups.fromEntries(key)
  return undefined
}
