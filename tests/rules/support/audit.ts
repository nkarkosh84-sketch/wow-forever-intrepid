// Builders shared by the audit log tests: one batch that edits (or creates, or deletes) an award or a priority
// together with an audit entry for it. Everything is honest unless a test overrides a field, so a test can break
// exactly one thing and see what the rules do. See audit.test.ts and audit-details.test.ts.
import { deleteField, serverTimestamp, setDoc, writeBatch, type DocumentData, type Firestore, type WriteBatch } from 'firebase/firestore'
import { PLAYER_1, PLAYER_2, PLAYER_3, PRIORITY_ID, UID, awardDoc, displayNameOf, priorityDoc, rosterDoc } from './fixtures.ts'
import { asAdmin, guildDoc, stored } from './harness.ts'

export const AWARD = 'award-1' // seeded without any of the new fields, like every award written before this change
export type Staff = 'raidLeader' | 'guildLeader'
export type TargetType = 'award' | 'priority' | 'phase' | 'table'

/** Firestore refuses `undefined`, so a field a test wants missing is passed as undefined and dropped here. */
export const clean = (data: DocumentData): DocumentData => Object.fromEntries(Object.entries(data).filter(([, value]) => value !== undefined))

export const entryId = (type: TargetType, id: string, rev: number) => `${type}_${id}_${rev}`

/** What an honest entry says about a change: the fields, with the values the stored document has and will have. */
export function describeChange(current: DocumentData | undefined, changes: DocumentData): DocumentData {
  const keys = Object.keys(changes)
  return { changed: keys, before: Object.fromEntries(keys.map((key) => [key, current?.[key] ?? null])), after: changes }
}

/** An audit entry as `who` would write it. Everything is valid unless a test overrides a field. */
export function entry(who: Staff, type: TargetType, id: string, rev: number, overrides: DocumentData = {}): DocumentData {
  return { at: serverTimestamp(), by: UID[who], byName: displayNameOf(UID[who]), targetType: type, targetId: id, rev, action: 'edit', item: 'Test Sword', changed: [], ...overrides }
}

/** What an award edit has to carry besides the changed fields. */
export const stamp = (who: Staff, rev: number): DocumentData => ({ rev, updatedBy: UID[who], updatedAt: serverTimestamp() })

/** An entry that says nothing changed, for edits that touch only stamp fields (createdBy, createdAt) the log does not list. */
export const NOTHING = { changed: [], before: {}, after: {} }

export type EditOptions = {
  awardId?: string
  rev?: number
  changes?: DocumentData
  award?: DocumentData // overrides for the award update
  audit?: DocumentData // overrides for the entry
  skipEntry?: boolean
  skipAward?: boolean
  entryKey?: string
  extraEntries?: [string, DocumentData][]
}

/** One batch: the award edit plus an honest entry for it. Either part can be changed or left out. */
export async function editAward(
  db: Firestore,
  who: Staff,
  { awardId = AWARD, rev = 1, changes = { recipient: PLAYER_3 }, award = {}, audit = {}, skipEntry = false, skipAward = false, entryKey, extraEntries = [] }: EditOptions = {},
) {
  const current = await stored(`awards/${awardId}`)
  const batch = writeBatch(db)
  if (!skipAward) batch.update(guildDoc(db, `awards/${awardId}`), clean({ ...changes, ...stamp(who, rev), ...award }))
  if (!skipEntry) {
    const data = entry(who, 'award', awardId, rev, { item: current?.item, ...describeChange(current, changes), ...audit })
    batch.set(guildDoc(db, `auditLog/${entryKey ?? entryId('award', awardId, rev)}`), clean(data))
  }
  for (const [id, data] of extraEntries) batch.set(guildDoc(db, `auditLog/${id}`), clean(data))
  return batch.commit()
}

/** What a new award made from the seeded priority is: the priority's copy, filed under the first phase (the seeded priority has none). */
export const newAwardDoc = (overrides: DocumentData = {}): DocumentData => awardDoc({ phaseNo: 0, ...overrides })

