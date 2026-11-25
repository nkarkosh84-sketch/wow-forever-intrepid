// The drop list import's preview and save (LOOT-008, docs/design/drop-list-import.md sections 6 and 7). What the leader pasted is read into candidate
// zones first (shared/game/dropsString.ts); here they are matched to the guild's zones, creatures and items, sorted into the design's categories with
// their defaults, and turned into the audited writes of the save: two calls, and in each call one write per document (the rules check every edit
// against the document as it was before the batch, so a batch can't hold two writes to one document).
//
// Nothing is ever deleted, and nothing a leader took out comes back unless a leader ticks it. Pure: the panel (DropImportPanel.tsx) holds the
// answers and calls writeLootTables. Only types and pure functions are imported, so Node runs the tests directly.
import {
  CUSTOM_ZONE_MIN, TABLE_ITEMS_MAX, TABLE_NAME_MAX, TABLE_ORDER_MAX, ZONE_WIDE_KEY, ZONE_WIDE_NAME, addItems, followChain, hasText, mergeTables, newCreatureKey, newZoneId,
  setZoneInPhase, sourceDocId, zoneDocId, type LootTableDoc, type MergedSource, type MergedZone, type NewTableDoc, type SourceTableDoc, type TableChange, type TableWrite,
  type ZoneKind, type ZoneTableDoc,
} from '../../shared/game/guildTables.ts'
import type { LootSourceKind, LootTableCapture } from '../../shared/game/lootTables.ts'
import { dropsNameKey, mergeCandidateSources, mergeEvidence, type CandidateItem, type CandidateSource, type CandidateZone, type ItemEvidence } from '../../shared/game/dropsString.ts'
import { suggestColor, zoneColor } from '../../shared/game/zoneColors.ts'
import { RAID_ZONE_NAME_MAX, listZones, zoneNameKey, type CatalogZone, type ListedZone } from '../../shared/game/zoneList.ts'

/** What the import is matched against and written into. `phaseNo` is the phase picked in the editor (the current one or the next). */
export type ImportSetup = {
  captures: LootTableCapture[]
  docs: LootTableDoc[]
  catalog: readonly CatalogZone[]
  currentPhase: number
  phaseNo: number
  /** Decision D6: whether DungeonJournal's items may be saved (one creature at a time, with their own Log reason). The panel passes JOURNAL_ITEMS_SAVED. */
  journalSaving: boolean
  /** Decision D1: only a Guild Leader makes a zone from the import. */
  canMakeZones: boolean
}

/** D6 as the loot owner changed it on 2026-11-24: DungeonJournal's items can be saved, unticked by default, one creature at a time, in their own write (the maintainer's 2026-11-14 answer kept them as information). One switch. */
export const JOURNAL_ITEMS_SAVED = true

/** A zone the leader picks, or one a Guild Leader makes (its id, kept by the panel so it doesn't change while the preview is open; zoneIdFor gives it). */
export type ZoneAnswer = { pick: number } | { make: true; zoneId?: number }
export type CreatureAnswer = { same: string } | { make: true }
/** The leader's answers, by row id. A tick that isn't here is the row's default. */
export type ImportAnswers = {
  zones: Record<string, ZoneAnswer | undefined>
  creatures: Record<string, CreatureAnswer | undefined>
  renames: Record<string, boolean | undefined> // a Differs row: true renames the app's creature, otherwise the app's name and kind stay
  ticks: Record<string, boolean | undefined>
  /** The zone id "Make a new zone" last gave each pasted zone, kept with the answers (so a new text starts afresh): choosing it again gives it back. */
  made?: Record<string, number | undefined>
}
export const noAnswers = (): ImportAnswers => ({ zones: {}, creatures: {}, renames: {}, ticks: {} })

export type ItemStatus =
  | 'new' // not in the lists: ticked by default, unless it is from trash, a quest item, or DungeonJournal's alone
  | 'already' // already on this creature in the phase
  | 'elsewhere' // on another creature of the zone (a creature a leader took out included) or on the zone-wide list: not added, the app keeps one creature per item
  | 'takenOff' // a leader took it off this creature, in this phase or an earlier phase of its chain: unticked, opt-in
  | 'claimed' // another row of this import saves it (a creature beats the zone-wide list, the first creature beats the next)
  | 'zoneWide' // two or more trash creatures dropped it: offered for the zone-wide list instead
  | 'noRoom' // more than the creature's room for the phase, counting the items ticked before it: the next phase can add it
  | 'journal' // DungeonJournal's alone, while its items aren't saved (D6 switched off): information

export type ItemRow = {
  id: string
  itemId: number
  evidence: ItemEvidence
  status: ItemStatus
  where?: string // the creature that has it (elsewhere, claimed)
  journalOnly: boolean // saved, when it may be, in its own write with DungeonJournal's reason
  tickable: boolean
  ticked: boolean
}

export type CreatureStatus =
  | 'new' // not in the zone
  | 'matched' // a creature of the zone (how says by what)
  | 'unmatched' // a near name: the leader says "same as …" or "new"
  | 'takenOut' // a creature a leader took out: unticked, opt-in; ticking brings it back with the items, in one write
  | 'zoneWide' // the zone-wide list

export type CreatureRow = {
  id: string
  name: string
  kind: LootSourceKind | 'zonewide'
  npcId?: number
  encounterId?: number
  guessed?: true
  kills?: number
  first?: string
  last?: string
  status: CreatureStatus
  how?: 'npc' | 'encounter' | 'name' | 'answer'
  key?: string // the creature's key in the zone (matched), or the one it gets (new)
  order?: number // a new creature's place among the zone's creatures
  near: { key: string; name: string }[] // for an unmatched creature: the near names it may be
  differs?: { name?: string; kind?: LootSourceKind } // a matched guild creature whose name or kind differs from the paste's
  rename: boolean
  answerKeys?: string[] // the keys of the answer to its near names ("same as …" or "new"): one per pasted creature the row has (its pasted zone's own id and its identity)
  answer?: CreatureAnswer // that answer, when one of those keys holds one that applies here
  storeNpcId?: number // the npc id the save writes onto the app's creature (same as …, or a creature known by its encounter)
  saved: boolean // the creature is written (new, brought back, or something under it is)
  optIn?: 'noItems' | 'guessed' | 'takenOut' // why the creature itself is unticked until a leader ticks it
  creatureTickable: boolean
  items: ItemRow[]
}

export type ZoneRow = {
  id: string // its first pasted zone that landed in it by itself, else its first pick: the block's key while the preview is open
  tickKey: string // the answer key of its own tick (Put it back), and the start of its rows' ids: z<zoneId> once the zone is decided (matched, picked or made)
  name: string
  kind: ZoneKind
  players: number
  instanceId?: number
  from: 'addon' | 'capture'
  journalPartial?: true
  status: 'matched' | 'unmatched' | 'new'
  how?: 'capture' | 'zoneId' | 'instance' | 'name' | 'pick' | 'made' // made: the zone its own "make" answer made, found again on Save again
  unmatchedWhy?: 'none' | 'tie' | 'catalog'
  options: ListedZone[] // zones a leader can pick for it: those of the same kind and size first
  answerKeys: string[] // the answer keys of the candidates placed in this zone by a pick (to change or take back a pick)
  picks: { answerKey: string; name: string }[] // the same, each with the zone's name in the paste, to label and change each pick
  zoneId?: number
  appName?: string // the matched zone's name, when it differs
  inPhase: boolean
  takenOut: boolean // a leader took it out of this phase: unticked, opt-in, and nothing under it is ticked until it is
  zoneTicked: boolean
  tickIn: boolean // the second call puts the zone in the phase: it isn't, and the import saves something under it, finds its items already there, or a leader ticked it back
  repeatIdentity: boolean // a guild zone first named in a later phase: its write here repeats its name, kind and size (worked example 20)
  madeBefore?: true // a Guild Leader answered "make" and it now matches by itself: a first call of this import made it, so a retry colors it if it has no color
  creatures: CreatureRow[] // in the paste's order; the zone-wide list last
}

