// What a leader pastes into the drop list import (LOOT-008, docs/design/drop-list-import.md): the addon's drops strings (docs/spec/exchange-v0.md
// section 14) and capture files (data/loot/README.md, format 1), read into one shape, the CANDIDATE zone: a zone, its creatures, their items, and
// for each item the evidence for it (seen in the game, rolled for, listed by DungeonJournal, listed by a capture). The preview matches candidates to
// the guild's zones and creatures; nothing here knows the guild's lists.
//
// Several strings pasted at once are one import (section 14.4): their rows are merged by the spec's keys before anything is shown, and a count two
// clients saw is the larger of the two, never the sum (two clients see the same kill). Rows the content check rejects are left out and counted.
// No runtime imports beyond the envelope reader, so Node runs the tests directly.
import { ExchangeReadError, exchangeMessage, isExchangeInt, readEnvelopes } from '../lib/exchangeString.ts'
import { checkLootCapture, type LootSourceKind, type LootTableCapture } from './lootTables.ts'

// ---- The drops string, as section 14.1 has it (after section 3's reader rules: absent, null and false are all undefined here)

export type DropsSeen = { itemId: number; n: number; last: string; via?: 'window' | 'roll'; name?: string; quality?: number; boe?: true; quest?: true }
export type DropsSource = {
  npcId?: number; encounterId?: number; name: string; kind: LootSourceKind; guessed?: true; kills?: number; first?: string; last?: string
  itemIds: number[]; seen?: DropsSeen[]; journal?: number[]; ej?: number[]
}
export type DropsZone = {
  zoneId?: number; name: string; kind: 'dungeon' | 'raid'; players: number; instanceId?: number; difficultyId?: number; journalPartial?: true
  journalSkipped?: number; sources: DropsSource[]
}
export type DropsModel = { schema: number; id: string; at: number; by: string; journal?: string; zones: DropsZone[] }

const MAX_ZONES = 100
const MAX_SOURCES = 100
const MAX_ITEMS = 80
const GAME_ID_MAX = 100_000_000
const ID = /^[A-Za-z0-9_-]{1,64}$/
const DATE = /^[0-9]{4}-[0-9]{2}-[0-9]{2}$/

type Loose = Record<string, unknown>
const isObject = (value: unknown): value is Loose => value !== null && typeof value === 'object' && !Array.isArray(value)
const whole = (value: unknown, low: number, high?: number): value is number => isExchangeInt(value) && value >= low && (high === undefined || value <= high)
const isGameId = (value: unknown): value is number => whole(value, 1, GAME_ID_MAX)
const optional = (value: unknown, test: (value: unknown) => boolean) => value === undefined || test(value)
const isTrue = (value: unknown) => value === undefined || value === true
const isDate = (value: unknown): value is string => typeof value === 'string' && DATE.test(value)
/** Section 2's text: code points up to the limit, no NUL, and (when required) more than ASCII spaces. */
const isText = (value: unknown, limit: number) => typeof value === 'string' && [...value].length <= limit && !value.includes('\u0000') && value.replace(/^ +| +$/g, '') !== ''
/** A name with its leading and trailing ASCII spaces removed. Not String.trim: a tab or a no-break space is text (section 2). */
const trimSpaces = (name: string) => name.replace(/^ +| +$/g, '')

function itemSet(value: unknown): Set<number> | null {
  if (!Array.isArray(value) || value.length > MAX_ITEMS) return null
  const ids = new Set<number>()
  for (const item of value) {
    if (!isGameId(item) || ids.has(item)) return null
    ids.add(item)
  }
  return ids
}

function zoneOk(zone: unknown): zone is DropsZone {
  return isObject(zone) && optional(zone.zoneId, isGameId) && isText(zone.name, 100) && (zone.kind === 'dungeon' || zone.kind === 'raid') && whole(zone.players, 1, 40)
    && optional(zone.instanceId, isGameId) && optional(zone.difficultyId, (value) => whole(value, 1)) && isTrue(zone.journalPartial)
    && optional(zone.journalSkipped, (value) => whole(value, 1)) && Array.isArray(zone.sources) && zone.sources.length <= MAX_SOURCES
}