/** Create an award made from a priority, at revision 1, with its create entry. Honest unless a test overrides a part or leaves the entry out. */
export function createAward(
  db: Firestore,
  who: Staff,
  { id = 'award-new', fields = newAwardDoc(), award = {}, audit = {}, entryKey, skipEntry = false }: { id?: string; fields?: DocumentData; award?: DocumentData; audit?: DocumentData; entryKey?: string; skipEntry?: boolean } = {},
) {
  const batch = writeBatch(db)
  batch.set(guildDoc(db, `awards/${id}`), clean({ ...fields, rev: 1, createdBy: UID[who], createdAt: serverTimestamp(), ...award }))
  if (!skipEntry) batch.set(guildDoc(db, `auditLog/${entryKey ?? entryId('award', id, 1)}`), clean(entry(who, 'award', id, 1, { action: 'create', item: fields.item, ...describeChange(undefined, fields), ...audit })))
  return batch.commit()
}

export const MANUAL = 'award-manual'

/** A manual award (no priority): the seeded roster character PLAYER_2, decided by a roll. Valid unless a test overrides a field. */
export const manualAwardDoc = (overrides: DocumentData = {}): DocumentData => ({
  item: 'Test Sword', encounter: 'Test Boss', recipient: rosterDoc(2).name, recipientId: PLAYER_2, awardedAt: '2026-12-09', awardNote: '', decision: 'roll', phaseNo: 0, ...overrides,
})

/** Create a manual award at revision 1 with its create entry. Honest unless a test overrides a part, or leaves the entry out. */
export function createManualAward(
  db: Firestore,
  who: Staff,
  { id = MANUAL, fields = manualAwardDoc(), award = {}, audit = {}, entryKey, skipEntry = false }: { id?: string; fields?: DocumentData; award?: DocumentData; audit?: DocumentData; entryKey?: string; skipEntry?: boolean } = {},
) {
  const batch = writeBatch(db)
  batch.set(guildDoc(db, `awards/${id}`), clean({ ...fields, rev: 1, createdBy: UID[who], createdAt: serverTimestamp(), ...award }))
  if (!skipEntry) batch.set(guildDoc(db, `auditLog/${entryKey ?? entryId('award', id, 1)}`), clean(entry(who, 'award', id, 1, { action: 'create', item: fields.item, ...describeChange(undefined, fields), ...audit })))
  return batch.commit()
}

/** Update a priority and file an entry for it, as the rules require: the revision and the stamps go up with it and the entry tells the truth. */
export async function editPriority(
  db: Firestore,
  who: Staff,
  { id = PRIORITY_ID, rev = 1, changes = { councilNote: 'Rewritten note' }, priority = {}, audit = {}, entryKey, action = 'edit', skipEntry = false }: { id?: string; rev?: number; changes?: DocumentData; priority?: DocumentData; audit?: DocumentData; entryKey?: string; action?: string; skipEntry?: boolean } = {},
) {
  const current = await stored(`lootPriorities/${id}`)
  const batch = writeBatch(db)
  batch.update(guildDoc(db, `lootPriorities/${id}`), clean({ ...changes, ...stamp(who, rev), ...priority }))
  if (!skipEntry) batch.set(guildDoc(db, `auditLog/${entryKey ?? entryId('priority', id, rev)}`), clean(entry(who, 'priority', id, rev, { action, item: current?.item, ...describeChange(current, changes), ...audit })))
  return batch.commit()
}

/** Reorder a priority and log it as a reorder. */
export const reorderPriority = (db: Firestore, who: Staff, { order = [PLAYER_3, PLAYER_2, PLAYER_1], ...rest }: { id?: string; rev?: number; audit?: DocumentData; entryKey?: string; order?: string[] } = {}) =>
  editPriority(db, who, { ...rest, changes: { rankedPlayers: order }, action: 'reorder' })

/** A new priority as the app writes it: the seeded one's fields, filed under the first phase. */
export const newPriorityDoc = (overrides: DocumentData = {}): DocumentData => priorityDoc({ phaseNo: 0, ...overrides })