export type ImportPreview = { zones: ZoneRow[]; counts: ImportCounts }
export type ImportCounts = { zones: number; newZones: number; creatures: number; newCreatures: number; items: number; journalItems: number; unanswered: number }

// ---- Matching zones (design section 6)

/** The key a zone's name is matched by: Settings' duplicate key with a leading "The " dropped. */
export const importZoneKey = (name: string) => zoneNameKey(name).replace(/^the /, '')
const beforeColon = (key: string) => (key.includes(':') ? key.slice(0, key.indexOf(':')).trim() : undefined)
const creatureKeyOf = (name: string) => zoneNameKey(name)
const FIXED_ZONE_SPAN = CUSTOM_ZONE_MIN - 1 // an instance id up to 49,999,999 gives the fixed zone id 50,000,000 + instance id

type ZoneHit = { zoneId: number; how: NonNullable<ZoneRow['how']> } | { unmatched: NonNullable<ZoneRow['unmatchedWhy']> }

function matchZone(candidate: CandidateZone, listed: ListedZone[]): ZoneHit {
  const lists = listed.filter((zone) => zone.zoneId !== undefined)
  if (candidate.captureZoneId !== undefined) {
    const builtIn = lists.find((zone) => zone.source === 'built-in' && zone.zoneId === candidate.captureZoneId)
    if (builtIn) return { zoneId: builtIn.zoneId as number, how: 'capture' }
  }
  if (candidate.zoneId !== undefined && lists.some((zone) => zone.zoneId === candidate.zoneId)) return { zoneId: candidate.zoneId, how: 'zoneId' }
  if (candidate.instanceId !== undefined && candidate.instanceId <= FIXED_ZONE_SPAN) {
    const fixed = CUSTOM_ZONE_MIN + candidate.instanceId
    if (lists.some((zone) => zone.zoneId === fixed)) return { zoneId: fixed, how: 'instance' }
  }
  const key = importZoneKey(candidate.name)
  for (const wanted of [key, beforeColon(key)]) {
    if (!wanted) continue
    const hits = lists.filter((zone) => importZoneKey(zone.name) === wanted)
    if (hits.length === 1) return { zoneId: hits[0]?.zoneId as number, how: 'name' }
    if (hits.length > 1) return { unmatched: 'tie' }
    if (listed.some((zone) => zone.source === 'catalog' && importZoneKey(zone.name) === wanted)) return { unmatched: 'catalog' }
  }
  return { unmatched: 'none' }
}

const sameKindFirst = (zones: ListedZone[], kind: ZoneKind, players: number) => {
  const rank = (zone: ListedZone) => (zone.kind === kind && zone.players === players ? 0 : 1)
  return [...zones].sort((a, b) => rank(a) - rank(b) || a.name.localeCompare(b.name))
}

// A zone with no document at the phase yet: one the import makes, or a guild zone first named in a later phase (its write here repeats its name).
function blankZone(zoneId: number, phaseNo: number, name: string, kind: ZoneKind, players: number): MergedZone {
  const zoneWide: MergedSource = {
    key: ZONE_WIDE_KEY, docId: sourceDocId(zoneId, ZONE_WIDE_KEY, phaseNo), name: ZONE_WIDE_NAME, kind: 'zonewide', order: TABLE_ORDER_MAX, builtIn: false,
    beforeItemIds: [], addedItemIds: [], hiddenItemIds: [], goneItemIds: [], itemIds: [], removed: false,
  }
  return { zoneId, phaseNo, name, kind, players, custom: true, inPhase: false, edited: false, sources: [], zoneWide }
}

/** Whether a leader took the zone out of this phase: the latest zone document of the phase's chain that says so puts it out. */
function takenOutOf(docs: LootTableDoc[], zoneId: number, phaseNo: number): boolean {
  const chain = new Set(followChain(docs, phaseNo))
  const stated = docs.filter((doc): doc is ZoneTableDoc => doc.type === 'zone' && doc.zoneId === zoneId && chain.has(doc.phaseNo) && typeof doc.removed === 'boolean')
  const latest = stated.sort((a, b) => a.phaseNo - b.phaseNo).at(-1)
  return latest?.removed === true
}

/** Every zone number in use: the built-in captures' and every document's, so a zone the import makes gets a free one. */
export const takenZoneIds = (setup: Pick<ImportSetup, 'captures' | 'docs'>) => new Set<number>([
  ...setup.captures.map((capture) => capture.zoneId),
  ...setup.docs.flatMap((doc) => (doc.type === 'phase' ? [] : [doc.zoneId])),
])

/** The zone id an import gives a zone it makes: fixed from the game's instance id when it can be (a retry finds it), else a new random one. */
export function zoneIdFor(candidate: { instanceId?: number }, taken: Set<number>): number {
  if (candidate.instanceId !== undefined && candidate.instanceId <= FIXED_ZONE_SPAN && !taken.has(CUSTOM_ZONE_MIN + candidate.instanceId)) return CUSTOM_ZONE_MIN + candidate.instanceId
  return newZoneId(taken)
}

// ---- Creatures and items

// A name the rules accept (validTableName: something left after trimming, at most 100 characters), else the fallback. A name of only tabs or other blanks is
// text to the drops string's reader, but the rules refuse it.
const nameOr = (name: string, fallback: string) => { const cut = name.slice(0, TABLE_NAME_MAX).trim(); return hasText(cut) ? cut : fallback }
/** The name a zone the import makes is written with: a raid's cut to what Settings allows, a blank one "Unnamed zone". */
const madeZoneName = (candidate: Pick<CandidateZone, 'name' | 'kind'>) => nameOr(candidate.kind === 'raid' ? candidate.name.slice(0, RAID_ZONE_NAME_MAX) : candidate.name, 'Unnamed zone')
const creatureName = (source: CandidateSource) => nameOr(source.name, source.npcId !== undefined ? `NPC ${source.npcId}` : source.encounterId !== undefined ? `Encounter ${source.encounterId}` : 'Unnamed creature')
const isJournalOnly = (evidence: ItemEvidence) => evidence.journal !== undefined && !evidence.seen && !evidence.ej && !evidence.capture
const nearName = (a: string, b: string) => {
  if (a === b) return false
  const [short, long] = a.length < b.length ? [a, b] : [b, a]
  return short.length > 0 && (long.startsWith(`${short} `) || long.endsWith(` ${short}`))
}

/**
 * A candidate's own answer key, from the candidate alone (its instance, else its name's key): the difficulties of one instance share it. Its pick or make
 * answer is kept by it, and so are its creatures' "same as …" answers (rowIds). It is also the id of the zone row it heads: the block's React key.
 */
const ownIdOf = (candidate: CandidateZone) => `u${candidate.instanceId ?? importZoneKey(candidate.name)}`

// The candidates of one answer key, placed together: matched, picked, made, or unmatched.
type Unit = { id: string; candidates: CandidateZone[]; hit: ZoneHit; picked?: number; make?: boolean; madeId?: number; madeBefore?: boolean }