function sourceOk(source: unknown): source is DropsSource {
  if (!(isObject(source) && optional(source.npcId, isGameId) && optional(source.encounterId, (value) => whole(value, 1)) && isText(source.name, 100)
    && (source.kind === 'boss' || source.kind === 'rare' || source.kind === 'trash') && isTrue(source.guessed) && optional(source.kills, (value) => whole(value, 1))
    && optional(source.first, isDate) && optional(source.last, isDate))) return false
  if (source.first !== undefined && source.last !== undefined && (source.first as string) > (source.last as string)) return false
  const items = itemSet(source.itemIds)
  if (!items) return false
  const evidence = new Set<number>()
  if (source.seen !== undefined) {
    if (!Array.isArray(source.seen)) return false
    for (const entry of source.seen) {
      if (!(isObject(entry) && isGameId(entry.itemId) && items.has(entry.itemId) && !evidence.has(entry.itemId) && whole(entry.n, 1) && isDate(entry.last)
        && (entry.via === undefined || entry.via === 'window' || entry.via === 'roll') && optional(entry.name, (value) => isText(value, 100))
        && optional(entry.quality, (value) => whole(value, 0, 7)) && isTrue(entry.boe) && isTrue(entry.quest))) return false
      evidence.add(entry.itemId)
    }
  }
  for (const field of ['journal', 'ej'] as const) {
    if (source[field] === undefined) continue
    const listed = itemSet(source[field])
    if (!listed || [...listed].some((id) => !items.has(id))) return false
    listed.forEach((id) => evidence.add(id))
  }
  return [...items].every((id) => evidence.has(id))
}

const topLevel = (ok: boolean, what: string) => { if (!ok) throw new ExchangeReadError('E_PAYLOAD', what) }

/**
 * Section 14.1's content check (step 9): the row errors in the order met, or E_PAYLOAD for a broken top level. A zone that fails is `zone:N` and its sources
 * aren't looked at; a source that fails is `zone:N/source:M`. Repeated keys are not errors: mergeDrops merges them.
 */
export function checkDrops(model: Loose): string[] {
  topLevel(typeof model.id === 'string' && ID.test(model.id) && whole(model.at, 0) && isText(model.by, 60), 'header')
  topLevel(optional(model.journal, (value) => isText(value, 100)), 'journal')
  topLevel(Array.isArray(model.zones) && model.zones.length >= 1 && model.zones.length <= MAX_ZONES, 'zones')
  const errors: string[] = []
  ;(model.zones as unknown[]).forEach((zone, zoneIndex) => {
    if (!zoneOk(zone)) { errors.push(`zone:${zoneIndex + 1}`); return }
    zone.sources.forEach((source, sourceIndex) => { if (!sourceOk(source)) errors.push(`zone:${zoneIndex + 1}/source:${sourceIndex + 1}`) })
  })
  return errors
}

/** One drops string as read: its model with the rows that failed left out, and their names. */
export type ReadDrops = { model: DropsModel; rowErrors: string[] }

/** Only the rows that passed: a zone that failed is gone, and so is a source that failed. */
function keepGood(model: Loose, rowErrors: string[]): DropsModel {
  const failed = new Set(rowErrors)
  const zones = (model.zones as Loose[]).flatMap((zone, zoneIndex) => {
    if (failed.has(`zone:${zoneIndex + 1}`)) return []
    const sources = (zone.sources as Loose[]).filter((_, sourceIndex) => !failed.has(`zone:${zoneIndex + 1}/source:${sourceIndex + 1}`))
    return [{ ...zone, sources } as DropsZone]
  })
  return { ...(model as DropsModel), zones }
}

export type DropsPaste = { ok: true; strings: ReadDrops[] } | { ok: false; code: ExchangeReadError['code']; message: string }

/** Every drops string in the pasted text. A damaged paste fails whole, with the spec's message for the person who pasted it. */
export function readDropsPaste(text: string): DropsPaste {
  try {
    const strings = readEnvelopes(text, 'drops', checkDrops).map(({ model, rowErrors }) => ({ model: keepGood(model, rowErrors), rowErrors }))
    return { ok: true, strings }
  } catch (error) {
    if (error instanceof ExchangeReadError) return { ok: false, code: error.code, message: exchangeMessage(error, 'drops') }
    throw error
  }
}

// ---- Candidates: what the preview matches

