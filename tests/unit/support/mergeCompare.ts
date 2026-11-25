// Comparing the answer of the merge with the reference (support/mergeReference.ts), shared by the merge fuzz and the builder tests.
import { isDeepStrictEqual } from 'node:util'
import type { MergedSource, MergedZone } from '../../../src/shared/game/guildTables.ts'
import type { LootTableCapture } from '../../../src/shared/game/lootTables.ts'
import type { RefDropZone, RefList, RefZone } from './mergeReference.ts'

export type Diff = { zoneId?: number; path: string; expected: unknown; actual: unknown }

export const sorted = (list: number[]) => [...list].sort((a, b) => a - b)
export const reversed = <T>(list: T[]) => [...list].reverse()
export const byZone = <T extends { zoneId: number }>(zones: T[]) => [...zones].sort((a, b) => a.zoneId - b.zoneId)

// The merge's answer reduced to what the reference reports, so that the two print alike.
export function projectList(source: MergedSource): RefList {
  return { key: source.key, docId: source.docId, hasDoc: source.doc !== undefined, before: source.beforeItemIds, added: source.addedItemIds, hidden: source.hiddenItemIds, gone: source.goneItemIds, items: source.itemIds }
}
export function projectZone(zone: MergedZone) {
  return {
    zoneId: zone.zoneId, phaseNo: zone.phaseNo, name: zone.name, kind: zone.kind, players: zone.players, custom: zone.custom, introducedAt: zone.introducedAt, inPhase: zone.inPhase, edited: zone.edited,
    zoneDoc: zone.doc?.id, hasCapture: zone.builtIn !== undefined,
    sources: zone.sources.map((source) => ({ ...projectList(source), docIdOfDoc: source.doc?.id, name: source.name, kind: source.kind, npcId: source.npcId, order: source.order, builtIn: source.builtIn, removed: source.removed, introducedAt: source.introducedAt })),
    zoneWide: { ...projectList(zone.zoneWide), docIdOfDoc: zone.zoneWide.doc?.id, kind: zone.zoneWide.kind, removed: zone.zoneWide.removed },
  }
}

// The first difference between the reference and the merge, or undefined. What the spec leaves open is not compared (see mergeReference.ts).
// `skipReports` leaves out the "added" and "taken off" reports of the phase's own document, which the spec defines only for rules-valid documents.
export function firstDiff(ref: RefZone[], actual: MergedZone[], skipReports: boolean): Diff | undefined {
  let found: Diff | undefined
  const expect = (zoneId: number | undefined, path: string, expected: unknown, wanted: unknown) => {
    if (!found && expected !== wanted && !isDeepStrictEqual(expected, wanted)) found = { zoneId, path, expected, actual: wanted }
  }
  const compareList = (zoneId: number, path: string, wantList: RefList, list: MergedSource) => {
    expect(zoneId, `${path}: docId`, wantList.docId, list.docId)
    expect(zoneId, `${path}: doc`, wantList.hasDoc ? wantList.docId : undefined, list.doc?.id)
    expect(zoneId, `${path}: itemIds (in the phase)`, wantList.items, list.itemIds)
    expect(zoneId, `${path}: beforeItemIds`, wantList.before, list.beforeItemIds)
    if (!skipReports) {
      expect(zoneId, `${path}: addedItemIds`, sorted(wantList.added), sorted(list.addedItemIds))
      expect(zoneId, `${path}: hiddenItemIds`, sorted(wantList.hidden), sorted(list.hiddenItemIds))
    }
    expect(zoneId, `${path}: goneItemIds`, sorted(wantList.gone), sorted(list.goneItemIds))
    expect(zoneId, `${path}: no item twice in itemIds`, list.itemIds.length, new Set(list.itemIds).size)
    // Whatever the documents say (also one the rules would refuse), an item reported as taken off is not in the phase, so the editor never shows it twice.
    expect(zoneId, `${path}: no item both in itemIds and in hiddenItemIds`, [], list.hiddenItemIds.filter((id) => list.itemIds.includes(id)))
  }
  expect(undefined, 'the zones (numbers)', ref.map((zone) => zone.zoneId), byZone(actual).map((zone) => zone.zoneId))
  if (found) return found
  for (const want of ref) {
    const zone = actual.find((candidate) => candidate.zoneId === want.zoneId)!
    const at = want.zoneId
    expect(at, 'phaseNo', want.phaseNo, zone.phaseNo)
    expect(at, 'name', want.name, zone.name)
    if (want.kind !== undefined) expect(at, 'kind', want.kind, zone.kind)
    if (want.players !== undefined) expect(at, 'players', want.players, zone.players)
    expect(at, 'custom', want.custom, zone.custom)
    expect(at, 'inPhase', want.inPhase, zone.inPhase)
    expect(at, 'edited', want.edited, zone.edited)
    expect(at, 'doc (the zone document of the phase)', want.hasZoneDoc ? want.zoneDocId : undefined, zone.doc?.id)
    expect(at, 'builtIn (the capture, there exactly for a zone of the captures)', !want.custom, zone.builtIn !== undefined)
    // introducedAt: the module takes the phase of the first document; the spec says "the phase of the first document" in one place and "starts" in others,
    // which differ only when a document without a name comes first (the client never writes one). Either is accepted here.
    if (want.custom) expect(at, 'introducedAt (first document or first name)', true, [want.firstZoneDocPhase, want.firstNamedPhase].includes(zone.introducedAt))
    else expect(at, 'introducedAt of a zone of the captures', undefined, zone.introducedAt)
    expect(at, 'creatures (keys, in order)', want.sources.map((source) => source.key), zone.sources.map((source) => source.key))
    if (found) return found
    want.sources.forEach((wantSource, index) => {
      const source = zone.sources[index]
      const path = `creature ${wantSource.key}`
      expect(at, `${path}: name`, wantSource.name, source.name)
      if (wantSource.kind !== undefined) expect(at, `${path}: kind`, wantSource.kind, source.kind)
      if (wantSource.order !== undefined) expect(at, `${path}: order`, wantSource.order, source.order)
      if (wantSource.npcId !== undefined || wantSource.builtIn) expect(at, `${path}: npcId`, wantSource.npcId, source.npcId)
      expect(at, `${path}: builtIn`, wantSource.builtIn, source.builtIn)
      expect(at, `${path}: removed`, wantSource.removed, source.removed)
      if (wantSource.builtIn) expect(at, `${path}: introducedAt of a creature of the captures`, undefined, source.introducedAt)
      else expect(at, `${path}: introducedAt (first document or first name)`, true, [wantSource.firstDocPhase, wantSource.firstNamedPhase].includes(source.introducedAt))
      compareList(at, path, wantSource, source)
    })
    expect(at, 'zoneWide: key', 'zonewide', zone.zoneWide.key)
    expect(at, 'zoneWide: kind', 'zonewide', zone.zoneWide.kind)
    expect(at, 'zoneWide: removed', false, zone.zoneWide.removed)
    compareList(at, 'zoneWide', want.zoneWide, zone.zoneWide)
    if (found) return found
  }
  return found
}