/** The preview: every zone, creature and item of the paste, matched, with its category and whether it is ticked (the answers, else the default). */
export function buildPreview(candidates: CandidateZone[], setup: ImportSetup, answers: ImportAnswers): ImportPreview {
  const listed = listZones(setup.captures, setup.docs, setup.catalog, setup.currentPhase)
  const merged = mergeTables(setup.captures, setup.docs, setup.phaseNo)
  const taken = takenZoneIds(setup)

  // The candidates by their own answer key, in the paste's order.
  const units: Unit[] = []
  for (const candidate of candidates) {
    const id = ownIdOf(candidate)
    const unit = units.find((one) => one.id === id)
    if (unit) unit.candidates.push(candidate)
    else units.push({ id, candidates: [candidate], hit: { unmatched: 'none' } })
  }
  // A DungeonJournal list (no zone or instance id) joins a pasted zone that has one and the same name key, so one dungeon is one zone, made once.
  const hasGameId = (candidate: CandidateZone) => candidate.zoneId !== undefined || candidate.instanceId !== undefined
  for (const unit of [...units]) {
    if (unit.candidates.some(hasGameId)) continue
    const key = importZoneKey((unit.candidates[0] as CandidateZone).name)
    const joins = units.find((other) => other !== unit && other.candidates.some((candidate) => hasGameId(candidate) && importZoneKey(candidate.name) === key))
    if (!joins) continue
    joins.candidates.push(...unit.candidates)
    units.splice(units.indexOf(unit), 1)
  }
  const unitOf = new Map(units.flatMap((unit) => unit.candidates.map((candidate) => [candidate, unit.id] as const)))
  // Each placed by its first candidate the lists match (else its first candidate's miss), or by the leader's answer: a pick, or a zone to make.
  const groups = new Map<string, Unit[]>()
  for (const unit of units) {
    const hits = unit.candidates.map((candidate) => matchZone(candidate, listed))
    unit.hit = hits.find((hit) => 'zoneId' in hit) ?? (hits[0] as ZoneHit)
    const given = answers.zones[unit.id]
    // Save again after a first call that made the zone: it lands in the zone its "make" answer gave the id to, whatever that zone is named (a blank name
    // is written "Unnamed zone", a long raid name is cut). Another pasted zone with such a name is asked about again.
    if (!('zoneId' in unit.hit) && given && 'make' in given && given.zoneId !== undefined && listed.some((zone) => zone.zoneId === given.zoneId)) unit.hit = { zoneId: given.zoneId, how: 'made' }
    const answer = 'zoneId' in unit.hit ? undefined : given
    if ('zoneId' in unit.hit && setup.canMakeZones && given && 'make' in given && (given.zoneId === undefined || given.zoneId === unit.hit.zoneId)) unit.madeBefore = true
    if (answer && 'pick' in answer && listed.some((zone) => zone.zoneId === answer.pick)) unit.picked = answer.pick
    if (answer && 'make' in answer && setup.canMakeZones) { unit.make = true; if (answer.zoneId !== undefined) unit.madeId = answer.zoneId }
    const place = unit.picked !== undefined ? `z${unit.picked}` : 'zoneId' in unit.hit ? `z${unit.hit.zoneId}` : `${unit.make ? 'm' : 'u'}${unit.id}`
    groups.set(place, [...(groups.get(place) ?? []), unit])
  }

  const zones: ZoneRow[] = []
  const order = new Map(candidates.map((candidate, index) => [candidate, index]))
  for (const placed of groups.values()) {
    // A zone row is headed by its first candidate that landed there by itself, so a pick into it never changes its keys; else by its first pick.
    const head = placed.find((unit) => unit.picked === undefined) ?? (placed[0] as Unit)
    const group: { id: string; hit: ZoneHit; make: boolean; madeId?: number } = { id: head.id, hit: head.picked !== undefined ? { zoneId: head.picked, how: 'pick' } : head.hit, make: head.make === true, ...(head.madeId !== undefined ? { madeId: head.madeId } : {}) }
    const inPaste = placed.flatMap((unit) => unit.candidates).sort((a, b) => (order.get(a) ?? 0) - (order.get(b) ?? 0))
    const first = head.candidates[0] as CandidateZone
    const picks = placed.filter((unit) => unit.picked !== undefined).map((unit) => ({ answerKey: unit.id, name: (unit.candidates[0] as CandidateZone).name }))
    const base = {
      id: group.id, name: first.name, kind: first.kind, players: first.players, ...(first.instanceId !== undefined ? { instanceId: first.instanceId } : {}), from: first.from,
      ...(inPaste.some((candidate) => candidate.journalPartial) ? { journalPartial: true as const } : {}),
      options: sameKindFirst(listed.filter((zone) => zone.zoneId !== undefined), first.kind, first.players),
      answerKeys: picks.map((pick) => pick.answerKey), picks,
    }
    const sources = mergeCandidateSources(inPaste.flatMap((candidate) => candidate.sources))
    const zoneWide = inPaste.flatMap((candidate) => candidate.zoneWide)

    let target: MergedZone | undefined
    let status: ZoneRow['status']
    let repeatIdentity = false
    if ('zoneId' in group.hit) {
      const zoneId = group.hit.zoneId
      const here = merged.find((zone) => zone.zoneId === zoneId)
      const identity = listed.find((zone) => zone.zoneId === zoneId)
      target = here ?? (identity ? blankZone(zoneId, setup.phaseNo, identity.name, identity.kind, identity.players) : undefined)
      repeatIdentity = !here && identity?.source === 'guild'
      status = 'matched'
    } else if (group.make) {
      const zoneId = group.madeId !== undefined && group.madeId >= CUSTOM_ZONE_MIN && !taken.has(group.madeId) ? group.madeId : zoneIdFor(first, taken)
      taken.add(zoneId)
      target = blankZone(zoneId, setup.phaseNo, madeZoneName(first), first.kind, first.players)
      status = 'new'
    } else {
      status = 'unmatched'
    }

    if (!target) {
      // Nothing can be ticked or answered under a zone that isn't decided: its rows' ids start with its own key.
      zones.push({ ...base, tickKey: group.id, status: 'unmatched', unmatchedWhy: 'zoneId' in group.hit ? 'none' : group.hit.unmatched, inPhase: false, takenOut: false, zoneTicked: false, tickIn: false, repeatIdentity: false, creatures: creatureRowsUnmatched(rowIds(group.id, inPaste, unitOf, group.id, sources), sources, zoneWide) })
      continue
    }
    // The answers about the zone it lands in, and about its creatures and items, are kept under that zone: the same whichever pasted zone heads the
    // block, and before and after the first call of a save makes it (a made zone's id is the one its make answer carries).
    const tickKey = `z${target.zoneId}`
    const ids = rowIds(tickKey, inPaste, unitOf, group.id, sources)
    const takenOut = status === 'matched' && !target.inPhase && takenOutOf(setup.docs, target.zoneId, setup.phaseNo)
    const zoneTicked = takenOut ? answers.ticks[tickKey] === true : true
    const creatures = creatureRows(ids, target, sources, zoneWide, setup, answers, zoneTicked)
    // A retry after a first call that landed finds everything already there: the tick is what's left (worked example 4). A zone a leader took out and a
    // leader ticks is put back by that tick alone.
    const tickIn = !target.inPhase && zoneTicked && (takenOut || creatures.some((creature) => creature.saved || creature.items.some((item) => item.status === 'already')))
    zones.push({
      ...base, tickKey, status, ...(status === 'matched' ? { how: (group.hit as { how: NonNullable<ZoneRow['how']> }).how } : {}), zoneId: target.zoneId,
      ...(status === 'matched' && target.name !== first.name ? { appName: target.name } : {}),
      ...(status === 'new' ? { name: target.name } : {}),
      inPhase: target.inPhase, takenOut, zoneTicked, tickIn, repeatIdentity, creatures,
      ...(status === 'matched' && placed.some((unit) => unit.picked === undefined && unit.madeBefore) ? { madeBefore: true as const } : {}),
    })
  }
  return { zones, counts: countsOf(zones) }
}