/** Where an item's place in the lists comes from. A capture's items and the game's are facts; a journal's are hints (design sections 3 and 4). */
export type ItemEvidence = {
  seen?: { n: number; last: string; via?: 'window' | 'roll'; name?: string; quality?: number; boe?: true; quest?: true }
  journal?: string[] // DungeonJournal lists it: the versions of the strings that list it ("ForeverDungeonJournal/2.0.3"), each once, oldest first
  ej?: true // the game's Encounter Journal lists it (reserved: Forever has none)
  capture?: true // a capture file lists it
}
export type CandidateItem = { itemId: number; evidence: ItemEvidence }
export type CandidateSource = {
  npcId?: number; encounterId?: number; name: string; kind: LootSourceKind; guessed?: true; kills?: number; first?: string; last?: string
  items: CandidateItem[] // in the string's order: seen most first, then the journal's
}
export type CandidateZone = {
  name: string; kind: 'dungeon' | 'raid'; players: number
  zoneId?: number // the app's zone id, when the string or the capture's built-in file gives it
  captureZoneId?: number // a capture file's zone id (Wowhead's): never written as an app zone id (design section 6)
  instanceId?: number
  difficultyIds: number[]
  journal?: string // DungeonJournal's version, when an item here is listed by it (the first string's; each item's evidence has its own)
  journalPartial?: true
  journalSkipped?: number
  from: 'addon' | 'capture'
  sources: CandidateSource[] // the string's order (spec 14.3): bosses, rares, trash
  zoneWide: CandidateItem[] // a capture's zone-wide list; a drops string never has one
}

/** Section 2's name key: ASCII spaces trimmed and collapsed, ASCII letters lowercased (other letters compare exactly). */
export const dropsNameKey = (name: string) => name.replace(/^ +| +$/g, '').replace(/ +/g, ' ').replace(/[A-Z]/g, (letter) => letter.toLowerCase())

const zoneKey = (zone: DropsZone) => zone.zoneId !== undefined ? `z${zone.zoneId}` : zone.instanceId !== undefined ? `i${zone.instanceId}:${zone.difficultyId ?? ''}` : `n${dropsNameKey(zone.name)}`
const sourceKey = (source: { npcId?: number; encounterId?: number; name: string }) =>
  source.npcId !== undefined ? `n${source.npcId}` : source.encounterId !== undefined ? `e${source.encounterId}` : `t${dropsNameKey(source.name)}`

const KIND_RANK: Record<LootSourceKind, number> = { trash: 0, rare: 1, boss: 2 }
const minDate = (a?: string, b?: string) => (a === undefined ? b : b === undefined ? a : a < b ? a : b)
const maxDate = (a?: string, b?: string) => (a === undefined ? b : b === undefined ? a : a > b ? a : b)
const maxOf = (a?: number, b?: number) => (a === undefined ? b : b === undefined ? a : Math.max(a, b))

/** What a string that lists DungeonJournal's items without its version stands for: the addon's own word for a version it doesn't know. */
const JOURNAL_UNKNOWN = 'ForeverDungeonJournal/unknown'
const versionOrder = (a: string, b: string) => a.localeCompare(b, 'en', { numeric: true })

/** One item's evidence from two rows: the larger count, the later date, a loot window over a roll, any flag either has, every DungeonJournal version either has. */
export function mergeEvidence(into: ItemEvidence, from: ItemEvidence): ItemEvidence {
  const seen = into.seen && from.seen
    ? {
      n: Math.max(into.seen.n, from.seen.n),
      last: maxDate(into.seen.last, from.seen.last) as string,
      ...(into.seen.via === 'window' || from.seen.via === 'window' ? { via: 'window' as const } : into.seen.via || from.seen.via ? { via: 'roll' as const } : {}),
      ...(into.seen.name ?? from.seen.name ? { name: into.seen.name ?? from.seen.name } : {}),
      ...((into.seen.quality ?? from.seen.quality) !== undefined ? { quality: into.seen.quality ?? from.seen.quality } : {}),
      ...(into.seen.boe || from.seen.boe ? { boe: true as const } : {}),
      ...(into.seen.quest || from.seen.quest ? { quest: true as const } : {}),
    }
    : into.seen ?? from.seen
  return {
    ...(seen ? { seen } : {}),
    ...(into.journal || from.journal ? { journal: [...new Set([...(into.journal ?? []), ...(from.journal ?? [])])].sort(versionOrder) } : {}),
    ...(into.ej || from.ej ? { ej: true as const } : {}),
    ...(into.capture || from.capture ? { capture: true as const } : {}),
  }
}

