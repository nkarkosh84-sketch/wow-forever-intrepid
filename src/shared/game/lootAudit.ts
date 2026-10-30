// What the audit log says about loot. Every change to a priority or an award is written together with an entry in the log (see
// docs/design/audit-first-loot.md and the rules in firestore.rules); this file builds what the entry lists and reads an entry back. No
// imports, so Node runs its tests directly. The entry's own rules decide what is accepted: its `changed` list has to be exactly the fields that
// differ, with their old and new values, so these functions must agree with them.

// The fields an entry may list for a priority or an award. The stamps (rev, updatedBy, updatedAt, createdBy, createdAt) are never listed.
export const priorityAuditFields = ['item', 'encounter', 'rankedPlayers', 'rankedIds', 'councilNote', 'itemId', 'zoneId', 'npcId', 'phaseNo', 'carriedFrom', 'hidden'] as const
// The fields an entry may list for a loot table document (a zone, a creature or a phase; see shared/game/guildTables.ts).
export const tableAuditFields = ['type', 'zoneId', 'key', 'phaseNo', 'follows', 'name', 'kind', 'players', 'npcId', 'order', 'itemIds', 'hiddenItemIds', 'removed'] as const
// The settings fields a phase entry lists (when a phase is started or reopened, or the phase start dates change): the ones that differ, each with
// its old and new value.
export const phaseAuditFields = ['currentPhase', 'nextPhase', 'phaseHistory', 'phaseStarts'] as const
export const awardCreateFields = ['priorityId', 'item', 'encounter', 'recipient', 'recipientId', 'awardedAt', 'prioritySnapshot', 'prioritySnapshotIds', 'councilNoteSnapshot', 'awardNote', 'phaseNo'] as const
// A manual award (no priority, LOOT-002) lists every field it has when it is made, how it was decided included. The rules require the entry's `changed` list to be
// exactly these, so this is not awardCreateFields with one more field: an award from a priority has a priority and a snapshot, and no `decision`.
export const manualAwardCreateFields = ['item', 'encounter', 'recipient', 'recipientId', 'awardedAt', 'awardNote', 'decision', 'phaseNo'] as const
// The fields a leader can correct, remove or restore on an award (LOOT-004). The snapshot fields (the candidate order and council note at decision time),
// the priority and the item are never changed: an award of the wrong item is removed and recorded again.
export const awardEditFields = ['recipient', 'recipientId', 'awardedAt', 'awardNote', 'decision', 'phaseNo', 'status', 'removedReason'] as const

type Values = Record<string, unknown>

export function sameValue(a: unknown, b: unknown): boolean {
  if (Array.isArray(a) || Array.isArray(b)) return Array.isArray(a) && Array.isArray(b) && a.length === b.length && a.every((value, index) => sameValue(value, b[index]))
  return a === b
}

/** A new document: every field it has is listed, with its value. A field that is undefined is not a field (Firestore refuses one). */
export function describeCreate(fields: Values, listed: readonly string[]) {
  const present = listed.filter((key) => fields[key] !== undefined)
  return { changed: present, after: Object.fromEntries(present.map((key) => [key, fields[key]])) }
}

/**
 * A change to a document: the listed fields whose value differs, with the old and new value. A new value of undefined takes the field away
 * (the entry says null). Nothing differing gives null: there is no change to log.
 */
export function describeEdit(current: Values, changes: Values, listed: readonly string[]) {
  const changed = listed.filter((key) => key in changes && !sameValue(current[key] ?? undefined, changes[key]))
  if (!changed.length) return null
  return {
    changed,
    before: Object.fromEntries(changed.map((key) => [key, current[key] ?? null])),
    after: Object.fromEntries(changed.map((key) => [key, changes[key] ?? null])),
  }
}

/** A deleted document: every listed field it had, with its value. */
export function describeDelete(current: Values, listed: readonly string[]) {
  const present = listed.filter((key) => current[key] !== undefined)
  return { changed: present, before: Object.fromEntries(present.map((key) => [key, current[key]])) }
}

export type AuditTarget = 'award' | 'priority' | 'raid' | 'phase' | 'table'
export type AuditEntry = {
  id: string
  at: Date | null
  by: string
  byName: string
  targetType: string
  targetId: string
  rev: number
  action: string
  item: string
  changed: string[]
  before: Values
  after: Values
  reason: string
}