// The ids of a block's rows, which its answers are kept by (design section 7, "Answers"): the zone's key (z<zoneId>) with the key of the creature the row
// writes to (the creature it found, or the key a new one is made with), or "zonewide". So they never depend on which pasted zone heads the block, on the
// paste's order, or on which sources land on the creature. "Same as …" is the one answer about the pasted creature: its keys are those of every pasted
// creature that lands on the source (the own key of its pasted zone in the block, with its identity, pastedKeyOf), in sort order. The panel writes the
// answer under each of them and the preview reads the first that applies, so taking back one pick keeps it. Rolls of an encounter that the block's merge
// joined to its one corpse (mergeCandidateSources) are among the corpse's pasted creatures.
type RowIds = { creature: (key: string) => string; zoneWide: string; answerKeys: (source: CandidateSource) => string[] }
function rowIds(prefix: string, inPaste: CandidateZone[], unitOf: Map<CandidateZone, string>, head: string, merged: CandidateSource[]): RowIds {
  return {
    creature: (key) => `${prefix}|c${key}`,
    zoneWide: `${prefix}|zonewide`,
    answerKeys: (source) => {
      const identity = pastedKeyOf(source)
      const lands = (one: CandidateSource) => pastedKeyOf(one) === identity
        || (one.npcId === undefined && one.encounterId !== undefined && source.npcId !== undefined && source.encounterId === one.encounterId && !merged.some((other) => pastedKeyOf(other) === pastedKeyOf(one)))
      const keys = inPaste.flatMap((candidate) => candidate.sources.filter(lands).map((one) => `${unitOf.get(candidate) ?? head}|c${pastedKeyOf(one)}`))
      return [...new Set(keys.length ? keys : [`${head}|c${identity}`])].sort()
    },
  }
}

// An unmatched zone's rows: shown so the leader sees what it holds, nothing tickable until a zone is picked.
function creatureRowsUnmatched(ids: RowIds, sources: CandidateSource[], zoneWide: CandidateItem[]): CreatureRow[] {
  const rows: CreatureRow[] = sources.map((source) => ({
    id: ids.creature(pastedKeyOf(source)), name: creatureName(source), kind: source.kind, ...sourceFacts(source), status: 'new', near: [], rename: false, saved: false, creatureTickable: false,
    items: source.items.map((item) => ({ id: `${ids.creature(pastedKeyOf(source))}|${item.itemId}`, itemId: item.itemId, evidence: item.evidence, status: 'new', journalOnly: isJournalOnly(item.evidence), tickable: false, ticked: false })),
  }))
  if (zoneWide.length) rows.push({ id: ids.zoneWide, name: ZONE_WIDE_NAME, kind: 'zonewide', status: 'zoneWide', near: [], rename: false, saved: false, creatureTickable: false, items: zoneWide.map((item) => ({ id: `${ids.zoneWide}|${item.itemId}`, itemId: item.itemId, evidence: item.evidence, status: 'new', journalOnly: false, tickable: false, ticked: false })) })
  return rows
}

// A pasted creature's identity: the merge's own key (dropsNameKey for a name), so two creatures it keeps apart never share one. A row of a zone that isn't
// decided is keyed by it, and so is a "same as …" answer.
const pastedKeyOf = (source: { npcId?: number; encounterId?: number; name: string }) => (source.npcId !== undefined ? `n${source.npcId}` : source.encounterId !== undefined ? `e${source.encounterId}` : `t${dropsNameKey(source.name)}`)
const sourceFacts = (source: CandidateSource) => ({
  ...(source.npcId !== undefined ? { npcId: source.npcId } : {}), ...(source.encounterId !== undefined ? { encounterId: source.encounterId } : {}),
  ...(source.guessed ? { guessed: true as const } : {}), ...(source.kills !== undefined ? { kills: source.kills } : {}),
  ...(source.first !== undefined ? { first: source.first } : {}), ...(source.last !== undefined ? { last: source.last } : {}),
})

// `unnamed`: a new creature whose key has documents already that no document of the chain names (written while the phase followed another), as it is
// once the import names it.
type Draft = { row: CreatureRow; candidates: CandidateSource[]; existing?: MergedSource; unnamed?: Named }
// A source as it was placed: how it found its creature, and its "same as …" question (near names) with the keys its answer is kept by and the answer.
type Placed = { source: CandidateSource; how?: CreatureRow['how']; near: { key: string; name: string }[]; answer?: CreatureAnswer; answerKeys: string[] }
type Named = { zone: MergedZone; source: MergedSource }

/**
 * A creature key whose documents in the phase's follow chain name nothing, so the merge leaves it out (a leader changed its items while this phase
 * followed another, and the link was then taken away): the zone and the creature as they are once the import names it. Its items, the room its
 * document has left and the items it takes off then show, and the save names it in its document's one write instead of creating a document that exists.
 */
function unnamedCreature(setup: Pick<ImportSetup, 'captures' | 'docs' | 'phaseNo'>, zoneId: number, key: string, name: string): Named | undefined {
  const chain = new Set(followChain(setup.docs, setup.phaseNo))
  const own = setup.docs.filter((doc): doc is SourceTableDoc => doc.type === 'source' && doc.zoneId === zoneId && doc.key === key && doc.phaseNo <= setup.phaseNo && chain.has(doc.phaseNo))
  const last = own.sort((a, b) => a.phaseNo - b.phaseNo).at(-1)
  if (!last) return undefined
  const zone = mergeTables(setup.captures, setup.docs.map((doc) => (doc === last ? { ...last, name } : doc)), setup.phaseNo).find((candidate) => candidate.zoneId === zoneId)
  const source = zone?.sources.find((candidate) => candidate.key === key)
  return zone && source ? { zone, source } : undefined
}
/**
 * The key a new creature is made with, the same on every build: n and its npc id, else e and its encounter, else t and a hash of its name's key (the
 * merge's, so two creatures it keeps apart get two keys). It never starts with "npc", which the rules keep for the built-in captures' creatures.
 */
const plannedKey = (source: CandidateSource) => (source.npcId !== undefined ? `n${source.npcId}` : source.encounterId !== undefined ? `e${source.encounterId}` : `t${nameHash(dropsNameKey(source.name))}`)
// FNV-1a over the name's UTF-16 code units, 64 bits, in base 36: at most 13 characters.
function nameHash(text: string): string {
  let hash = 0xcbf29ce484222325n
  for (let index = 0; index < text.length; index += 1) hash = ((hash ^ BigInt(text.charCodeAt(index))) * 0x100000001b3n) & 0xffffffffffffffffn
  return hash.toString(36)
}

// The first creature that fits, one in the lists before one a leader took out.
const liveFirst = (creatures: MergedSource[], fits: (creature: MergedSource) => boolean) => creatures.find((creature) => !creature.removed && fits(creature)) ?? creatures.find(fits)