/** Create a priority at revision 1 with its create entry (honest unless overridden). */
export function createPriority(db: Firestore, who: Staff, { id = 'priority-2', fields = newPriorityDoc(), priority = {}, audit = {}, entryKey, skipEntry = false }: { id?: string; fields?: DocumentData; priority?: DocumentData; audit?: DocumentData; entryKey?: string; skipEntry?: boolean } = {}) {
  const batch = writeBatch(db)
  batch.set(guildDoc(db, `lootPriorities/${id}`), clean({ ...fields, rev: 1, updatedBy: UID[who], updatedAt: serverTimestamp(), ...priority }))
  if (!skipEntry) batch.set(guildDoc(db, `auditLog/${entryKey ?? entryId('priority', id, 1)}`), clean(entry(who, 'priority', id, 1, { action: 'create', item: fields.item, ...describeChange(undefined, fields), ...audit })))
  return batch.commit()
}
/** Delete the seeded priority (or another) and file a delete entry (honest unless overridden). */
export async function deletePriority(db: Firestore, who: Staff, { id = PRIORITY_ID, rev = 1, audit = {}, skipEntry = false }: { id?: string; rev?: number; audit?: DocumentData; skipEntry?: boolean } = {}) {
  const current = await stored(`lootPriorities/${id}`)
  const batch = writeBatch(db)
  batch.delete(guildDoc(db, `lootPriorities/${id}`))
  // The entry lists what the document had, except the stamps the log does not list.
  const listed = Object.keys(current ?? {}).filter((key) => !['rev', 'updatedBy', 'updatedAt', 'createdBy', 'createdAt'].includes(key))
  if (!skipEntry) batch.set(guildDoc(db, `auditLog/${entryId('priority', id, rev)}`), clean(entry(who, 'priority', id, rev, { action: 'delete', item: current?.item, changed: listed, before: Object.fromEntries(listed.map((key) => [key, current?.[key]])), ...audit })))
  return batch.commit()
}

export const stampedAward = (overrides: DocumentData = {}) =>
  awardDoc({ rev: 3, createdBy: UID.raidLeader, createdAt: new Date('2026-12-09T20:00:00Z'), updatedBy: UID.raidLeader, updatedAt: new Date('2026-12-09T21:00:00Z'), ...overrides })
export const removedAward = (overrides: DocumentData = {}) => awardDoc({ rev: 1, status: 'removed', removedReason: 'Entered by mistake', ...overrides })

export { priorityDoc }

/** The settings fields a phase entry lists (the start dates since RAID-019). */
export const PHASE_FIELDS = ['currentPhase', 'nextPhase', 'phaseHistory', 'phaseStarts'] as const

export type PhaseChangeOptions = {
  into?: WriteBatch // add the writes to this batch and leave committing it to the caller
  settings: DocumentData // the whole settings document the batch stores (without phaseRev)
  rev?: number // the revision the document and the entry carry
  action?: string
  audit?: DocumentData // overrides for the entry
  doc?: DocumentData // overrides for the settings document
  entryKey?: string
  skipEntry?: boolean
  extraEntries?: [string, DocumentData][] // more entries in the same batch
}

/**
 * Start or reopen a loot phase, or change the phase start dates (action 'edit'): the settings document and its entry (phase_settings_{rev}) in one
 * batch. The entry lists the phase fields that differ between what is stored now (nothing on a first save) and what the batch stores, as the rules
 * require. Honest unless overridden.
 */
