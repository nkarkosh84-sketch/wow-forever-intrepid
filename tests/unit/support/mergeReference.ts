// A reference implementation of "Merge: the lists of phase N" from the spec (PR-texts/Design-loot-tables-phases.md, as changed by
// PR-texts/Design-zone-editor.md: a phase starts from nothing and may follow an earlier phase), written from the spec alone and as directly as possible, to
// check src/shared/game/guildTables.ts against. It simulates the phases one by one with plain arrays, and works every answer out from scratch for each phase. It is slow and plain on purpose: nothing here is shared with the module under test (document ids follow the spec's formats).
//
// What the spec does not say is left out of the answer (undefined), and the fuzz does not compare it:
//   - a custom zone's kind and size, or a guild creature's kind and place, when no document gives them (the client's first document always sets all);
//   - the name, kind and place of the zone-wide list.
// And one thing the spec leaves open that the reference has to pick: the place ("order") of a capture creature that no document gives one. The spec
// says "else the capture's", but a capture has no such number; the module puts the nth creature of a capture at (n + 1) * 10 and so does the reference
// (CAPTURE_ORDER_STEP). The fuzz draws document orders as multiples of 5, so they fall between and onto those places.
// Two more words the spec does not pin down: `edited` is taken as "some document of the zone, of any kind, at or before the phase", and `introducedAt` of a
// custom zone or a guild creature is either the phase of its first document or the phase of its first name (firstDocPhase, firstNamedPhase; they differ only
// when a document without a name comes first, which the client never writes), and the fuzz accepts either.
// A second gap, in what Browse drops reads: the spec has an item stay with the first creature when two creatures came to have it, and says nothing of
// an item that a creature and the zone-wide list both came to have. The module lets the zone-wide list give it up, and so does the reference.
import type { LootTableCapture } from '../../../src/shared/game/lootTables.ts'
import type { LootTableDoc, PhaseTableDoc, SourceTableDoc, ZoneTableDoc } from '../../../src/shared/game/guildTables.ts'

export const CAPTURE_ORDER_STEP = 10
export const CUSTOM_MIN = 50_000_000
export const CUSTOM_MAX = 100_000_000

export type RefList = {
  key: string
  docId: string // s{zoneId}_{key}_{phaseNo} of the phase asked for
  hasDoc: boolean // a document of exactly that phase exists
  before: number[] // entering the phase
  added: number[] // the document at exactly the phase: its itemIds minus what was there before
  hidden: number[] // the document at exactly the phase: its hiddenItemIds that are not in the phase (there before, or added and taken off again in the phase)
  gone: number[] // dropped at some point, not now, and not taken off by this phase
  items: number[] // in the phase
}
export type RefSource = RefList & {
  name: string
  kind: string | undefined
  npcId?: number
  order: number | undefined
  builtIn: boolean
  removed: boolean
  firstDocPhase?: number // the phase of the first document of the creature (guild creatures only)
  firstNamedPhase?: number // the phase of the first document that gives it a name (guild creatures only)
}
export type RefZone = {
  zoneId: number
  phaseNo: number
  name: string
  kind?: string
  players?: number
  custom: boolean
  inPhase: boolean
  edited: boolean
  hasZoneDoc: boolean
  zoneDocId: string
  firstZoneDocPhase?: number
  firstNamedPhase?: number
  sources: RefSource[] // in the order of the lists: by order, then name, then key; the zone-wide list is not among them
  zoneWide: RefList
}

const unique = (list: number[]) => list.filter((value, index) => list.indexOf(value) === index)
const cmp = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0)
const isZoneDoc = (doc: LootTableDoc): doc is ZoneTableDoc => doc.type === 'zone'
const isSourceDoc = (doc: LootTableDoc): doc is SourceTableDoc => doc.type === 'source'
const isPhaseDoc = (doc: LootTableDoc): doc is PhaseTableDoc => doc.type === 'phase'
const zoneDocIdOf = (zoneId: number, phaseNo: number) => `z${zoneId}_${phaseNo}`
const sourceDocIdOf = (zoneId: number, key: string, phaseNo: number) => `s${zoneId}_${key}_${phaseNo}`

// The phases whose documents make up the lists of `phaseNo`, in increasing order: the phase, and what it follows, and what that follows, and so on. A
// link that does not point to a lower phase is no link. Written as a recursion on purpose (the module walks a loop).
export function chainOf(docs: LootTableDoc[], phaseNo: number): number[] {
  const link = docs.filter(isPhaseDoc).find((doc) => doc.phaseNo === phaseNo)?.follows
  return typeof link === 'number' && Number.isInteger(link) && link >= 0 && link < phaseNo ? [...chainOf(docs, link), phaseNo] : [phaseNo]
}