function creatureRows(ids: RowIds, zone: MergedZone, sources: CandidateSource[], fromCapture: CandidateItem[], setup: ImportSetup, answers: ImportAnswers, zoneTicked: boolean): CreatureRow[] {
  const existing = zone.sources // removed ones included: an item on a creature a leader took out stays there
  // Each source finds its creature (or none); sources that find one creature are placed on one row.
  const slots: { found?: MergedSource; placed: Placed[] }[] = []
  const byExisting = new Map<string, Placed[]>()
  // A new creature's row by its name (the merge's name key): a source that finds no creature and isn't answered "same as …" joins the new creature of the same name, as it would join
  // that creature once it is in the lists (found by name). Two difficulties of a new boss, or a corpse and DungeonJournal's entry without an npc id, so
  // make one creature, and Save again finds the same one. Sources known by an id are placed first, so the row is a corpse's or rolls'.
  const newByName = new Map<string, Placed[]>()
  const nameOnly = (source: CandidateSource) => source.npcId === undefined && source.encounterId === undefined
  // The npc ids this paste brings: a creature this import's own first call gave one of them is still the creature a "same as …" answer named.
  // The "same as …" answers this paste's corpses carry, by the creature they name: a creature this import's own first call gave one of those npc ids is
  // still the creature the answers named, so Save again asks and answers as before (two difficulties of one boss, or a corpse and DungeonJournal's entry).
  const sameOf = (source: CandidateSource) => {
    const given = ids.answerKeys(source).map((key) => answers.creatures[key]).find((one) => one !== undefined && 'same' in one)
    return given && 'same' in given ? given.same : undefined
  }
  const answeredNpcIds = new Map<string, Set<number>>()
  for (const source of sources) {
    const same = sameOf(source)
    if (same !== undefined && source.npcId !== undefined) answeredNpcIds.set(same, (answeredNpcIds.get(same) ?? new Set<number>()).add(source.npcId))
  }
  // A near name is asked (worked example 15). A creature with an npc id isn't a near name, except one whose npc id a "same as …" answer of this paste
  // put there.
  const nearOf = (source: CandidateSource) => existing.filter((creature) => !creature.builtIn && creature.kind === source.kind
    && (creature.npcId === undefined || (creature.npcId !== source.npcId && answeredNpcIds.get(creature.key)?.has(creature.npcId) === true))
    && nearName(creatureKeyOf(creature.name), creatureKeyOf(source.name))).map((creature) => ({ key: creature.key, name: creature.name }))
  // The first of a source's keys that holds an answer that applies: "new", or "same as" one of its near names (one that isn't is ignored).
  const answerOf = (answerKeys: string[], near: { key: string }[]) => (near.length ? answerKeys.map((key) => answers.creatures[key]).find((one) => one !== undefined && ('make' in one || near.some((option) => option.key === one.same))) : undefined)
  for (const source of [...sources.filter((one) => !nameOnly(one)), ...sources.filter(nameOnly)]) {
    const answerKeys = ids.answerKeys(source)
    let found: MergedSource | undefined
    let how: CreatureRow['how']
    let near: { key: string; name: string }[] = []
    let answer: CreatureAnswer | undefined
    if (source.npcId !== undefined) { found = liveFirst(existing, (creature) => creature.npcId === source.npcId); how = 'npc' }
    // A corpse joins the creature made from its encounter's rolls only when that creature has no other npc id and the corpse is the encounter's only one
    // here: in a fight of several bosses, which corpse dropped the rolled items isn't known (as mergeCandidateSources has it). Rolls (no npc id) always
    // join it, also once it has learned its npc id.
    if (!found && source.encounterId !== undefined && (source.npcId === undefined || sources.filter((other) => other.npcId !== undefined && other.encounterId === source.encounterId).length === 1)) {
      found = existing.find((creature) => creature.key === `e${source.encounterId}` && (source.npcId === undefined || creature.npcId === undefined || creature.npcId === source.npcId))
      how = 'encounter'
    }
    // A "same as …" the leader gave still applies before a name match: on Save again, a creature the first call made with this source's name is another
    // source's, not the one the leader named.
    if (!found && sameOf(source) !== undefined) {
      near = nearOf(source)
      answer = answerOf(answerKeys, near)
      if (answer && 'same' in answer) { const same = answer.same; found = existing.find((creature) => creature.key === same); how = 'answer' }
      else { near = []; answer = undefined }
    }
    if (!found) { found = liveFirst(existing, (creature) => creatureKeyOf(creature.name) === creatureKeyOf(source.name)); how = 'name' }
    // A creature known by its name alone is also found by the key the import made it with, so Save again finds it when it was written under another name
    // (a blank one "Unnamed creature", a long one cut to fit) or a leader renamed it.
    if (!found && source.npcId === undefined && source.encounterId === undefined) { const key = plannedKey(source); found = existing.find((creature) => creature.key === key); how = 'name' }
    // Not answered "same as …": it joins the new creature of its name, if there is one (asked about or not, or answered "A new creature": one answer
    // covers them all, and "A new creature" keeps them one creature).
    if (!found && hasText(source.name) && sameOf(source) === undefined) {
      const sameName = newByName.get(dropsNameKey(source.name))
      if (sameName) { sameName.push({ source, near: [], answerKeys }); continue }
    }
    if (!found) {
      near = nearOf(source)
      answer = answerOf(answerKeys, near)
      if (answer && 'same' in answer) { const same = answer.same; found = existing.find((creature) => creature.key === same); how = 'answer' }
    }
    const placed: Placed = { source, ...(found && how ? { how } : {}), near, ...(answer ? { answer } : {}), answerKeys }
    const there = found && byExisting.get(found.key)
    if (there) { there.push(placed); continue }
    const slot = { ...(found ? { found } : {}), placed: [placed] }
    if (found) byExisting.set(found.key, slot.placed)
    else if (hasText(source.name) && !newByName.has(dropsNameKey(source.name))) newByName.set(dropsNameKey(source.name), slot.placed)
    slots.push(slot)
  }
  // Back in the paste's order: rows, and the sources on each row.
  const pasteOrder = new Map(sources.map((source, index) => [source, index]))
  const at = (one: Placed) => pasteOrder.get(one.source) ?? 0
  for (const slot of slots) slot.placed.sort((a, b) => at(a) - at(b))
  slots.sort((a, b) => at(a.placed[0] as Placed) - at(b.placed[0] as Placed))

  const drafts: Draft[] = []
  for (const { found, placed } of slots) {
    if (found) {
      // The row's id is the creature's key, whichever sources land on it. It shows a source that found the creature by itself before one placed by "same
      // as …" (then the paste's order), and keeps a "same as …" question, so a leader can change it, and the npc id that answer stores.
      const head = placed.find((one) => one.how !== 'answer') ?? (placed[0] as Placed)
      const source = head.source
      const id = ids.creature(found.key)
      const asked = placed.find((one) => one.near.length)
      // The question's keys: every pasted creature on this row that was asked, so one answer changes them all (two answered sources share one select).
      const askedKeys = [...new Set(placed.filter((one) => one.near.length).flatMap((one) => one.answerKeys))]
      const npcId = [head, ...placed].find((one) => one.source.npcId !== undefined)?.source.npcId
      const differs: CreatureRow['differs'] = {}
      if (!found.builtIn) {
        if (creatureKeyOf(found.name) !== creatureKeyOf(source.name) && hasText(source.name)) differs.name = source.name
        if (found.kind !== 'zonewide' && found.kind !== source.kind) differs.kind = source.kind
      }
      drafts.push({
        row: {
          id, name: found.name, kind: found.kind, ...sourceFacts(source), status: found.removed ? 'takenOut' : 'matched', ...(head.how ? { how: head.how } : {}), key: found.key, near: asked?.near ?? [],
          ...(Object.keys(differs).length ? { differs } : {}), rename: Object.keys(differs).length > 0 && answers.renames[id] === true,
          ...(asked ? { answerKeys: askedKeys, ...(asked.answer ? { answer: asked.answer } : {}) } : {}),
          ...(npcId !== undefined && found.npcId === undefined && !found.builtIn ? { storeNpcId: npcId } : {}),
          saved: false, creatureTickable: false, items: [],
        },
        candidates: placed.map((one) => one.source), existing: found,
      })
    } else {
      // A new creature (or one asked about): its row's id is the key it is made with, given with its place below (placeNewCreatures).
      // A source known by its name alone may have joined it (newByName): the row is the corpse's or the rolls', and its question is asked for both.
      const { source, near, answer } = placed.find((one) => !nameOnly(one.source)) ?? (placed[0] as Placed)
      const answerKeys = [...new Set(placed.flatMap((one) => one.answerKeys))]
      const planned = plannedKey(source)
      const unnamed = !existing.some((creature) => creature.key === planned) ? unnamedCreature(setup, zone.zoneId, planned, creatureName(source)) : undefined
      const question = near.length ? { answerKeys, ...(answer ? { answer } : {}) } : {}
      drafts.push({ row: { id: '', name: creatureName(source), kind: source.kind, ...sourceFacts(source), status: near.length && !answer ? 'unmatched' : 'new', near, ...question, rename: false, saved: false, creatureTickable: false, items: [] }, candidates: [source, ...placed.map((one) => one.source).filter((one) => one !== source)], ...(unnamed ? { unnamed } : {}) })
    }
  }

  placeNewCreatures(zone, drafts, new Set(setup.docs.map((doc) => doc.id)), ids)

  // Items: a creature that is saved claims what it saves in the paste's order, bosses and rares before trash, and before the zone-wide list.
  const holders = new Map<number, string>()
  // Creatures in the lists first, so an item two hold is named where it shows; one a leader took out is named so ("taken out").
  // A document with no name that the import names holds its items as that creature, so no other row of the save puts one on a second creature.
  const unnamed = drafts.flatMap((draft) => (draft.unnamed ? [draft.unnamed.source] : []))
  for (const creature of [...existing.filter((one) => !one.removed), zone.zoneWide, ...existing.filter((one) => one.removed), ...unnamed]) for (const id of creature.itemIds) if (!holders.has(id)) holders.set(id, creature.removed ? `${creature.name} (taken out)` : creature.name)
  const claims = new Map<number, string>()
  const trashCount = new Map<number, number>()
  for (const draft of drafts) if (draft.row.kind === 'trash') for (const id of new Set(draft.candidates.flatMap((candidate) => candidate.items.map((item) => item.itemId)))) if (!holders.has(id)) trashCount.set(id, (trashCount.get(id) ?? 0) + 1)
  const offered = new Set([...trashCount].filter(([, count]) => count >= 2).map(([id]) => id))

  const zoneWideDraft: Draft = {
    row: { id: ids.zoneWide, name: ZONE_WIDE_NAME, kind: 'zonewide', status: 'zoneWide', key: ZONE_WIDE_KEY, near: [], rename: false, saved: false, creatureTickable: false, items: [] },
    candidates: [], existing: zone.zoneWide,
  }
  const zoneWideItems = [...fromCapture, ...drafts.filter((draft) => draft.row.kind === 'trash').flatMap((draft) => draft.candidates.flatMap((candidate) => candidate.items.filter((item) => offered.has(item.itemId))))]
  const ordered = [...drafts.filter((draft) => draft.row.kind !== 'trash'), zoneWideDraft, ...drafts.filter((draft) => draft.row.kind === 'trash')]
  // Each row's items in the paste's order, every item once with the evidence of all its candidates.
  const itemsOf = new Map(ordered.map((draft) => {
    const items = new Map<number, CandidateItem>()
    for (const item of draft === zoneWideDraft ? zoneWideItems : draft.candidates.flatMap((candidate) => candidate.items)) {
      const there = items.get(item.itemId)
      items.set(item.itemId, there ? { itemId: item.itemId, evidence: mergeEvidence(there.evidence, item.evidence) } : item)
    }
    return [draft, [...items.values()]]
  }))
  // An item the game saw (or a capture or the game's journal lists) under a row is that row's: a DungeonJournal-only listing of it under another row
  // yields to it, whatever the order and whatever is ticked.
  const seenUnder = new Map<number, Draft>()
  for (const draft of ordered) for (const item of itemsOf.get(draft) ?? []) if (!isJournalOnly(item.evidence) && !seenUnder.has(item.itemId)) seenUnder.set(item.itemId, draft)
  const yielded: ItemRow[] = [] // those listings: once every row is known, each names the row that saves the item
  for (const draft of ordered) {
    const isZoneWide = draft === zoneWideDraft
    const items = itemsOf.get(draft) ?? []
    const creature = draft.existing ?? draft.unnamed?.source
    let room = TABLE_ITEMS_MAX - (creature?.doc?.itemIds.length ?? 0)
    const decided = draft.row.status === 'unmatched' ? false : zoneTicked
    const itemRows = new Map<number, ItemRow>()
    // Items with the game's evidence take the room first, so ticking DungeonJournal's never pushes one into "no room". Shown in the paste's order.
    for (const item of [...items.filter((one) => !isJournalOnly(one.evidence)), ...items.filter((one) => isJournalOnly(one.evidence))]) {
      const id = `${draft.row.id}|${item.itemId}`
      const journalOnly = isJournalOnly(item.evidence)
      let status: ItemStatus
      let where: string | undefined
      if (creature?.itemIds.includes(item.itemId)) status = 'already'
      else if (holders.has(item.itemId)) { status = 'elsewhere'; where = holders.get(item.itemId) }
      else if (claims.has(item.itemId)) { status = 'claimed'; where = claims.get(item.itemId) } // before taken off, so a tick never puts one item on two creatures
      else if (journalOnly && seenUnder.has(item.itemId) && seenUnder.get(item.itemId) !== draft) { status = 'claimed'; where = seenUnder.get(item.itemId)?.row.name }
      else if (creature && (creature.hiddenItemIds.includes(item.itemId) || creature.goneItemIds.includes(item.itemId))) status = 'takenOff'
      else if (!isZoneWide && draft.row.kind === 'trash' && offered.has(item.itemId)) { status = 'zoneWide'; where = ZONE_WIDE_NAME }
      else if (journalOnly && !setup.journalSaving) status = 'journal'
      else status = 'new'
      if ((status === 'new' || status === 'takenOff') && room <= 0) status = 'noRoom'
      const tickable = decided && (status === 'new' || status === 'takenOff')
      const byDefault = status === 'new' && !journalOnly && !item.evidence.seen?.quest && !(draft.row.kind === 'trash') && !(isZoneWide && !item.evidence.capture)
      const ticked = tickable && (answers.ticks[id] ?? byDefault)
      if (ticked) room -= 1 // only an item that is ticked takes room
      const row: ItemRow = { id, itemId: item.itemId, evidence: item.evidence, status, ...(where ? { where } : {}), journalOnly, tickable, ticked }
      if (status === 'claimed' && !claims.has(item.itemId)) yielded.push(row)
      itemRows.set(item.itemId, row)
    }
    draft.row.items.push(...items.map((item) => itemRows.get(item.itemId) as ItemRow))
    // The creature itself: a new one is written when something under it is ticked, or (a boss with no items yet, a guessed boss) when a leader ticks it.
    // One whose document is there with no name is written by default, also when its items are all on that document: naming it is what shows them.
    const anyTicked = draft.row.items.some((item) => item.ticked)
    if (draft.row.status === 'new') {
      const optIn: CreatureRow['optIn'] = draft.row.guessed ? 'guessed' : !anyTicked && !draft.unnamed ? 'noItems' : undefined
      draft.row.creatureTickable = decided
      draft.row.saved = decided && (answers.ticks[draft.row.id] ?? (!optIn))
      if (optIn) draft.row.optIn = optIn
      if (!draft.row.saved) for (const item of draft.row.items) item.ticked = false
    } else if (draft.row.status === 'takenOut') {
      draft.row.optIn = 'takenOut'
      draft.row.creatureTickable = decided
      draft.row.saved = decided && answers.ticks[draft.row.id] === true
      if (!draft.row.saved) for (const item of draft.row.items) item.ticked = false
    } else if (draft.row.status === 'matched' || draft.row.status === 'zoneWide') {
      draft.row.saved = anyTicked || draft.row.rename || draft.row.storeNpcId !== undefined
    }
    // Only what is saved claims its item: an unticked item, or one under a creature that isn't saved, leaves it to the rows after (the first saved row wins).
    if (draft.row.saved) for (const item of draft.row.items) if (item.ticked) claims.set(item.itemId, draft.row.name)
  }
  // A DungeonJournal listing that yielded names the creature that saves the item, when one does (a row after the one that saw it first may), else the
  // first that saw it.
  for (const row of yielded) row.where = claims.get(row.itemId) ?? row.where
  const rows = drafts.map((draft) => draft.row)
  return zoneWideDraft.row.items.length ? [...rows, zoneWideDraft.row] : rows
}