export async function changePhase(db: Firestore, who: Staff, { into, settings, rev = 1, action = 'start', audit = {}, doc = {}, entryKey, skipEntry = false, extraEntries = [] }: PhaseChangeOptions) {
  const current = await stored('settings/general')
  const same = (a: unknown, b: unknown) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null)
  const changed = PHASE_FIELDS.filter((field) => !same(current?.[field], settings[field]))
  const batch = into ?? writeBatch(db)
  batch.set(guildDoc(db, 'settings/general'), clean({ ...settings, phaseRev: rev, ...doc }))
  if (!skipEntry) {
    batch.set(guildDoc(db, `auditLog/${entryKey ?? entryId('phase', 'settings', rev)}`), clean(entry(who, 'phase', 'settings', rev, {
      action,
      item: settings.currentPhase,
      changed,
      before: Object.fromEntries(changed.map((field) => [field, current?.[field] ?? null])),
      after: Object.fromEntries(changed.map((field) => [field, settings[field] ?? null])),
      ...audit,
    })))
  }
  for (const [id, data] of extraEntries) batch.set(guildDoc(db, `auditLog/${id}`), clean(data))
  return into ? undefined : batch.commit()
}

// Loot tables (the lootTables collection). Four kinds of document, all filed under the loot phase they were written in (`phaseNo`) and all saying
// only what their phase changes: a zone (type 'zone') the guild made, whose number is 50 million or more; a "presence" document (type 'zone', a
// number below that), which only says whether a zone of the built-in captures is in the lists; a creature or the zone-wide list (type 'source'); and
// the phase itself (type 'phase'), which says which earlier phase it follows.
// The id comes from the fields: z{zoneId}_{phaseNo}, s{zoneId}_{key}_{phaseNo} and p{phaseNo}. See loot-tables.test.ts and phase-follow.test.ts.

export const ZONE_NO = 60_000_001 // a custom zone: numbers from 50 million up are the guild's own
export const BUILT_IN_ZONE_NO = 1581 // a zone of the built-in captures
export const NPC_KEY = 'npc4887' // a creature of the built-in captures
export const zoneTableId = (zoneId: unknown, phaseNo: unknown) => `z${zoneId}_${phaseNo}`
export const sourceTableId = (zoneId: unknown, key: unknown, phaseNo: unknown) => `s${zoneId}_${key}_${phaseNo}`
/** The id the rules require for a new document: the one its fields make. */
export const phaseTableId = (phaseNo: unknown) => `p${phaseNo}`
export const tableIdOf = (fields: DocumentData): string => (fields.type === 'source' ? sourceTableId(fields.zoneId, fields.key, fields.phaseNo) : fields.type === 'phase' ? phaseTableId(fields.phaseNo) : zoneTableId(fields.zoneId, fields.phaseNo))

export const ZONE_TABLE = zoneTableId(ZONE_NO, 0)
export const PRESENCE_TABLE = zoneTableId(BUILT_IN_ZONE_NO, 0)
export const SOURCE_TABLE = sourceTableId(ZONE_NO, 'c1', 0)
export const BUILT_IN_SOURCE_TABLE = sourceTableId(BUILT_IN_ZONE_NO, NPC_KEY, 0)

/** The first document of a zone the guild adds: its name, kind and size. */
export const zoneTableDoc = (overrides: DocumentData = {}): DocumentData => ({ type: 'zone', zoneId: ZONE_NO, phaseNo: 0, name: 'Test Hollow', kind: 'dungeon', players: 5, ...overrides })
/** A zone of the built-in captures taken out of the lists (`removed: true`) from this phase on. */
export const presenceTableDoc = (overrides: DocumentData = {}): DocumentData => ({ type: 'zone', zoneId: BUILT_IN_ZONE_NO, phaseNo: 0, removed: true, ...overrides })
/** The first document of a creature the guild adds, with two items. */
export const sourceTableDoc = (overrides: DocumentData = {}): DocumentData => ({ type: 'source', zoneId: ZONE_NO, key: 'c1', phaseNo: 0, name: 'Test Boss', kind: 'boss', order: 10, itemIds: [1111, 2222], hiddenItemIds: [], ...overrides })
/** What a phase changes about a creature of the built-in captures: items added and items taken off, and nothing else (no name, no number). */
export const overlayTableDoc = (overrides: DocumentData = {}): DocumentData => ({ type: 'source', zoneId: BUILT_IN_ZONE_NO, key: NPC_KEY, phaseNo: 0, itemIds: [3333], hiddenItemIds: [4444], ...overrides })