// The value of the latest document (the phases of the chain, the later phase wins) for which `pick` gives a value.
function latest<D extends { phaseNo: number }, T>(docs: D[], chain: number[], pick: (doc: D) => T | undefined): T | undefined {
  for (const phase of [...chain].reverse()) {
    for (const doc of docs) {
      if (doc.phaseNo !== phase) continue
      const value = pick(doc)
      if (value !== undefined) return value
    }
  }
  return undefined
}
// The first phase of the chain with a document for which `has` is true.
function earliest<D extends { phaseNo: number }>(docs: D[], chain: number[], has: (doc: D) => boolean): number | undefined {
  for (const phase of chain) if (docs.some((doc) => doc.phaseNo === phase && has(doc))) return phase
  return undefined
}

// The items of one list entering and in phase `phaseNo`, simulated phase by phase from the start list.
function buildList(zoneId: number, key: string, start: number[], docs: SourceTableDoc[], chain: number[]): RefList {
  const phaseNo = chain[chain.length - 1]
  let items = unique(start)
  const everHad = new Set(items)
  let before = items
  let atPhase: SourceTableDoc | undefined
  for (const phase of chain) {
    if (phase === phaseNo) before = items
    const doc = docs.find((candidate) => candidate.phaseNo === phase)
    if (!doc) continue
    if (phase === phaseNo) atPhase = doc
    const hiddenNow = unique(doc.hiddenItemIds).filter((id) => items.includes(id)) // hidden' = hidden items that are there so far
    const kept = items.filter((id) => !hiddenNow.includes(id))
    const addedNow = unique(doc.itemIds).filter((id) => !kept.includes(id)) // added' = itemIds not kept (when a document names an item in both lists, the add wins)
    items = [...kept, ...addedNow]
    for (const id of addedNow) everHad.add(id)
  }
  const added = atPhase ? unique(atPhase.itemIds).filter((id) => !before.includes(id)) : []
  // Since docs/design/drop-list-import.md section 6, an item the phase added and took off again is reported as taken off too: every item the document
  // takes off that the phase does not have.
  const hidden = atPhase ? unique(atPhase.hiddenItemIds).filter((id) => !items.includes(id)) : []
  const gone = [...everHad].filter((id) => !items.includes(id) && !hidden.includes(id))
  return { key, docId: sourceDocIdOf(zoneId, key, phaseNo), hasDoc: atPhase !== undefined, before, added, hidden, gone, items }
}

function buildZone(zoneId: number, capture: LootTableCapture | undefined, live: LootTableDoc[], chain: number[]): RefZone | undefined {
  const phaseNo = chain[chain.length - 1]
  const every = Array.from({ length: phaseNo + 1 }, (_, no) => no)
  const zoneDocs = live.filter(isZoneDoc).filter((doc) => doc.zoneId === zoneId) // of any phase up to this one: identity
  const chainZoneDocs = zoneDocs.filter((doc) => chain.includes(doc.phaseNo)) // whether the zone is in the lists
  const sourceDocs = live.filter(isSourceDoc).filter((doc) => doc.zoneId === zoneId && chain.includes(doc.phaseNo))

  const zoneRemoved = latest(chainZoneDocs, chain, (doc) => (typeof doc.removed === 'boolean' ? doc.removed : undefined))
  const inPhase = zoneRemoved === false // a zone no document of the chain puts in is out
  const zoneName = capture ? capture.name : latest(zoneDocs, every, (doc) => doc.name)
  if (zoneName === undefined) return undefined // a custom zone no document gives a name does not exist

  const sources: RefSource[] = []
  const keysMet: string[] = []
  capture?.sources.forEach((entry) => keysMet.push(`npc${entry.npcId}`))
  for (const doc of sourceDocs) if (doc.key !== 'zonewide' && !keysMet.includes(doc.key)) keysMet.push(doc.key)

  for (const key of keysMet) {
    const docs = sourceDocs.filter((doc) => doc.key === key)
    const captureIndex = capture ? capture.sources.findIndex((entry) => `npc${entry.npcId}` === key) : -1
    const fromCapture = captureIndex >= 0 ? capture!.sources[captureIndex] : undefined
    const name = fromCapture ? fromCapture.name : latest(docs, chain, (doc) => doc.name) // decision 2a: a creature of a capture keeps the capture's name
    if (name === undefined) continue // a guild creature no document gives a name does not exist
    const kind = latest(docs, chain, (doc) => (doc.kind !== 'zonewide' ? doc.kind : undefined)) ?? fromCapture?.kind
    const order = latest(docs, chain, (doc) => doc.order) ?? (fromCapture ? (captureIndex + 1) * CAPTURE_ORDER_STEP : undefined)
    const npcId = fromCapture ? fromCapture.npcId : latest(docs, chain, (doc) => doc.npcId)
    const removedBy = latest(docs, chain, (doc) => (typeof doc.removed === 'boolean' ? doc.removed : undefined))
    const list = buildList(zoneId, key, fromCapture?.itemIds ?? [], docs, chain)
    sources.push({
      ...list,
      name,
      kind,
      npcId,
      order,
      builtIn: fromCapture !== undefined,
      removed: fromCapture ? false : removedBy ?? false, // removed does not apply to the creatures of a capture
      firstDocPhase: fromCapture ? undefined : earliest(docs, chain, () => true),
      firstNamedPhase: fromCapture ? undefined : earliest(docs, chain, (doc: SourceTableDoc) => doc.name !== undefined),
    })
  }
  sources.sort((a, b) => (a.order ?? 0) - (b.order ?? 0) || cmp(a.name, b.name) || cmp(a.key, b.key))

  const wideDocs = sourceDocs.filter((doc) => doc.key === 'zonewide')
  return {
    zoneId,
    phaseNo,
    name: zoneName,
    kind: capture ? capture.kind : latest(zoneDocs, every, (doc) => doc.kind),
    players: capture ? capture.players : latest(zoneDocs, every, (doc) => doc.players),
    custom: capture === undefined,
    inPhase,
    edited: zoneDocs.length + sourceDocs.length > 0, // the guild wrote a zone document in this phase or an earlier one, or a creature document in the chain
    hasZoneDoc: zoneDocs.some((doc) => doc.phaseNo === phaseNo),
    zoneDocId: zoneDocIdOf(zoneId, phaseNo),
    firstZoneDocPhase: capture ? undefined : earliest(zoneDocs, every, () => true),
    firstNamedPhase: capture ? undefined : earliest(zoneDocs, every, (doc: ZoneTableDoc) => doc.name !== undefined),
    sources,
    zoneWide: buildList(zoneId, 'zonewide', capture?.zoneWideItemIds ?? [], wideDocs, chain),
  }
}

