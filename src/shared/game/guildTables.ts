// The guild's own loot tables: what leaders add to, take off or change in the drop lists of Browse drops, kept in Firestore (`lootTables`, see
// firestore.rules) and merged here with the built-in captures in data/loot/.
//
// The lists belong to a PHASE, and a phase starts from NOTHING: no zone is in its lists until a leader ticks it, and it has none of an earlier phase's
// changes. It can instead FOLLOW an earlier phase (`follows`, a document of its own kind): the lists of the phase it follows, with its own documents on top.
// The followed phase's lists in turn include what it follows, so the documents that make up a phase's lists are those of its follow chain, in phase
// order. While the followed phase is still open, what is changed there shows in the phase that follows it; once the followed phase is finished (a later
// phase has started) nothing in it can change, so the phase that follows it simply carries on from where it ended.
//
// Only the current and the next phase are written (the rules), so a finished phase's lists are a record. A document says only what its phase changes:
// the items it adds and the items it takes off, a zone being in the lists (`removed: false`) or out of them (`removed: true`), and a creature's or
// zone's name, kind, place or size only when that phase sets them. The documents come in three kinds: a zone (`zone`), a creature (`source`; the zone-wide
// list is a creature with the key "zonewide") and a phase (`phase`, only `follows`). A zone document for a zone of the built-in captures can only say
// whether the zone is in the lists (`removed`). A zone the guild made keeps its name, kind and size in every phase (a zone is the same zone wherever
// it is ticked); whether it is in a phase's lists is stated per phase like any other zone. A document is never deleted.
// No runtime imports, so Node runs its tests directly.
import type { LootSourceKind, LootTableCapture } from './lootTables.ts'

export const CUSTOM_ZONE_MIN = 50_000_000 // the rules keep a custom zone's number clear of the game's own
export const CUSTOM_ZONE_MAX = 99_999_999
export const TABLE_ITEMS_MAX = 80 // items a creature document can add, and items it can take off, each (the rules cap both lists)
export const TABLE_NAME_MAX = 100
export const TABLE_ORDER_MAX = 100_000
export const GAME_ID_MAX = 100_000_000
export const TABLE_PHASE_MAX = 31 // 30 finished phases at most, so the next phase can be 31 (see PHASE_HISTORY_MAX in phases.ts)
export const ZONE_WIDE_KEY = 'zonewide'
export const ZONE_WIDE_NAME = 'Any creature in the zone'

export type TableSourceKind = LootSourceKind | 'zonewide'
export type ZoneKind = 'dungeon' | 'raid'
// A zone document of a custom zone may carry name, kind and players (only what its phase sets); one for a zone of the built-in captures has at most
// `removed`. `removed` is false when the zone is in the lists in this phase (and in the phases that follow it) and true when it is out; a zone no
// document of the phase's chain mentions is out.
export type ZoneTableDoc = { id: string; type: 'zone'; zoneId: number; phaseNo: number; name?: string; kind?: ZoneKind; players?: number; removed?: boolean; rev: number }
export type SourceTableDoc = {
  id: string; type: 'source'; zoneId: number; key: string; phaseNo: number; name?: string; kind?: TableSourceKind; npcId?: number; order?: number
  itemIds: number[]; hiddenItemIds: number[]; removed?: boolean; rev: number
}
// The phase itself: which earlier phase it follows (none when it starts from nothing). Filed as p{phaseNo}.
export type PhaseTableDoc = { id: string; type: 'phase'; phaseNo: number; follows?: number; rev: number }
export type LootTableDoc = ZoneTableDoc | SourceTableDoc | PhaseTableDoc

export const phaseDocId = (phaseNo: number) => `p${phaseNo}`
export const zoneDocId = (zoneId: number, phaseNo: number) => `z${zoneId}_${phaseNo}`
export const sourceDocId = (zoneId: number, key: string, phaseNo: number) => `s${zoneId}_${key}_${phaseNo}`
// The key of a creature of the built-in captures: its game number. A creature the guild adds gets a random key (newCreatureKey).
export const builtInKey = (npcId: number) => `npc${npcId}`
export const newCreatureKey = () => `c${Math.random().toString(36).slice(2, 12)}${Date.now().toString(36)}`.slice(0, 24)
export function newZoneId(taken: Iterable<number>): number {
  const used = new Set(taken)
  for (let tries = 0; tries < 1000; tries += 1) {
    const candidate = CUSTOM_ZONE_MIN + Math.floor(Math.random() * (CUSTOM_ZONE_MAX - CUSTOM_ZONE_MIN))
    if (!used.has(candidate)) return candidate
  }
  throw new Error('No free zone number was found.')
}

const unique = (ids: number[]) => [...new Set(ids)]
/** A name the rules accept: after trimming, at least one character that is more than a space or a control character (the rules treat those as blank). */
export const hasText = (name: string) => [...name.trim()].some((character) => (character.codePointAt(0) ?? 0) > 32)
const sameList = (a: number[], b: number[]) => a.length === b.length && a.every((value, index) => value === b[index])