// The keys and places of new creatures (design section 6, "Order"), and so their rows' ids: one right after the matched creature it follows in the paste
// when there's room, else after the zone's last creature, in the paste's order. Its key is plannedKey's. A creature whose key has documents no document
// of the chain names keeps that key: the save names it in one write (unnamedCreature). When the key is another creature's, or its document is there
// already, it gets the same other key on every build (freeKey): the save never creates a document that exists (section 7).
function placeNewCreatures(zone: MergedZone, drafts: Draft[], docIds: Set<string>, ids: RowIds) {
  const orders = zone.sources.map((creature) => creature.order)
  const used = new Set(orders)
  let end = Math.max(0, ...orders)
  let after: number | undefined
  const keys = new Set(zone.sources.map((creature) => creature.key))
  for (const draft of drafts) {
    if (draft.existing) { after = draft.existing.order; continue }
    const key = draft.unnamed?.source.key ?? freeKey(plannedKey(draft.candidates[0] as CandidateSource), (one) => keys.has(one) || docIds.has(sourceDocId(zone.zoneId, one, zone.phaseNo)))
    keys.add(key)
    draft.row.key = key
    draft.row.id = ids.creature(key)
    const nextUp = after === undefined ? undefined : Math.min(...orders.filter((order) => order > (after as number)), TABLE_ORDER_MAX + 1)
    if (after !== undefined && nextUp !== undefined && after + 1 < nextUp && !used.has(after + 1)) after += 1
    else { end = Math.min(TABLE_ORDER_MAX, end + 10); after = undefined }
    const order = after ?? end
    used.add(order)
    draft.row.order = order
  }
}