// Every zone of the lists of phase `phaseNo`: the captures' zones and the custom zones that exist then. Not in a fixed zone order (the spec has none): by zone number.
export function referenceMerge(captures: LootTableCapture[], docs: LootTableDoc[], phaseNo: number, everything = false): RefZone[] {
  const live = docs.filter((doc) => doc.phaseNo <= phaseNo) // documents of later phases are ignored
  const chain = everything ? Array.from({ length: phaseNo + 1 }, (_, no) => no) : chainOf(docs, phaseNo)
  const zones: RefZone[] = []
  for (const capture of captures) {
    const zone = buildZone(capture.zoneId, capture, live, chain)
    if (zone) zones.push(zone)
  }
  const customIds = unique(live.filter((doc): doc is ZoneTableDoc | SourceTableDoc => !isPhaseDoc(doc)).map((doc) => doc.zoneId).filter((id) => id >= CUSTOM_MIN && id <= CUSTOM_MAX && !captures.some((capture) => capture.zoneId === id)))
  for (const zoneId of customIds) {
    const zone = buildZone(zoneId, undefined, live, chain) // zones that are neither a capture nor a custom zone are ignored
    if (zone) zones.push(zone)
  }
  return zones.sort((a, b) => a.zoneId - b.zoneId)
}

// What Browse drops reads: the zones in the lists, without the removed creatures and the creatures left with no items; an item stays with the first creature in order.
export type RefDropSource = { name: string; kind: string | undefined; npcId?: number; itemIds: number[] }
export type RefDropZone = { zoneId: number; name: string; kind?: string; players?: number; custom: boolean; edited: boolean; sources: RefDropSource[]; zoneWideItemIds: number[] }

export function referenceDropTables(captures: LootTableCapture[], docs: LootTableDoc[], phaseNo: number, merged: RefZone[] = referenceMerge(captures, docs, phaseNo)): RefDropZone[] {
  const result: RefDropZone[] = []
  for (const zone of merged) {
    if (!zone.inPhase) continue
    const taken = new Set<number>()
    const sources: RefDropSource[] = []
    for (const source of zone.sources) {
      if (source.removed) continue
      const itemIds = source.items.filter((id) => !taken.has(id))
      itemIds.forEach((id) => taken.add(id))
      if (itemIds.length > 0) sources.push({ name: source.name, kind: source.kind, npcId: source.npcId, itemIds })
    }
    const zoneWideItemIds = zone.zoneWide.items.filter((id) => !taken.has(id))
    result.push({ zoneId: zone.zoneId, name: zone.name, kind: zone.kind, players: zone.players, custom: zone.custom, edited: zone.edited, sources, zoneWideItemIds })
  }
  return result
}