function mergeItems(into: CandidateItem[], from: CandidateItem[]): CandidateItem[] {
  const out = into.map((item) => ({ ...item }))
  for (const item of from) {
    const there = out.find((candidate) => candidate.itemId === item.itemId)
    if (there) there.evidence = mergeEvidence(there.evidence, item.evidence)
    else out.push({ ...item })
  }
  return out
}

// A row that names its npc a boss without guessing: the game's, or DungeonJournal's (design 2.2 step 3). A trash row, or the rolls of an encounter
// (no npc id), says nothing about which npc is the boss.
const sureBoss = (source: CandidateSource) => source.kind === 'boss' && !source.guessed && source.npcId !== undefined
// Whose name a merged creature keeps: a corpse's (an npc id) over an encounter's (rolls), and the game's (a kill or an item seen) over DungeonJournal's.
const nameRank = (source: CandidateSource) =>
  (source.npcId !== undefined ? 2 : 0) + (source.kills !== undefined || source.items.some((item) => item.evidence.seen) ? 1 : 0)

/** Two rows that are one creature: the larger counts, the wider dates, every item once. A guess stays a guess until a sure boss row confirms it. */
function mergeSources(into: CandidateSource, from: CandidateSource): CandidateSource {
  const kind = KIND_RANK[from.kind] > KIND_RANK[into.kind] ? from.kind : into.kind
  const guessed = (into.guessed || from.guessed) && !sureBoss(into) && !sureBoss(from)
  const npcId = into.npcId ?? from.npcId
  const encounterId = into.encounterId ?? from.encounterId
  const kills = maxOf(into.kills, from.kills)
  const first = minDate(into.first, from.first)
  const last = maxDate(into.last, from.last)
  return {
    ...(npcId !== undefined ? { npcId } : {}),
    ...(encounterId !== undefined ? { encounterId } : {}),
    name: nameRank(from) > nameRank(into) ? from.name : into.name,
    kind,
    ...(guessed ? { guessed: true as const } : {}),
    ...(kills !== undefined ? { kills } : {}),
    ...(first !== undefined ? { first } : {}),
    ...(last !== undefined ? { last } : {}),
    items: mergeItems(into.items, from.items),
  }
}

function candidateSource(source: DropsSource, version: string | undefined): CandidateSource {
  const seen = new Map((source.seen ?? []).map((entry) => [entry.itemId, entry]))
  const journal = new Set(source.journal ?? [])
  const ej = new Set(source.ej ?? [])
  const items = source.itemIds.map((itemId): CandidateItem => {
    const entry = seen.get(itemId)
    const evidence: ItemEvidence = {
      ...(entry ? { seen: { n: entry.n, last: entry.last, ...(entry.via ? { via: entry.via } : {}), ...(entry.name ? { name: entry.name } : {}), ...(entry.quality !== undefined ? { quality: entry.quality } : {}), ...(entry.boe ? { boe: true as const } : {}), ...(entry.quest ? { quest: true as const } : {}) } } : {}),
      ...(journal.has(itemId) ? { journal: [version ?? JOURNAL_UNKNOWN] } : {}),
      ...(ej.has(itemId) ? { ej: true as const } : {}),
    }
    return { itemId, evidence }
  })
  return {
    ...(source.npcId !== undefined ? { npcId: source.npcId } : {}),
    ...(source.encounterId !== undefined ? { encounterId: source.encounterId } : {}),
    name: trimSpaces(source.name),
    kind: source.kind,
    ...(source.guessed ? { guessed: true as const } : {}),
    ...(source.kills !== undefined ? { kills: source.kills } : {}),
    ...(source.first !== undefined ? { first: source.first } : {}),
    ...(source.last !== undefined ? { last: source.last } : {}),
    items,
  }
}

/**
 * One creature per key across rows already turned into candidates (npc id, else encounter id, else name), then the rolls of an encounter joined to the
 * one corpse of that encounter. mergeDrops does this per zone; the preview does it again when it groups several candidates under one app zone (two
 * difficulties of one instance, two wings of one dungeon).
 */