// The key itself when it is free, else the first free of key x2 to key x99 (the same on every build, and still the creature's once it is made, which a
// random key wouldn't be), and only past those a random one.
function freeKey(key: string, taken: (key: string) => boolean): string {
  if (!taken(key)) return key
  for (let count = 2; count < 100; count += 1) if (!taken(`${key}x${count}`)) return `${key}x${count}`
  return newCreatureKey()
}

function countsOf(zones: ZoneRow[]): ImportCounts {
  const counts: ImportCounts = { zones: 0, newZones: 0, creatures: 0, newCreatures: 0, items: 0, journalItems: 0, unanswered: 0 }
  for (const zone of zones) {
    if (zone.status === 'unmatched') { counts.unanswered += 1; continue }
    const saved = zone.creatures.filter((creature) => creature.saved)
    counts.unanswered += zone.creatures.filter((creature) => creature.status === 'unmatched').length
    if ((!saved.length && !zone.tickIn) || !zone.zoneTicked) continue
    counts.zones += 1
    if (zone.status === 'new') counts.newZones += 1
    counts.creatures += saved.filter((creature) => creature.status !== 'zoneWide').length
    counts.newCreatures += saved.filter((creature) => creature.status === 'new').length
    for (const creature of saved) for (const item of creature.items) if (item.ticked) { if (item.journalOnly) counts.journalItems += 1; else counts.items += 1 }
  }
  return counts
}

// ---- Saving (design section 7): two calls, one write per document in each

/** The documents as they stand after some writes: what the second call is built from, as writeLootTables writes them (a create is revision 1). */
export function applyWrites(docs: LootTableDoc[], writes: TableWrite[]): LootTableDoc[] {
  const byId = new Map(docs.map((doc) => [doc.id, doc]))
  for (const write of writes) {
    if ('create' in write) byId.set(write.id, { ...(Object.fromEntries(Object.entries(write.create).filter(([, value]) => value !== undefined)) as NewTableDoc), id: write.id, rev: 1 } as LootTableDoc)
    else {
      const next: Record<string, unknown> = { ...write.existing, rev: write.existing.rev + 1 }
      for (const [key, value] of Object.entries(write.changes)) { if (value === undefined) delete next[key]; else next[key] = value }
      byId.set(write.id, next as LootTableDoc)
    }
  }
  return [...byId.values()]
}

// One write for a creature that exists: its items (addItems works out the lists), and whatever else the import changes, merged into one document write.
function existingCreatureWrite(zone: MergedZone, creature: MergedSource, itemIds: number[], extra: TableChange): TableWrite | null {
  const items = itemIds.length ? addItems(zone, creature, itemIds).write : null
  if (!items && !Object.keys(extra).length) return null
  if (items && 'create' in items) return { id: items.id, create: { ...items.create, ...extra } as NewTableDoc }
  if (items) return { id: items.id, existing: items.existing, changes: { ...items.changes, ...extra } }
  if (creature.doc) return { id: creature.doc.id, existing: creature.doc, changes: extra }
  return { id: creature.docId, create: { type: 'source', zoneId: zone.zoneId, key: creature.key, phaseNo: zone.phaseNo, itemIds: [], hiddenItemIds: [], ...extra } as NewTableDoc }
}

/** DungeonJournal's items listed by one version of it, or by the same set of versions, saved in their own call with their Log reason (journalReason). */
export type JournalCall = { versions: string[]; writes: TableWrite[] }
export type ImportSave = {
  first: TableWrite[]
  /** The zones the first call makes: a Guild Leader's save gives each a suggested color (madeZoneColors) once its document has landed. */
  made: number[]
  /** The zones an earlier save of this import made (ZoneRow.madeBefore): a retry gives one its color when it has none. */
  madeBefore: number[]
  /** The second call, from the documents after the first (applyWrites): the zones' ticks, and DungeonJournal's items in their own calls, by version. */
  second: (after: LootTableDoc[]) => { ticks: TableWrite[]; journal: JournalCall[] }
}