export type MergedSource = {
  key: string
  docId: string // the id of the document of the phase being looked at (it may not exist yet)
  doc?: SourceTableDoc // the document written in exactly this phase, when there is one
  name: string
  kind: TableSourceKind
  npcId?: number
  order: number
  builtIn: boolean // the creature is in the built-in capture
  introducedAt?: number // the phase a creature the guild added starts to exist in: that of its first document that names it
  beforeItemIds: number[] // what it drops entering this phase: the capture's and what earlier phases' documents added, less what they took off
  addedItemIds: number[] // added by this phase's document (never one it already had)
  // taken off by this phase's document: ones it had before, and ones this phase added and took off again (never one it drops in this phase)
  hiddenItemIds: number[]
  goneItemIds: number[] // items it dropped at some point (the capture's or an earlier phase's) that it does not now, and this phase did not take off
  itemIds: number[] // what it drops in this phase: before, less the taken off, plus the added
  removed: boolean // out of the lists in this phase
}
export type MergedZone = {
  zoneId: number
  phaseNo: number // the phase these lists are those of
  name: string
  kind: ZoneKind
  players: number
  custom: boolean // a zone the guild made; the others come from the built-in capture
  introducedAt?: number // the phase a zone the guild made starts to exist in: that of its first document that names it
  inPhase: boolean // in the lists in this phase (a zone can be left out of a phase, and come back)
  edited: boolean // the guild has written something about this zone in this phase or an earlier one
  doc?: ZoneTableDoc // the zone document written in exactly this phase, when there is one
  builtIn?: LootTableCapture
  sources: MergedSource[] // in the order they are met, removed ones included (the editor shows them)
  zoneWide: MergedSource
}

type Base = { name: string; kind: TableSourceKind; npcId?: number; itemIds: number[]; order: number }

// The items after one document: the ones it takes off must have been there, the ones it adds must not be (an item it both takes off and adds is there).
// What it reports as taken off is every item it takes off that is not there afterwards: one it had before, and also one its phase added and took off
// again, which leaves no other trace (docs/design/drop-list-import.md section 6). The editor can bring that one back, and an import leaves it unticked.
function applyItems(items: number[], doc: { itemIds: number[]; hiddenItemIds: number[] }) {
  const off = unique(doc.hiddenItemIds)
  const kept = items.filter((id) => !off.includes(id))
  const added = unique(doc.itemIds).filter((id) => !kept.includes(id))
  const after = [...kept, ...added]
  return { hidden: off.filter((id) => !after.includes(id)), added, items: after }
}

const latest = <T>(docs: T[], has: (doc: T) => boolean): T | undefined => [...docs].reverse().find(has)
const byPhase = <T extends { phaseNo: number }>(docs: T[]) => [...docs].sort((a, b) => a.phaseNo - b.phaseNo)

// One creature in one phase: the capture's creature (if any) with its documents of phase `phaseNo` and earlier applied in phase order.
function mergeSource(zoneId: number, key: string, phaseNo: number, base: Base | undefined, docs: SourceTableDoc[]): MergedSource | null {
  const upTo = byPhase(docs.filter((doc) => doc.phaseNo <= phaseNo))
  if (!base && upTo.length === 0) return null // a creature the guild adds does not exist before its first document
  // A creature of a capture keeps the capture's name (decision 2a: built-in creatures are not renamed, so a document that names one is ignored here).
  const named = base ? base.name : latest(upTo, (doc) => typeof doc.name === 'string')?.name
  if (!named) return null // a creature the guild adds that no document names does not exist
  let before = base?.itemIds ?? []
  const ever = new Set(before)
  for (const doc of upTo) if (doc.phaseNo < phaseNo) { before = applyItems(before, doc).items; before.forEach((id) => ever.add(id)) }
  const here = upTo.find((doc) => doc.phaseNo === phaseNo)
  const step = here ? applyItems(before, here) : { hidden: [] as number[], added: [] as number[], items: before }
  step.items.forEach((id) => ever.add(id))
  const latestWith = <K extends keyof SourceTableDoc>(field: K) => latest(upTo, (doc) => doc[field] !== undefined)?.[field]
  // A creature of a capture keeps the game number the capture gives it; one the guild added has the number its latest document gives.
  const npcId = base ? base.npcId : (latestWith('npcId') as number | undefined)
  // A creature of a capture and the zone-wide list cannot be taken out of the lists (a document that says so is ignored here, as the rules refuse it).
  const removed = !(key.startsWith('npc') && base !== undefined) && key !== ZONE_WIDE_KEY && latest(upTo, (doc) => typeof doc.removed === 'boolean')?.removed === true
  return {
    key,
    docId: sourceDocId(zoneId, key, phaseNo),
    ...(here ? { doc: here } : {}),
    name: named,
    kind: (key === ZONE_WIDE_KEY ? 'zonewide' : kindOf(latestWith('kind') as TableSourceKind | undefined)) ?? base?.kind ?? 'trash',
    ...(npcId === undefined ? {} : { npcId }),
    order: (latestWith('order') as number | undefined) ?? base?.order ?? 0,
    builtIn: key.startsWith('npc') && base !== undefined,
    ...(!base ? { introducedAt: (upTo.find((doc) => typeof doc.name === 'string') as SourceTableDoc).phaseNo } : {}),
    beforeItemIds: before,
    addedItemIds: step.added,
    hiddenItemIds: step.hidden,
    goneItemIds: [...ever].filter((id) => !step.items.includes(id) && !step.hidden.includes(id)),
    itemIds: step.items,
    removed,
  }
}

