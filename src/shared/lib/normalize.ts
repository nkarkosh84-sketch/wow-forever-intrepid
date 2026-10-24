import type { AwardRecord, GuildSettingsRecord, JoinRequestRecord, MembershipRecord, PlayerRecord, PriorityRecord } from '../../guildApi'
import { guildRoles, type GuildRole } from '../../security'
import { readTableDoc, type LootTableDoc } from '../game/guildTables'
import { withoutBadPhaseFields } from '../game/phases'
import { resolveGuildSettings } from '../game/settings'

// Tolerant readers for the five collections whose documents the Firestore rules do not validate:
// roster, lootPriorities, awards, members and joinRequests. A document is read as `{ ...data, id }`,
// exactly as before, and then only the fields the UI dereferences are checked: a missing or wrongly
// typed text field becomes '', a missing or wrongly typed list becomes [] and non-string list entries
// are dropped. Every other field (extra, unknown, optional) passes through untouched, so a valid
// document comes back deep-equal to what it was. A normalizer returns null for a document it cannot
// salvage; the caller skips it and counts it (see normalizeDocs). Normalizers never throw.
//
// When a feature starts reading a new field from one of these collections, add it here.

export type RawDoc = Record<string, unknown>
export type Normalizer<T> = (id: string, data: RawDoc) => T | null

const isText = (value: unknown): value is string => typeof value === 'string'
const text = (value: unknown) => (typeof value === 'string' ? value : '')

function strings(value: unknown): string[] {
  if (!Array.isArray(value)) return []
  return value.every(isText) ? value : value.filter(isText)
}

const isGuildRole = (value: unknown): value is GuildRole => guildRoles.includes(value as GuildRole)
const requestStatuses: readonly unknown[] = ['pending', 'approved', 'rejected'] satisfies JoinRequestRecord['status'][]

// A character whose name is missing or not text is dropped: every list, team card and dropdown is keyed on
// it. A name that is text is kept as it is even when blank, because the Add and Edit dialogs can save one
// (they trim the input, but the required check runs before the trim).
// A role the UI does not know (anything but Tank, Healer, Melee or Ranged) is passed through as a string.
export function normalizePlayer(id: string, data: RawDoc): PlayerRecord | null {
  if (!id || !isText(data.name)) return null
  const player = { ...data, id, className: text(data.className), specialization: text(data.specialization), role: text(data.role) } as PlayerRecord
  if (data.linkedUid != null && !isText(data.linkedUid)) delete player.linkedUid
  if (data.mainId != null && !isText(data.mainId)) delete player.mainId
  if (data.surname != null && !isText(data.surname)) delete player.surname
  return player
}

// A priority whose item is missing or not text is dropped. A blank item text is kept (the Add dialog can save one).
// itemId, zoneId and npcId are optional: one that is not a positive whole number is removed rather than trusted.
export function normalizePriority(id: string, data: RawDoc): PriorityRecord | null {
  if (!id || !isText(data.item)) return null
  const priority = { ...data, id, encounter: text(data.encounter), rankedPlayers: strings(data.rankedPlayers), councilNote: text(data.councilNote) } as PriorityRecord
  for (const key of ['itemId', 'zoneId', 'npcId'] as const) {
    const value = data[key]
    if (value !== undefined && !(typeof value === 'number' && Number.isInteger(value) && value > 0)) delete priority[key]
  }
  // rankedIds (what each candidate line is, see shared/game/candidates.ts) is kept only as a list of text as long as the names; anything else is removed
  // and the priority reads as names only.
  if (!Array.isArray(data.rankedIds) || data.rankedIds.length !== priority.rankedPlayers.length || !data.rankedIds.every(isText)) delete priority.rankedIds
  // phaseNo is a whole number of 0 or more and carriedFrom the id of another priority; one that is not is removed (no phaseNo means the first phase).
  // hidden (a priority taken off the list but kept) is only ever true; anything else is removed.
  if (data.hidden !== undefined && data.hidden !== true) delete priority.hidden
  return withoutBadPhaseFields(priority)
}