export function mergeCandidateSources(rows: CandidateSource[]): CandidateSource[] {
  const byKey = new Map<string, CandidateSource>()
  for (const row of rows) {
    const key = sourceKey(row)
    const there = byKey.get(key)
    byKey.set(key, there ? mergeSources(there, row) : row)
  }
  const list = [...byKey.values()]
  const joined = new Set<CandidateSource>()
  for (const rolls of list.filter((source) => source.npcId === undefined && source.encounterId !== undefined)) {
    const corpses = list.filter((source) => source.npcId !== undefined && source.encounterId === rolls.encounterId)
    if (corpses.length !== 1) continue
    const corpse = corpses[0] as CandidateSource
    list[list.indexOf(corpse)] = mergeSources(corpse, rolls)
    joined.add(rolls)
  }
  return list.filter((source) => !joined.has(source))
}

/**
 * The candidate zones of one or more drops strings (section 14.4): zones merged by their key (the app's zone id, else the instance with its
 * difficulty, else the name), creatures by theirs (npc id, else encounter id, else name), and then a creature known only by its encounter (from rolls)
 * joins the one creature of the zone that has that encounter and an npc id (the loot master's corpse), so one boss seen both ways is one creature. When
 * two corpses share the encounter (a fight of several bosses), the rolls stay apart: which corpse dropped them isn't known.
 */
export function mergeDrops(strings: DropsModel[]): CandidateZone[] {
  const zones = new Map<string, { zone: CandidateZone; sources: CandidateSource[] }>()
  for (const model of strings) {
    for (const zone of model.zones) {
      const key = zoneKey(zone)
      let entry = zones.get(key)
      if (!entry) {
        entry = {
          zone: {
            name: trimSpaces(zone.name), kind: zone.kind, players: zone.players, ...(zone.zoneId !== undefined ? { zoneId: zone.zoneId } : {}),
            ...(zone.instanceId !== undefined ? { instanceId: zone.instanceId } : {}), difficultyIds: [], from: 'addon', sources: [], zoneWide: [],
          },
          sources: [],
        }
        zones.set(key, entry)
      }
      const target = entry.zone
      if (zone.difficultyId !== undefined && !target.difficultyIds.includes(zone.difficultyId)) target.difficultyIds.push(zone.difficultyId)
      if (zone.journalPartial) target.journalPartial = true
      if (zone.journalSkipped !== undefined) target.journalSkipped = Math.max(target.journalSkipped ?? 0, zone.journalSkipped)
      if (model.journal && zone.sources.some((source) => (source.journal ?? []).length > 0)) target.journal ??= model.journal
      entry.sources.push(...zone.sources.map((source) => candidateSource(source, model.journal)))
    }
  }
  return [...zones.values()].map(({ zone, sources }) => ({ ...zone, sources: mergeCandidateSources(sources) }))
}

// ---- Capture files (format 1): a hand-made capture from Wowhead, read as a candidate so the same preview takes it

export type CapturePaste = { ok: true; zones: CandidateZone[] } | { ok: false; errors: string[] }

/** One capture as a candidate zone. Its zone id is Wowhead's, kept apart: matching never treats it as an app zone id (design section 6). */
export function captureCandidate(capture: LootTableCapture): CandidateZone {
  const fromCapture = (itemId: number): CandidateItem => ({ itemId, evidence: { capture: true } })
  return {
    name: trimSpaces(capture.name), kind: capture.kind, players: capture.players, captureZoneId: capture.zoneId, difficultyIds: [], from: 'capture',
    sources: capture.sources.map((source) => ({ npcId: source.npcId, name: trimSpaces(source.name), kind: source.kind, items: source.itemIds.map(fromCapture) })),
    zoneWide: capture.zoneWideItemIds.map(fromCapture),
  }
}

/** A pasted capture file (one JSON object) or a list of them, every problem at once, as the capture checker words them. */
export function readCapturePaste(text: string): CapturePaste {
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    return { ok: false, errors: ['This is not a capture file: it is not JSON.'] }
  }
  const list = Array.isArray(parsed) ? parsed : [parsed]
  const zones: CandidateZone[] = []
  const errors: string[] = []
  list.forEach((entry, index) => {
    const checked = checkLootCapture(entry)
    if (checked.ok) zones.push(captureCandidate(checked.table))
    else errors.push(...checked.errors.map((error) => (list.length > 1 ? `Capture ${index + 1}: ${error}` : error)))
  })
  return errors.length ? { ok: false, errors } : { ok: true, zones }
}

/** What a leader pasted, whichever it is: drops strings (they start with IM1:) or capture files (JSON). */
export function looksLikeCapture(text: string): boolean {
  const trimmed = text.trimStart()
  return (trimmed.startsWith('{') || trimmed.startsWith('[')) && !text.includes('IM1:')
}