// Only the zone-wide list is of the kind zonewide, and nothing else can be made so.
const kindOf = (kind: TableSourceKind | undefined) => (kind === 'zonewide' ? undefined : kind)

const byOrder = (a: MergedSource, b: MergedSource) => a.order - b.order || a.name.localeCompare(b.name) || a.key.localeCompare(b.key)

/** The follow link of every phase that has one (a number below the phase's own; anything else in a stored document is ignored). */
const followsOf = (docs: readonly LootTableDoc[]) => new Map(docs.flatMap((doc) => (doc.type === 'phase' && Number.isInteger(doc.follows) && (doc.follows as number) >= 0 && (doc.follows as number) < doc.phaseNo ? [[doc.phaseNo, doc.follows as number] as const] : [])))

/**
 * The phases whose documents make up the lists of `phaseNo`, oldest first: the phase itself, the phase it follows, the phase that one follows, and so
 * on. A phase that follows nothing is a chain of one. Each link points to a lower phase, so this ends.
 */
export function followChain(docs: readonly LootTableDoc[], phaseNo: number): number[] {
  const follows = followsOf(docs)
  const chain = [phaseNo]
  for (let at = follows.get(phaseNo); at !== undefined; at = follows.get(at)) chain.unshift(at)
  return chain
}

/** The phase `phaseNo` follows, when it follows one. */
export const followedBy = (docs: readonly LootTableDoc[], phaseNo: number): number | undefined => followsOf(docs).get(phaseNo)

/** The document of a phase (what it follows), when one was written. */
export const phaseDocOf = (docs: readonly LootTableDoc[], phaseNo: number): PhaseTableDoc | undefined => docs.find((doc): doc is PhaseTableDoc => doc.type === 'phase' && doc.phaseNo === phaseNo)

/**
 * The lists of one phase: the built-in captures with the guild's documents applied. Which documents: those of the phase's follow chain (followChain), in
 * phase order, for what is in the lists (zones ticked, creatures and their items); a zone the guild made also keeps its name, kind and size from its
 * documents of any phase up to this one, so it is the same zone wherever it is ticked. With `everything` the chain is every phase up to this one (the Log
 * names things from any phase). Documents that fit no zone are ignored.
 */
export function mergeTables(captures: LootTableCapture[], docs: LootTableDoc[], phaseNo: number, everything = false): MergedZone[] {
  const chain = new Set(everything ? Array.from({ length: phaseNo + 1 }, (_, no) => no) : followChain(docs, phaseNo))
  const identity = new Map<number, ZoneTableDoc[]>() // zone documents of any phase up to this one: names, kinds and sizes
  const stated = new Map<number, ZoneTableDoc[]>() // those of the chain: whether the zone is in the lists
  const sourceDocs = new Map<string, SourceTableDoc[]>() // by zone and key, of the chain
  for (const doc of docs) {
    if (doc.type === 'phase' || doc.phaseNo > phaseNo) continue
    if (doc.type === 'zone') {
      identity.set(doc.zoneId, [...(identity.get(doc.zoneId) ?? []), doc])
      if (chain.has(doc.phaseNo)) stated.set(doc.zoneId, [...(stated.get(doc.zoneId) ?? []), doc])
    } else if (chain.has(doc.phaseNo)) sourceDocs.set(`${doc.zoneId}_${doc.key}`, [...(sourceDocs.get(`${doc.zoneId}_${doc.key}`) ?? []), doc])
  }
  const sourcesOf = (zoneId: number, skip: Set<string>) => [...sourceDocs.values()].filter((list) => list[0].zoneId === zoneId && list[0].key !== ZONE_WIDE_KEY && !skip.has(list[0].key))
  const zoneWideOf = (zoneId: number, table: LootTableCapture | undefined): MergedSource => {
    const merged = mergeSource(zoneId, ZONE_WIDE_KEY, phaseNo, { name: ZONE_WIDE_NAME, kind: 'zonewide', itemIds: table?.zoneWideItemIds ?? [], order: TABLE_ORDER_MAX }, sourceDocs.get(`${zoneId}_${ZONE_WIDE_KEY}`) ?? []) as MergedSource
    return { ...merged, name: ZONE_WIDE_NAME, kind: 'zonewide', builtIn: false }
  }
  // In the lists only when the latest document of the chain that says so puts it in (`removed: false`); with none, a zone is out.
  const presence = (zoneId: number) => latest(byPhase(stated.get(zoneId) ?? []), (doc) => typeof doc.removed === 'boolean')?.removed === false
  const touched = (zoneId: number) => (identity.get(zoneId)?.length ?? 0) > 0 || [...sourceDocs.values()].some((list) => list[0].zoneId === zoneId)
  const live = (merged: MergedSource | null): MergedSource[] => (merged ? [merged] : [])

  const zones: MergedZone[] = captures.map((table) => {
    const used = new Set<string>()
    const fromCapture = table.sources.flatMap((source, index) => {
      const key = builtInKey(source.npcId)
      used.add(key)
      return live(mergeSource(table.zoneId, key, phaseNo, { name: source.name, kind: source.kind, npcId: source.npcId, itemIds: source.itemIds, order: (index + 1) * 10 }, sourceDocs.get(`${table.zoneId}_${key}`) ?? []))
    })
    const added = sourcesOf(table.zoneId, used).flatMap((perKey) => live(mergeSource(table.zoneId, perKey[0].key, phaseNo, undefined, perKey)))
    const here = (stated.get(table.zoneId) ?? []).find((doc) => doc.phaseNo === phaseNo)
    return {
      zoneId: table.zoneId, phaseNo, name: table.name, kind: table.kind, players: table.players, custom: false, inPhase: presence(table.zoneId), edited: touched(table.zoneId), ...(here ? { doc: here } : {}), builtIn: table,
      sources: [...fromCapture, ...added].sort(byOrder), zoneWide: zoneWideOf(table.zoneId, table),
    }
  })
  for (const [zoneId, unsorted] of identity) {
    if (zoneId < CUSTOM_ZONE_MIN || zones.some((zone) => zone.zoneId === zoneId)) continue
    const list = byPhase(unsorted)
    const withName = latest(list, (doc) => typeof doc.name === 'string')
    if (!withName) continue // a zone the guild made that no document names does not exist
    const here = (stated.get(zoneId) ?? []).find((doc) => doc.phaseNo === phaseNo)
    zones.push({
      zoneId, phaseNo, name: withName.name ?? '', kind: latest(list, (doc) => doc.kind !== undefined)?.kind ?? 'dungeon', players: latest(list, (doc) => doc.players !== undefined)?.players ?? 5, custom: true,
      introducedAt: (list.find((doc) => typeof doc.name === 'string') as ZoneTableDoc).phaseNo, inPhase: presence(zoneId), edited: true, ...(here ? { doc: here } : {}),
      sources: sourcesOf(zoneId, new Set()).flatMap((perKey) => live(mergeSource(zoneId, perKey[0].key, phaseNo, undefined, perKey))).sort(byOrder),
      zoneWide: zoneWideOf(zoneId, undefined),
    })
  }
  return zones.sort((a, b) => a.name.localeCompare(b.name) || a.zoneId - b.zoneId)
}