// An award whose item is missing or not text is dropped. A blank item text is kept: awards are the permanent
// record and are copied from a priority, so one with a blank item can exist. A missing or non-string awardedAt
// becomes '' and the history row shows an invalid date instead of the whole list failing.
export function normalizeAward(id: string, data: RawDoc): AwardRecord | null {
  if (!id || !isText(data.item)) return null
  const award = withoutBadPhaseFields({
    ...data,
    id,
    priorityId: text(data.priorityId),
    encounter: text(data.encounter),
    recipient: text(data.recipient),
    awardedAt: text(data.awardedAt),
    prioritySnapshot: strings(data.prioritySnapshot),
    councilNoteSnapshot: text(data.councilNoteSnapshot),
    awardNote: text(data.awardNote),
  } as AwardRecord)
  // recipientId is kept only as text that says something, prioritySnapshotIds only as a list of text (see PriorityRecord.rankedIds).
  if (!isText(data.recipientId) || data.recipientId === '') delete award.recipientId
  if (!Array.isArray(data.prioritySnapshotIds) || !data.prioritySnapshotIds.every(isText)) delete award.prioritySnapshotIds
  // status is 'active' or 'removed' (none means active), removedReason is text, decision is one of the three ways a manual award is decided, createdBy is
  // text; anything else is taken away, so an odd value can never make an award count or look removed by accident.
  if (data.status !== undefined && data.status !== 'active' && data.status !== 'removed') delete award.status
  if (data.removedReason !== undefined && !isText(data.removedReason)) delete award.removedReason
  if (data.decision !== undefined && data.decision !== 'roll' && data.decision !== 'council' && data.decision !== 'other') delete award.decision
  if (data.createdBy !== undefined && !isText(data.createdBy)) delete award.createdBy
  return award
}

// A member whose role is not a guild role or Removed is dropped: the access table would otherwise
// show the first role in the list for it, and the rules give such an account no access anyway.
export function normalizeMember(id: string, data: RawDoc): MembershipRecord | null {
  if (!id || (!isGuildRole(data.role) && data.role !== 'Removed')) return null
  const member = { ...data, id, email: text(data.email), displayName: text(data.displayName) } as MembershipRecord
  if (data.playerId != null && !isText(data.playerId)) member.playerId = null
  return member
}

// A request whose status is not pending, approved or rejected is dropped. userId is always the document
// id: the rules make the two equal, and approving or declining acts on that uid.
export function normalizeJoinRequest(id: string, data: RawDoc): JoinRequestRecord | null {
  if (!id || !requestStatuses.includes(data.status)) return null
  return { ...data, id, userId: id, email: text(data.email), displayName: text(data.displayName) } as JoinRequestRecord
}

// A loot table document (the guild's own additions to the drop lists) is read by readTableDoc: lists keep only whole item numbers, and one that
// fits no id of its own is dropped.
export const normalizeLootTable: Normalizer<LootTableDoc> = (id, data) => readTableDoc(id, data)

// A settings document is never dropped: any field that cannot be read falls back to its default.
export function normalizeSettings(id: string, data: RawDoc): GuildSettingsRecord {
  return { ...resolveGuildSettings(data), id }
}

// Applies a normalizer to a snapshot's documents. Returns the records that could be read and the ids of
// the documents that could not (a normalizer returning null, or throwing despite the promise above).
export function normalizeDocs<T>(docs: Iterable<{ id: string; data: () => RawDoc }>, normalize: Normalizer<T>) {
  const records: T[] = []
  const droppedIds: string[] = []
  for (const doc of docs) {
    let record: T | null = null
    try {
      record = normalize(doc.id, doc.data())
    } catch {
      record = null
    }
    if (record === null) droppedIds.push(doc.id)
    else records.push(record)
  }
  return { records, droppedIds }
}