export function firstDropDiff(ref: RefDropZone[], actual: LootTableCapture[], mergedOrder: number[]): Diff | undefined {
  let found: Diff | undefined
  const expect = (zoneId: number | undefined, path: string, expected: unknown, wanted: unknown) => {
    if (!found && expected !== wanted && !isDeepStrictEqual(expected, wanted)) found = { zoneId, path, expected, actual: wanted }
  }
  expect(undefined, 'dropTablesOf: the zones (numbers)', ref.map((zone) => zone.zoneId), byZone(actual).map((zone) => zone.zoneId))
  if (found) return found
  expect(undefined, 'dropTablesOf: the zones are in the order of mergeTables', mergedOrder.filter((id) => ref.some((zone) => zone.zoneId === id)), actual.map((zone) => zone.zoneId))
  for (const want of ref) {
    const zone = actual.find((candidate) => candidate.zoneId === want.zoneId)!
    const at = want.zoneId
    expect(at, 'drop: name', want.name, zone.name)
    if (want.kind !== undefined) expect(at, 'drop: kind', want.kind, zone.kind)
    if (want.players !== undefined) expect(at, 'drop: players', want.players, zone.players)
    expect(at, 'drop: custom', want.custom, zone.custom === true)
    expect(at, 'drop: edited', want.edited, zone.edited === true)
    expect(at, 'drop: creatures (names, in order)', want.sources.map((source) => source.name), zone.sources.map((source) => source.name))
    expect(at, 'drop: creatures (kinds, where the spec gives one)', want.sources.map((source) => source.kind ?? null), zone.sources.map((source, index) => (want.sources[index]?.kind === undefined ? null : source.kind)))
    expect(at, 'drop: creatures (items)', want.sources.map((source) => source.itemIds), zone.sources.map((source) => source.itemIds))
    expect(at, 'drop: creatures (npcId, where the spec gives one)', want.sources.map((source) => source.npcId ?? null), zone.sources.map((source, index) => (want.sources[index]?.npcId === undefined ? null : source.npcId)))
    expect(at, 'drop: zoneWideItemIds', want.zoneWideItemIds, zone.zoneWideItemIds)
  }
  return found
}