/** The document of a phase: phase 1 follows phase 0. */
export const phaseTableDoc = (overrides: DocumentData = {}): DocumentData => ({ type: 'phase', phaseNo: 1, follows: 0, ...overrides })

/** Put the guild in phase `n`: n finished phases in its settings (none stored means phase 0). */
export const inPhase = (n: number) => asAdmin((db) => setDoc(guildDoc(db, 'settings/general'), { currentPhase: `Phase ${n}`, nextPhase: 'Next', phaseHistory: Array.from({ length: n }, (_, index) => `Earlier ${index}`) }))

/** Store a table document as an earlier write left it (by someone who is none of the personas, so a stamp a test leaves out is not the stored one). */
export const storeTable = (id: string, fields: DocumentData, rev = 1) =>
  asAdmin((db) => setDoc(guildDoc(db, `lootTables/${id}`), clean({ ...fields, rev, updatedBy: 'uid-earlier-editor', updatedAt: new Date('2026-12-01T00:00:00Z') })))

/** In a `changes` object, a field to take away (an update with deleteField(), and `null` in the entry). */
export const GONE = Symbol('taken away')
const sent = (data: DocumentData): DocumentData => clean(Object.fromEntries(Object.entries(data).map(([key, value]) => [key, value === GONE ? deleteField() : value])))
const told = (data: DocumentData): DocumentData => Object.fromEntries(Object.entries(data).map(([key, value]) => [key, value === GONE ? null : value]))

export type CreateTableOptions = { into?: WriteBatch; id?: string; fields?: DocumentData; table?: DocumentData; audit?: DocumentData; entryKey?: string; skipEntry?: boolean }

/** Create a table document at revision 1 with its create entry (honest unless overridden). The id is made from the fields. */
export function createTable(db: Firestore, who: Staff, { into, id, fields: given = zoneTableDoc(), table = {}, audit = {}, entryKey, skipEntry = false }: CreateTableOptions = {}) {
  const fields = clean(given)
  const tableId = id ?? tableIdOf(fields)
  const batch = into ?? writeBatch(db)
  batch.set(guildDoc(db, `lootTables/${tableId}`), clean({ ...fields, rev: 1, updatedBy: UID[who], updatedAt: serverTimestamp(), ...table }))
  if (!skipEntry) batch.set(guildDoc(db, `auditLog/${entryKey ?? entryId('table', tableId, 1)}`), clean(entry(who, 'table', tableId, 1, { action: 'create', item: fields.name ?? '', ...describeChange(undefined, fields), ...audit })))
  return into ? Promise.resolve() : batch.commit()
}

export type EditTableOptions = { into?: WriteBatch; id?: string; rev?: number; changes?: DocumentData; table?: DocumentData; audit?: DocumentData; entryKey?: string; skipEntry?: boolean }

/**
 * Update a table document and file an entry for it: the revision and the stamps go up with it and the entry tells the truth. A field to take away is
 * written GONE. The default revision is the stored one plus one.
 */
export async function editTable(db: Firestore, who: Staff, { into, id = SOURCE_TABLE, rev, changes = { itemIds: [1111, 2222, 3333] }, table = {}, audit = {}, entryKey, skipEntry = false }: EditTableOptions = {}) {
  const current = await stored(`lootTables/${id}`)
  const next = rev ?? (typeof current?.rev === 'number' ? current.rev + 1 : 2)
  const batch = into ?? writeBatch(db)
  batch.update(guildDoc(db, `lootTables/${id}`), sent({ ...changes, ...stamp(who, next), ...table }))
  // The honest entry lists the fields whose value really differs (an update that writes a field with the value it has changes nothing).
  const differs = Object.fromEntries(Object.entries(told(changes)).filter(([key, value]) => JSON.stringify(value ?? null) !== JSON.stringify(current?.[key] ?? null)))
  if (!skipEntry) batch.set(guildDoc(db, `auditLog/${entryKey ?? entryId('table', id, next)}`), clean(entry(who, 'table', id, next, { action: 'edit', item: current?.name ?? '', ...describeChange(current, differs), ...audit })))
  return into ? undefined : batch.commit()
}