const text = (value: unknown) => (typeof value === 'string' ? value : '')
const map = (value: unknown): Values => (value && typeof value === 'object' && !Array.isArray(value) ? (value as Values) : {})

/**
 * An award as it was first recorded: what it says now, with the old value of every field that a later entry changed (the oldest entry's old value wins;
 * a field that did not exist then is taken away). An award from before the Log began has no entry of its own, so the Log builds its first row from this
 * and a correction cannot rewrite what that row says.
 */
export function awardAsRecorded<A extends { id: string }>(award: A, entries: { targetType: string; targetId: string; rev: number; changed: string[]; before: Values }[]): A {
  const original: Values = {}
  const later = entries.filter((entry) => entry.targetType === 'award' && entry.targetId === award.id).sort((a, b) => a.rev - b.rev)
  for (const entry of later) for (const field of entry.changed) if (!(field in original)) original[field] = entry.before[field] ?? undefined
  return { ...award, ...original }
}

/**
 * Whether an award was made before the Log began (so no entry of its own describes it). Every award the app records has both a revision and a creator, and
 * a correction gives an old award a revision but never a creator, so an award lacking either is an old one and must stay in the Log after it is corrected.
 */
export const isLegacyAward = (award: { rev?: number; createdBy?: string }) => award.rev === undefined || award.createdBy === undefined

/**
 * Whether the first row of an award from before the Log began cannot be trusted yet: it was fixed since (so it has a revision), the Log has older entries it has not
 * loaded, and the first fix's entry is not among those it has. Without that entry the row can only show the award as it is now, not as it was first recorded.
 */
export function legacyRowUncertain(award: { id: string; rev?: number; createdBy?: string }, entries: readonly { targetType: string; targetId: string; rev: number }[], moreToLoad: boolean): boolean {
  return isLegacyAward(award) && award.rev !== undefined && moreToLoad && !entries.some((entry) => entry.targetType === 'award' && entry.targetId === award.id && entry.rev === 1)
}

/** An award made before the Log began has no entry; the Log shows it as an entry of its own (revision 0), dated the raid night. */
export function legacyAwardEntry(award: { id: string; priorityId?: string; item: string; encounter: string; recipient: string; awardedAt: string; prioritySnapshot?: string[]; councilNoteSnapshot?: string; awardNote?: string; phaseNo?: number }): AuditEntry {
  const fields: Values = { priorityId: award.priorityId, item: award.item, encounter: award.encounter, recipient: award.recipient, awardedAt: award.awardedAt, prioritySnapshot: award.prioritySnapshot, councilNoteSnapshot: award.councilNoteSnapshot, awardNote: award.awardNote, phaseNo: award.phaseNo }
  const { changed, after } = describeCreate(fields, awardCreateFields)
  const at = new Date(`${award.awardedAt}T12:00:00`)
  return { id: `before-${award.id}`, at: Number.isNaN(at.getTime()) ? null : at, by: '', byName: '', targetType: 'award', targetId: award.id, rev: 0, action: 'create', item: award.item, changed, before: {}, after, reason: '' }
}

/** Reads an entry tolerantly: a missing or odd field becomes empty, an entry with no target is dropped. Never throws. */
export function readAuditEntry(id: string, data: Values): AuditEntry | null {
  if (!id || typeof data.targetType !== 'string' || typeof data.targetId !== 'string') return null
  const stamp = data.at as { toDate?: () => Date } | null | undefined
  const at = stamp && typeof stamp.toDate === 'function' ? stamp.toDate() : null
  return {
    id,
    at: at && !Number.isNaN(at.getTime()) ? at : null,
    by: text(data.by),
    byName: text(data.byName),
    targetType: data.targetType,
    targetId: data.targetId,
    rev: typeof data.rev === 'number' ? data.rev : 0,
    action: text(data.action),
    item: text(data.item),
    changed: Array.isArray(data.changed) ? data.changed.filter((key): key is string => typeof key === 'string') : [],
    before: map(data.before),
    after: map(data.after),
    reason: text(data.reason),
  }
}