/**
 * A zone as Browse drops reads it: no removed creature, no creature without items, the items as they stand in the phase. An item two creatures of the
 * zone came to have (different phases can each add it somewhere) stays with the first creature in order, as a capture has it only once.
 */
export function effectiveCapture(zone: MergedZone): LootTableCapture {
  const seen = new Set<number>()
  const once = (ids: number[]) => ids.filter((id) => !seen.has(id) && (seen.add(id), true))
  const sources = zone.sources.filter((source) => !source.removed && source.kind !== 'zonewide').map((source) => ({
    npcId: source.npcId ?? 0, name: source.name, kind: source.kind as LootSourceKind, itemIds: once(source.itemIds),
  })).filter((source) => source.itemIds.length > 0)
  return {
    format: 1,
    zoneId: zone.zoneId,
    name: zone.name,
    kind: zone.kind,
    players: zone.players,
    source: zone.builtIn?.source ?? '',
    capturedAt: zone.builtIn?.capturedAt ?? '',
    ...(zone.builtIn?.dataStatus ? { dataStatus: zone.builtIn.dataStatus } : {}),
    ...(zone.builtIn?.notes ? { notes: zone.builtIn.notes } : {}),
    sources,
    zoneWideItemIds: once(zone.zoneWide.itemIds),
    custom: zone.custom,
    edited: zone.edited,
  }
}

/** The drop lists Browse drops shows in one phase: every zone that is in the lists, as it stands in that phase. */
export const dropTablesOf = (captures: LootTableCapture[], docs: LootTableDoc[], phaseNo: number): LootTableCapture[] =>
  mergeTables(captures, docs, phaseNo).filter((zone) => zone.inPhase).map(effectiveCapture)

// ---- Reading a stored document. The rules check sizes only, so what comes back is read tolerantly: a list keeps only whole item numbers, a
// field that is wrong is left out, and a document that fits no id of its own (or has no usable zone or phase) is skipped.

const isGameId = (value: unknown): value is number => typeof value === 'number' && Number.isInteger(value) && value > 0 && value <= GAME_ID_MAX
const isPhase = (value: unknown): value is number => typeof value === 'number' && Number.isInteger(value) && value >= 0 && value <= TABLE_PHASE_MAX
const itemList = (value: unknown): number[] => (Array.isArray(value) ? unique(value.filter(isGameId)) : [])
const isName = (value: unknown): value is string => typeof value === 'string' && value.trim().length > 0 && value.length <= TABLE_NAME_MAX