/** The writes of a save. Rows that are unanswered, unticked or information only write nothing; nothing is removed. */
export function buildImportSave(preview: ImportPreview, setup: ImportSetup): ImportSave {
  const first: TableWrite[] = []
  const merged = mergeTables(setup.captures, setup.docs, setup.phaseNo)
  const listed = listZones(setup.captures, setup.docs, setup.catalog, setup.currentPhase)
  const plans: { zone: ZoneRow; journal: { key: string; itemId: number; versions: string[] }[] }[] = []
  const made: number[] = []
  const madeBefore = preview.zones.flatMap((zone) => (zone.madeBefore && zone.zoneId !== undefined ? [zone.zoneId] : []))
  for (const zone of preview.zones) {
    if (zone.status === 'unmatched' || zone.zoneId === undefined || !zone.zoneTicked) continue
    const saved = zone.creatures.filter((creature) => creature.saved)
    if (!saved.length && !zone.tickIn) continue
    // A zone with no document at this phase: one the import makes (its own name), or a guild zone first named later (its name, kind and size as listed).
    const identity = zone.status === 'new' ? zone : listed.find((candidate) => candidate.zoneId === zone.zoneId) ?? zone
    const target = merged.find((candidate) => candidate.zoneId === zone.zoneId) ?? blankZone(zone.zoneId, setup.phaseNo, identity.name, identity.kind, identity.players)
    if (zone.status === 'new') {
      first.push({ id: zoneDocId(zone.zoneId, setup.phaseNo), create: { type: 'zone', zoneId: zone.zoneId, phaseNo: setup.phaseNo, name: zone.name, kind: zone.kind, players: zone.players } })
      made.push(zone.zoneId)
    }
    else if (zone.repeatIdentity) first.push({ id: zoneDocId(zone.zoneId, setup.phaseNo), create: { type: 'zone', zoneId: zone.zoneId, phaseNo: setup.phaseNo, name: target.name, kind: target.kind, players: target.players } })
    const journal: { key: string; itemId: number; versions: string[] }[] = []
    for (const row of saved) {
      const now = row.items.filter((item) => item.ticked && !item.journalOnly).map((item) => item.itemId)
      const later = row.items.filter((item) => item.ticked && item.journalOnly)
      if (row.status === 'new') {
        const key = row.key as string
        const id = sourceDocId(zone.zoneId, key, setup.phaseNo)
        const identity = { name: nameOr(row.name, 'Unnamed creature'), kind: row.kind as LootSourceKind, ...(row.npcId !== undefined ? { npcId: row.npcId } : {}), order: row.order ?? TABLE_ORDER_MAX }
        const unnamed = unnamedCreature(setup, zone.zoneId, key, identity.name)
        if (unnamed) {
          // Its documents are there with no name: one write names it, puts it back when one took it out, and adds the items to what its document holds.
          const items = now.length ? addItems(unnamed.zone, unnamed.source, now).write : null
          const lists = !items ? {} : 'create' in items ? { itemIds: (items.create as { itemIds: number[] }).itemIds, hiddenItemIds: (items.create as { hiddenItemIds: number[] }).hiddenItemIds } : items.changes
          const changes: TableChange = { ...identity, ...(unnamed.source.removed ? { removed: false } : {}), ...lists }
          const raw = setup.docs.find((doc) => doc.id === id)
          first.push(raw ? { id, existing: raw, changes } : { id, create: { type: 'source', zoneId: zone.zoneId, key, phaseNo: setup.phaseNo, itemIds: [], hiddenItemIds: [], ...changes } as NewTableDoc })
        } else first.push({ id, create: { type: 'source', zoneId: zone.zoneId, key, phaseNo: setup.phaseNo, ...identity, itemIds: now, hiddenItemIds: [] } })
      } else {
        const creature = row.status === 'zoneWide' ? target.zoneWide : target.sources.find((candidate) => candidate.key === row.key)
        if (!creature) continue
        const extra: TableChange = {}
        if (row.status === 'takenOut') extra.removed = false
        if (row.storeNpcId !== undefined) extra.npcId = row.storeNpcId
        if (row.rename && row.differs?.name && hasText(row.differs.name.slice(0, TABLE_NAME_MAX))) extra.name = row.differs.name.slice(0, TABLE_NAME_MAX).trim()
        if (row.rename && row.differs?.kind) extra.kind = row.differs.kind
        const write = existingCreatureWrite(target, creature, now, extra)
        if (write) first.push(write)
      }
      for (const item of later) journal.push({ key: row.key as string, itemId: item.itemId, versions: item.evidence.journal ?? [] })
    }
    plans.push({ zone, journal })
  }
  const second = (after: LootTableDoc[]) => {
    const zonesAfter = mergeTables(setup.captures, after, setup.phaseNo)
    const ticks: TableWrite[] = []
    for (const plan of plans) {
      const zone = zonesAfter.find((candidate) => candidate.zoneId === plan.zone.zoneId)
      const tick = zone && plan.zone.tickIn ? setZoneInPhase(zone, true) : null
      if (tick) ticks.push(tick)
    }
    // DungeonJournal's items by the versions that list them: one call per version, or set of versions, in the order met. Each call is built from the
    // documents as the calls before it leave them, so a creature that two versions list gets a write in each.
    const groups = new Map<string, { versions: string[]; items: Map<string, { zoneId: number; key: string; itemIds: number[] }> }>()
    for (const plan of plans) {
      for (const entry of plan.journal) {
        const group = groups.get(entry.versions.join('\n')) ?? { versions: entry.versions, items: new Map() }
        groups.set(entry.versions.join('\n'), group)
        const creature = `${plan.zone.zoneId}|${entry.key}`
        const listed = group.items.get(creature) ?? { zoneId: plan.zone.zoneId as number, key: entry.key, itemIds: [] }
        group.items.set(creature, { ...listed, itemIds: [...listed.itemIds, entry.itemId] })
      }
    }
    const journal: JournalCall[] = []
    let docs = after
    for (const group of groups.values()) {
      const zones = mergeTables(setup.captures, docs, setup.phaseNo)
      const writes: TableWrite[] = []
      for (const { zoneId, key, itemIds } of group.items.values()) {
        const zone = zones.find((candidate) => candidate.zoneId === zoneId)
        const creature = key === ZONE_WIDE_KEY ? zone?.zoneWide : zone?.sources.find((candidate) => candidate.key === key)
        const write = zone && creature ? addItems(zone, creature, itemIds).write : null
        if (write) writes.push(write)
      }
      if (!writes.length) continue
      journal.push({ versions: group.versions, writes })
      docs = applyWrites(docs, writes)
    }
    return { ticks, journal }
  }
  return { first, made, madeBefore, second }
}

/**
 * The colors of the zones a save makes (design section 6, "Its color"): each gets suggestColor's pick among the colors the listed zones have, as a zone
 * made in Settings does, and the next one counts the colors given before it. A zone that has a color chosen already keeps it. Saved with saveZoneColors,
 * which writes only these zones.
 */
export function madeZoneColors(zoneIds: number[], setup: Pick<ImportSetup, 'captures' | 'docs' | 'catalog' | 'currentPhase'>, chosen: Readonly<Record<string, string>>): Record<string, string> {
  const inUse = listZones(setup.captures, setup.docs, setup.catalog, setup.currentPhase).map((zone) => zoneColor(zone.key, chosen))
  const colors: Record<string, string> = {}
  for (const zoneId of zoneIds) {
    const key = String(zoneId)
    if (chosen[key] !== undefined || colors[key] !== undefined) continue
    colors[key] = suggestColor(inUse)
    inUse.push(colors[key])
  }
  return colors
}

/** The Log reason of an import's writes (the rules allow up to 300 characters). */
export function importReason(from: 'addon' | 'capture', stringIds: string[]): string {
  if (from === 'capture') return 'Imported from a capture file'
  const ids = [...new Set(stringIds)] // the same string pasted twice is named once
  const text = `Imported from the addon (${ids.join(', ')})`
  return text.length <= 300 ? text : `Imported from the addon (${ids.length} strings)`
}

/**
 * What a save that stopped says (design section 7, "After saving"): what was saved, what wasn't sent, and the reason. The text and the answers stay in the
 * panel, so pressing Save again builds the rest from the stored documents.
 */
export function importStoppedText(saved: number, notSent: number, why: string, note = ''): string {
  return `${saved} ${saved === 1 ? 'change was' : 'changes were'} saved and ${notSent} ${notSent === 1 ? "wasn't" : "weren't"} sent. ${why}${note ? ` ${note}` : ''} Press Save again to finish: the text and your answers are still here.`
}

/**
 * The Log reason of DungeonJournal's items, saved in their own write (design section 4): the versions that list them ("2.0.3", "2.0.3 and 2.1.0"). Too
 * long for the rules' 300 characters, it gives their number.
 */
export function journalReason(versions: readonly string[]): string {
  const names = [...new Set(versions.map((version) => version.replace(/^ForeverDungeonJournal\//, '') || 'unknown'))]
  const listed = names.length > 1 ? `${names.slice(0, -1).join(', ')} and ${names.at(-1)}` : names[0] ?? 'unknown'
  const text = `From DungeonJournal ${listed}, not seen in the game`
  return text.length <= 300 ? text : `From DungeonJournal (${names.length} versions), not seen in the game`
}