export function readTableDoc(id: string, data: Record<string, unknown>): LootTableDoc | null {
  const rev = typeof data.rev === 'number' && Number.isInteger(data.rev) && data.rev >= 0 ? data.rev : 0
  if (data.type === 'phase') {
    if (!isPhase(data.phaseNo) || id !== phaseDocId(data.phaseNo)) return null
    // A link that does not point to an earlier phase is left out: the phase then follows nothing.
    return { id, type: 'phase', phaseNo: data.phaseNo, ...(isPhase(data.follows) && data.follows < data.phaseNo ? { follows: data.follows } : {}), rev }
  }
  if (!isGameId(data.zoneId) || !isPhase(data.phaseNo)) return null
  const removed = typeof data.removed === 'boolean' ? { removed: data.removed } : {}
  const name = isName(data.name) ? { name: data.name } : {}
  if (data.type === 'zone') {
    if (id !== zoneDocId(data.zoneId, data.phaseNo)) return null
    // A zone of the built-in captures has at most the statement whether it is in the lists: its name, kind and size come from the capture.
    if (data.zoneId < CUSTOM_ZONE_MIN) return { id, type: 'zone', zoneId: data.zoneId, phaseNo: data.phaseNo, rev, ...removed }
    const kind: { kind?: ZoneKind } = data.kind === 'raid' ? { kind: 'raid' } : data.kind === 'dungeon' ? { kind: 'dungeon' } : {}
    const players = typeof data.players === 'number' && Number.isInteger(data.players) && data.players >= 1 && data.players <= 40 ? { players: data.players } : {}
    return { id, type: 'zone', zoneId: data.zoneId, phaseNo: data.phaseNo, ...name, ...kind, ...players, rev, ...removed }
  }
  if (data.type !== 'source' || typeof data.key !== 'string' || !/^[A-Za-z0-9]{1,30}$/.test(data.key) || id !== sourceDocId(data.zoneId, data.key, data.phaseNo)) return null
  const kinds: TableSourceKind[] = ['boss', 'rare', 'trash', 'zonewide']
  const kind = kinds.find((candidate) => candidate === data.kind)
  const order = typeof data.order === 'number' && Number.isInteger(data.order) && data.order >= 0 && data.order <= TABLE_ORDER_MAX ? { order: data.order } : {}
  return {
    id, type: 'source', zoneId: data.zoneId, key: data.key, phaseNo: data.phaseNo, ...name, ...(kind ? { kind } : {}), ...(isGameId(data.npcId) ? { npcId: data.npcId } : {}), ...order,
    itemIds: itemList(data.itemIds), hiddenItemIds: itemList(data.hiddenItemIds), rev, ...removed,
  }
}

/** The phase each custom zone and each creature was first written in, for the Log: its first document is "added", later ones are changes. */
export function firstPhases(docs: LootTableDoc[]): { zones: Map<number, number>; sources: Map<string, number> } {
  const zones = new Map<number, number>()
  const sources = new Map<string, number>()
  const keep = (map: Map<string | number, number>, key: string | number, phaseNo: number) => { if (!map.has(key) || (map.get(key) as number) > phaseNo) map.set(key, phaseNo) }
  for (const doc of docs) {
    if (doc.type === 'zone') keep(zones as Map<string | number, number>, doc.zoneId, doc.phaseNo)
    else if (doc.type === 'source') keep(sources as Map<string | number, number>, `${doc.zoneId}_${doc.key}`, doc.phaseNo)
  }
  return { zones, sources }
}

/**
 * What the guild has prepared for one phase, in a few words for Settings (starting a phase makes these its lists):
 * "follows Phase 1, adds the zone Molten Core, puts 2 zones in the lists, takes 1 zone out and changes 14 creatures". Empty when the phase follows
 * nothing and has no document of its own.
 */
export function describePreparedTables(docs: LootTableDoc[], phaseNo: number, phaseName: (no: number) => string = (no) => `phase ${no + 1}`): string {
  const here = docs.filter((doc) => doc.phaseNo === phaseNo)
  const followed = followedBy(docs, phaseNo)
  if (followed === undefined && !here.some((doc) => doc.type !== 'phase')) return ''
  const zoneDocs = here.filter((doc): doc is ZoneTableDoc => doc.type === 'zone')
  const earlier = new Set(docs.flatMap((doc) => (doc.type === 'zone' && doc.phaseNo < phaseNo ? [doc.zoneId] : [])))
  const added = zoneDocs.filter((doc) => doc.zoneId >= CUSTOM_ZONE_MIN && !earlier.has(doc.zoneId) && doc.name)
  const addedIds = new Set(added.map((doc) => doc.zoneId))
  const inLists = zoneDocs.filter((doc) => doc.removed === false && !addedIds.has(doc.zoneId)).length
  const out = zoneDocs.filter((doc) => doc.removed === true).length
  const creatures = new Set(here.flatMap((doc) => (doc.type === 'source' ? [`${doc.zoneId}_${doc.key}`] : []))).size
  const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`
  const parts = [
    ...(followed === undefined ? [] : [`follows ${phaseName(followed)}`]),
    ...(added.length ? [`adds ${added.length === 1 ? 'the zone' : 'the zones'} ${added.map((doc) => doc.name).join(', ')}`] : []),
    ...(inLists ? [`puts ${plural(inLists, 'zone', 'zones')} in the lists`] : []),
    ...(out ? [`takes ${plural(out, 'zone', 'zones')} out of the lists`] : []),
    ...(creatures ? [`changes ${plural(creatures, 'creature', 'creatures')}`] : []),
  ]
  return parts.length ? parts.join(', ').replace(/, ([^,]*)$/, ' and $1') : 'changes the zones'
}

// ---- Reading what a leader pastes

// An in-game item link, as the chat or an addon writes it: |cffa335ee|Hitem:19019:0:0:0|h[Name]|h|r. The color in front (newer clients write |cnIQ4:)
// and the |r after it are optional, and a link copied out of an edit box has every | doubled. Its name can hold spaces and commas, so whole links are
// read before the text is split.
const GAME_LINK = /(?:\|\|?c[^|]*)?\|\|?Hitem:(\d+)[^|]*\|\|?h(?:\[[^\]]*\])?\|\|?h(?:\|\|?r)?/g
// The game's own item string (item:19019, or item:19019:0:0:... with more fields), alone or what is left of a link.
const ITEM_STRING = /(?:^|\|H)item:(\d{1,9})(?=$|[:|])/

/**
 * Item numbers from pasted text: plain numbers, Wowhead item links (`.../item=872/name`), the game's item strings (`item:872`, with or without more
 * fields after it) and in-game item links (`|Hitem:872:...|h[Name]|h`), separated by spaces, commas or lines (docs/design/drop-list-import.md section 9).
 */
export function parseItemIds(text: string): { ids: number[]; ignored: string[] } {
  const ids: number[] = []
  const ignored: string[] = []
  for (const token of text.replace(GAME_LINK, (_, id: string) => ` item:${id} `).split(/[\s,;]+/).filter(Boolean)) {
    const link = /item=(\d{1,9})/.exec(token) ?? ITEM_STRING.exec(token)
    const id = link ? Number(link[1]) : /^\d{1,9}$/.test(token) ? Number(token) : NaN
    if (Number.isInteger(id) && id > 0 && id <= GAME_ID_MAX) { if (!ids.includes(id)) ids.push(id) }
    else ignored.push(token)
  }
  return { ids, ignored }
}

// ---- Changes. Each change is one audited write to a document of the phase being edited (`zone.phaseNo`): a new document (`create`) or an edit of
// the one that is already there (`existing` and `changes`). A new document says only what the change says (plus the empty item lists a creature
// document always has), so a phase's first change to something does not copy its name, kind or place and a later correction in an earlier phase
// still reaches this phase. A field of `changes` set to undefined is taken away. The editor builds them and the audited helper in guildApi.ts
// writes them.

export type TableChange = Partial<Record<'name' | 'kind' | 'players' | 'order' | 'npcId' | 'itemIds' | 'hiddenItemIds' | 'removed' | 'follows', unknown>>
export type NewTableDoc = Omit<ZoneTableDoc, 'id' | 'rev'> | Omit<SourceTableDoc, 'id' | 'rev'> | Omit<PhaseTableDoc, 'id' | 'rev'>
export type TableWrite = { id: string; create: NewTableDoc } | { id: string; existing: LootTableDoc; changes: TableChange }

type SourceFields = { itemIds?: number[]; hiddenItemIds?: number[]; order?: number; name?: string; kind?: TableSourceKind; removed?: boolean }

function writeSource(zone: MergedZone, source: MergedSource, fields: SourceFields): TableWrite {
  if (source.doc) return { id: source.doc.id, existing: source.doc, changes: fields }
  return {
    id: source.docId,
    create: { type: 'source', zoneId: zone.zoneId, key: source.key, phaseNo: zone.phaseNo, itemIds: [], hiddenItemIds: [], ...fields } as NewTableDoc,
  }
}

// What this phase's document would say about items, as the target state: the added list and the taken off list the document should have. Only the
// lists that differ from what the document has now are written. Decided by `before` (what the creature has entering this phase), never by what the
// document happens to list, so a leftover entry cannot make an item impossible to take off.
function itemWrite(zone: MergedZone, source: MergedSource, nextAdded: number[], nextHidden: number[]): TableWrite | null {
  const rawAdded = source.doc?.itemIds ?? []
  const rawHidden = source.doc?.hiddenItemIds ?? []
  const fields: SourceFields = {}
  if (!sameList(nextAdded, rawAdded)) fields.itemIds = nextAdded
  if (!sameList(nextHidden, rawHidden)) fields.hiddenItemIds = nextHidden
  return Object.keys(fields).length ? writeSource(zone, source, fields) : null
}

// What stays on the document's taken off list after a write, less the items in `drop`: everything it takes off, also an item this phase added and took
// off again (docs/design/drop-list-import.md section 6), but never one the next added list has (the rules keep the two lists apart).
const hiddenKept = (source: MergedSource, nextAdded: number[], drop: number[]) => unique(source.doc?.hiddenItemIds ?? []).filter((id) => !drop.includes(id) && !nextAdded.includes(id))

/**
 * Items the zone has in this phase, by the creature that drops them (the zone's list counts as a creature). One creature per item in a zone. A creature
 * a leader took out of the lists keeps its items, and bringing it back brings them back, so its items count too, after the creatures in the lists and
 * the zone-wide list: an item listed there is not added to another creature (docs/design/drop-list-import.md section 6).
 */
export function itemHolders(zone: MergedZone): Map<number, string> {
  const holders = new Map<number, string>()
  const inLists = zone.sources.filter((candidate) => !candidate.removed)
  const takenOut = zone.sources.filter((candidate) => candidate.removed)
  for (const source of [...inLists, zone.zoneWide, ...takenOut]) for (const id of source.itemIds) if (!holders.has(id)) holders.set(id, source.name)
  return holders
}

export type AddItemsResult = { write: TableWrite | null; added: number[]; alreadyIn: { id: number; where: string }[]; tooMany: boolean }

/**
 * Add items to a creature (or the zone-wide list) in this phase. An item the zone already has stays where it is and is reported; one this phase took
 * off comes back (one it had before by leaving the taken off list, one this phase added before by being added again); one an earlier phase took off is
 * added again.
 */
export function addItems(zone: MergedZone, source: MergedSource, wanted: number[]): AddItemsResult {
  const ids = unique(wanted)
  const holders = itemHolders(zone)
  const restore = ids.filter((id) => source.hiddenItemIds.includes(id) && !holders.has(id))
  const fresh = ids.filter((id) => !holders.has(id) && !source.hiddenItemIds.includes(id))
  const alreadyIn = ids.filter((id) => holders.has(id)).map((id) => ({ id, where: holders.get(id) ?? '' }))
  const touched = [...restore, ...fresh]
  const nextAdded = [...unique(source.doc?.itemIds ?? []).filter((id) => !touched.includes(id)), ...ids.filter((id) => touched.includes(id) && !source.beforeItemIds.includes(id))]
  const nextHidden = hiddenKept(source, nextAdded, touched)
  if (nextAdded.length > TABLE_ITEMS_MAX) return { write: null, added: [], alreadyIn, tooMany: true }
  if (!touched.length) return { write: null, added: [], alreadyIn, tooMany: false }
  return { write: itemWrite(zone, source, nextAdded, nextHidden), added: touched, alreadyIn, tooMany: false }
}

/**
 * Take an item off a creature from this phase on: earlier phases keep it. An item this phase added is no longer added, and is kept on the taken off
 * list too, so it can be brought back and an import knows a leader took it off (docs/design/drop-list-import.md section 6). Nothing (null) when that
 * list already holds as many items as a document can take off.
 */
export function takeOffItem(zone: MergedZone, source: MergedSource, id: number): TableWrite | null {
  if (!source.itemIds.includes(id)) return null
  const nextAdded = unique(source.doc?.itemIds ?? []).filter((candidate) => candidate !== id)
  const nextHidden = [...hiddenKept(source, nextAdded, [id]), id]
  if (nextHidden.length > TABLE_ITEMS_MAX) return null
  return itemWrite(zone, source, nextAdded, nextHidden)
}

/**
 * Bring back an item this phase took off: one it had before leaves the taken off list, and one this phase added and took off again is added again.
 * Nothing (null) when another creature of the zone has the item now (it stays there, as with addItems), or when that would add more items than a
 * document can.
 */
export function restoreItem(zone: MergedZone, source: MergedSource, id: number): TableWrite | null {
  if (!source.hiddenItemIds.includes(id) || itemHolders(zone).has(id)) return null
  const nextAdded = [...unique(source.doc?.itemIds ?? []).filter((candidate) => candidate !== id), ...(source.beforeItemIds.includes(id) ? [] : [id])]
  if (nextAdded.length > TABLE_ITEMS_MAX) return null
  return itemWrite(zone, source, nextAdded, hiddenKept(source, nextAdded, [id]))
}

/** A new creature the guild adds to a zone from this phase on, met after the others. The first document of a creature says everything about it. */
export function addCreature(zone: MergedZone, fields: { name: string; kind: LootSourceKind; npcId?: number }, key: string = newCreatureKey()): TableWrite {
  const order = Math.min(TABLE_ORDER_MAX, Math.max(0, ...zone.sources.map((source) => source.order)) + 10)
  return {
    id: sourceDocId(zone.zoneId, key, zone.phaseNo),
    create: { type: 'source', zoneId: zone.zoneId, key, phaseNo: zone.phaseNo, name: fields.name.trim(), kind: fields.kind, ...(fields.npcId === undefined ? {} : { npcId: fields.npcId }), order, itemIds: [], hiddenItemIds: [] },
  }
}

/** A creature the guild added is taken out of the lists from this phase on (its items are kept, so bringing it back restores them), or brought back. Built-in creatures and the zone-wide list stay. */
export const setCreatureRemoved = (zone: MergedZone, source: MergedSource, removed: boolean): TableWrite | null =>
  !source.builtIn && source.key !== ZONE_WIDE_KEY && source.removed !== removed ? writeSource(zone, source, { removed }) : null

/** Rename a creature the guild added (a creature of the built-in lists keeps its name). */
export function renameCreature(zone: MergedZone, source: MergedSource, name: string, kind: TableSourceKind): TableWrite | null {
  if (source.builtIn || source.key === ZONE_WIDE_KEY || !hasText(name)) return null
  const fields: { name?: string; kind?: TableSourceKind } = {}
  if (name.trim() !== source.name) fields.name = name.trim()
  if (kind !== source.kind) fields.kind = kind
  return Object.keys(fields).length ? writeSource(zone, source, fields) : null
}

/**
 * Move a creature one place earlier or later among the creatures met. When the two trade places cleanly (their places differ and no third creature
 * shares either one) they simply swap their places, two writes. Otherwise (a tie would put a third creature in between) every creature from the pair
 * on is given a place just after the one before it where it has to be, so the order that results is exactly the swapped one.
 */
export function moveCreature(zone: MergedZone, source: MergedSource, direction: -1 | 1): TableWrite[] {
  const live = zone.sources.filter((candidate) => !candidate.removed)
  const index = live.findIndex((candidate) => candidate.key === source.key)
  const neighbor = live[index + direction]
  if (index < 0 || !neighbor) return []
  const clean = source.order !== neighbor.order && !live.some((candidate) => candidate !== source && candidate !== neighbor && (candidate.order === source.order || candidate.order === neighbor.order))
  if (clean) {
    const first = direction === -1 ? source : neighbor // the one that ends up earlier
    const second = direction === -1 ? neighbor : source
    const low = Math.min(source.order, neighbor.order)
    const high = Math.max(source.order, neighbor.order)
    return [writeSource(zone, first, { order: low }), writeSource(zone, second, { order: high })]
  }
  const target = [...live]
  target[index] = neighbor
  target[index + direction] = source
  const start = Math.min(index, index + direction)
  let previous = start > 0 ? live[start - 1].order : -1
  const writes: TableWrite[] = []
  for (const creature of target.slice(start)) {
    const order = creature.order > previous ? creature.order : previous + 1
    if (order > TABLE_ORDER_MAX) return []
    if (order !== creature.order) writes.push(writeSource(zone, creature, { order }))
    previous = order
  }
  return writes
}

/** A zone the guild makes (in Settings). The first document of a zone says everything about it: its name, kind and size. It is in no phase's lists until it is ticked in one. */
export function addZone(fields: { name: string; kind: ZoneKind; players: number }, taken: Iterable<number>, phaseNo: number): { zoneId: number; write: TableWrite } {
  const zoneId = newZoneId(taken)
  return { zoneId, write: { id: zoneDocId(zoneId, phaseNo), create: { type: 'zone', zoneId, phaseNo, name: fields.name.trim(), kind: fields.kind, players: fields.players } } }
}

// A write to the zone's document of this phase: an edit when it exists, otherwise a new one that says only what the change says.
function writeZone(zone: MergedZone, fields: { name?: string; kind?: ZoneKind; players?: number; removed?: boolean }): TableWrite {
  if (zone.doc) return { id: zone.doc.id, existing: zone.doc, changes: fields }
  return { id: zoneDocId(zone.zoneId, zone.phaseNo), create: { type: 'zone', zoneId: zone.zoneId, phaseNo: zone.phaseNo, ...fields } as NewTableDoc }
}

/** Rename or resize a zone the guild made (in every phase from this one on, as the name and size of a zone are the same wherever it is ticked). */
export const editZone = (zone: MergedZone, fields: { name: string; kind: ZoneKind; players: number }): TableWrite | null => {
  if (!zone.custom) return null
  const changes: { name?: string; kind?: ZoneKind; players?: number } = {}
  if (fields.name.trim() !== zone.name) changes.name = fields.name.trim()
  if (fields.kind !== zone.kind) changes.kind = fields.kind
  if (fields.players !== zone.players) changes.players = fields.players
  return Object.keys(changes).length && hasText(fields.name) ? writeZone(zone, changes) : null
}

/** Put a zone in the lists of this phase (and the phases that follow it), or take it out. Every zone can be, built-in or not; other phases are not touched. */
export const setZoneInPhase = (zone: MergedZone, inPhase: boolean): TableWrite | null => (zone.inPhase === inPhase ? null : writeZone(zone, { removed: !inPhase }))

/** The writes that put every zone of `zones` in the lists of this phase, or take every one out; those already so need none. */
export const setZonesInPhase = (zones: MergedZone[], inPhase: boolean): TableWrite[] => zones.flatMap((zone) => { const write = setZoneInPhase(zone, inPhase); return write ? [write] : [] })

/**
 * Make a phase follow an earlier one, or follow nothing (`undefined`). A phase follows only an earlier phase, so anything else answers nothing, as does
 * a choice that is already so. The first time a phase is set, its document is made; after that it is edited (its link taken away to follow nothing).
 */
export function setFollows(docs: readonly LootTableDoc[], phaseNo: number, follows: number | undefined): TableWrite | null {
  if (follows !== undefined && !(Number.isInteger(follows) && follows >= 0 && follows < phaseNo)) return null
  const existing = phaseDocOf(docs, phaseNo)
  if (!existing) return follows === undefined ? null : { id: phaseDocId(phaseNo), create: { type: 'phase', phaseNo, follows } }
  return existing.follows === follows ? null : { id: existing.id, existing, changes: { follows } }
}
