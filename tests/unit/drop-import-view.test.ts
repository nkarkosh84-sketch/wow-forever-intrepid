import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { answerSubject, chooseZone, colorMadeZones, creatureBlockKey, confirmHolds, confirmLabel, countsLine, journalToTick, keptColorText, nextPhaseHint, nothingToSave, pasteReaders, previewOf, readFileText, readPaste, tickItem, tickJournal, zoneAnswer, zoneChip, zoneOpen, zoneSelects } from '../../src/features/loot/dropImportView.ts'
import { buildPreview, noAnswers, takenZoneIds, type ImportAnswers, type ImportCounts, type ImportSetup } from '../../src/features/loot/dropImport.ts'
import { mergeDrops, type CandidateZone, type DropsSource, type DropsZone } from '../../src/shared/game/dropsString.ts'
import { sourceDocId, zoneDocId, type LootTableDoc, type SourceTableDoc, type ZoneTableDoc } from '../../src/shared/game/guildTables.ts'
import type { LootTableCapture } from '../../src/shared/game/lootTables.ts'

// What the drop list import panel (DropImportPanel.tsx) shows and does, as pure functions. Every name and id is invented.

const abbey: LootTableCapture = {
  format: 1, zoneId: 4321, name: 'Test Abbey', kind: 'dungeon', players: 5, source: 'https://example.invalid/abbey', capturedAt: '2026-10-16',
  sources: [{ npcId: 990100, name: 'Abbot of Fixtures', kind: 'boss', itemIds: [900100] }], zoneWideItemIds: [],
}
const zoneDoc = (zoneId: number, phaseNo: number, extra: Partial<ZoneTableDoc> = {}): ZoneTableDoc => ({ id: zoneDocId(zoneId, phaseNo), type: 'zone', zoneId, phaseNo, rev: 1, ...extra })
const setup = (docs: LootTableDoc[], extra: Partial<ImportSetup> = {}): ImportSetup => ({ captures: [abbey], docs, catalog: [], currentPhase: 0, phaseNo: 0, journalSaving: true, canMakeZones: true, ...extra })
const boss = (npcId: number, name: string, itemIds: number[], extra: Partial<DropsSource> = {}): DropsSource => ({ npcId, name, kind: 'boss', itemIds, seen: itemIds.map((itemId) => ({ itemId, n: 1, last: '2026-12-10', via: 'window' as const })), ...extra })
const pasted = (...zones: DropsZone[]) => mergeDrops([{ schema: 1, id: 'd-test-0001', at: 1797474600, by: 'IntrepidManager/test', zones }])
const answers = (patch: Partial<ImportAnswers> = {}): ImportAnswers => ({ ...noAnswers(), ...patch })
const testAbbey = (sources: DropsSource[], extra: Partial<DropsZone> = {}): DropsZone => ({ name: 'Test Abbey', kind: 'dungeon', players: 5, instanceId: 7001, sources, ...extra })
const sourceDoc = (zoneId: number, key: string, phaseNo: number, extra: Partial<SourceTableDoc> = {}): SourceTableDoc =>
  ({ id: sourceDocId(zoneId, key, phaseNo), type: 'source', zoneId, key, phaseNo, itemIds: [], hiddenItemIds: [], rev: 1, ...extra })
type CandidateZones = CandidateZone[]
const counts = (patch: Partial<ImportCounts> = {}): ImportCounts => ({ zones: 0, newZones: 0, creatures: 0, newCreatures: 0, items: 0, journalItems: 0, unanswered: 0, ...patch })

describe('the import panel: the confirm step', () => {
  it('names the phase it saves to, with the counts', () => {
    assert.equal(confirmLabel('Phase 4', counts({ zones: 1, creatures: 2, newCreatures: 2, items: 3 })), 'Save to Phase 4: 1 zone, 2 creatures (2 new), 3 items')
  })

  it('has nothing to save when no zone, creature or item is saved', () => {
    assert.equal(nothingToSave(undefined), true)
    assert.equal(nothingToSave(counts({ unanswered: 1 })), true)
    assert.equal(nothingToSave(counts({ zones: 1 })), false)
    assert.equal(nothingToSave(counts({ journalItems: 1 })), false)
  })

  it('closes when the phase or the pasted text changes', () => {
    const open = { phaseNo: 4, text: 'IM1:drops:test' }
    assert.equal(confirmHolds(open, 4, 'IM1:drops:test'), true)
    assert.equal(confirmHolds(open, 3, 'IM1:drops:test'), false)
    assert.equal(confirmHolds(open, 4, 'IM1:drops:other'), false)
    assert.equal(confirmHolds(null, 4, 'IM1:drops:test'), false)
  })
})

describe('the import panel: a zone a leader took out of the phase', () => {
  const docs = [zoneDoc(4321, 0, { removed: true })]
  const night = pasted(testAbbey([boss(990100, 'Abbot of Fixtures', [900102]), boss(990109, 'New Test Boss', [900109])]))

  it('starts open, says it was taken out, and the counts line says it is left out', () => {
    const preview = buildPreview(night, setup(docs), noAnswers())
    const zone = preview.zones[0]
    assert.ok(zone)
    assert.deepEqual([zone.takenOut, zone.zoneTicked], [true, false])
    assert.equal(zoneOpen(zone), true)
    assert.deepEqual(zoneChip(zone, 'Phase 1'), { text: 'taken out of Phase 1', added: false })
    assert.equal(countsLine(preview.counts, preview.zones, 'Phase 1'), '0 zones, 0 creatures, 0 items. 1 zone taken out of Phase 1: left out.')
  })

  it('ticked back, it is counted and no longer left out', () => {
    const preview = buildPreview(night, setup(docs), answers({ ticks: { z4321: true } }))
    const zone = preview.zones[0]
    assert.ok(zone)
    assert.equal(zoneOpen(zone), true)
    assert.deepEqual(zoneChip(zone, 'Phase 1'), { text: 'taken out of Phase 1', added: false })
    assert.equal(countsLine(preview.counts, preview.zones, 'Phase 1'), '1 zone, 2 creatures (1 new), 2 items')
  })

  it('a zone with every row already listed starts closed, and unanswered questions are named', () => {
    const listed = buildPreview(pasted(testAbbey([boss(990100, 'Abbot of Fixtures', [900100])])), setup([zoneDoc(4321, 0, { removed: false })]), noAnswers())
    assert.equal(zoneOpen(listed.zones[0] as NonNullable<typeof listed.zones[0]>), false)
    assert.equal(zoneChip(listed.zones[0] as NonNullable<typeof listed.zones[0]>, 'Phase 1'), undefined)
    assert.equal(countsLine(counts({ unanswered: 2 }), [], 'Phase 1'), '0 zones, 0 creatures, 0 items. 2 questions unanswered: left out.')
  })
})

describe('the import panel: a pick can be changed or taken back', () => {
  const crypt = (extra: Partial<DropsZone> = {}): DropsZone => ({ name: 'Some Other Crypt', kind: 'dungeon', players: 5, instanceId: 7002, sources: [boss(990200, 'Crypt Lord', [900205])], ...extra })
  const night = pasted(testAbbey([boss(990100, 'Abbot of Fixtures', [900105])]), crypt())
  const pick = answers({ zones: { u7002: { pick: 4321 } } })

  it('a pick into a zone that also matched by itself has its own Zone select, named for the pasted zone', () => {
    const before = buildPreview(night, setup([]), noAnswers())
    assert.deepEqual(before.zones.map((zone) => [zone.id, zoneSelects(zone)]), [['u7001', []], ['u7002', [{ answerKey: 'u7002', label: 'Zone' }]]])
    const after = buildPreview(night, setup([]), pick)
    assert.deepEqual(after.zones.map((zone) => [zone.id, zone.how, zoneSelects(zone)]), [['u7001', 'name', [{ answerKey: 'u7002', label: 'Zone for Some Other Crypt' }]]])
    // Choose (clear) takes the pick back: the pasted zone is asked about again on its own.
    const cleared = buildPreview(night, setup([]), answers({ zones: { u7002: zoneAnswer('', {}, new Set()) } }))
    assert.deepEqual(cleared.zones.map((zone) => [zone.id, zone.status]), [['u7001', 'matched'], ['u7002', 'unmatched']])
  })

  it('a zone picked alone keeps one select, named for the pasted zone', () => {
    const alone = buildPreview(pasted(crypt()), setup([]), pick)
    assert.deepEqual(alone.zones.map((zone) => [zone.id, zone.how, zoneSelects(zone)]), [['u7002', 'pick', [{ answerKey: 'u7002', label: 'Zone for Some Other Crypt' }]]])
  })

  it('a zone made from a pick gets the id fixed from its own instance', () => {
    const subject = answerSubject('u7002', night)
    assert.equal(subject.instanceId, 7002)
    assert.deepEqual(zoneAnswer('new', subject, takenZoneIds(setup([]))), { make: true, zoneId: 50_007_002 })
    assert.deepEqual(zoneAnswer('4321', subject, new Set()), { pick: 4321 })
    // Changed away from "Make a new zone" and back, a pasted zone gets the id it had, so the answers under it come back; a new text starts afresh.
    const keep = pasted({ name: 'Hollow Test Keep', kind: 'dungeon', players: 5, sources: [boss(990011, 'The Fixture Warden', [900101, 900102])] })
    const unit = buildPreview(keep, setup([]), noAnswers()).zones[0]?.id as string
    const own = answerSubject(unit, keep)
    const made = chooseZone(noAnswers(), unit, 'new', own, takenZoneIds(setup([])))
    const zoneId = (made.zones[unit] as { zoneId: number }).zoneId
    const unticked = { ...made, ticks: { [`z${zoneId}|cn990011|900102`]: false } }
    for (const away of ['4321', '']) {
      const back = chooseZone(chooseZone(unticked, unit, away, own, takenZoneIds(setup([]))), unit, 'new', own, takenZoneIds(setup([])))
      assert.deepEqual(back.zones[unit], { make: true, zoneId }, away)
      assert.deepEqual(buildPreview(keep, setup([]), back).zones[0]?.creatures[0]?.items.map((item) => [item.itemId, item.ticked]), [[900101, true], [900102, false]], away)
    }
    assert.deepEqual(noAnswers().made, undefined)
    // Every zone row's own answer key is found among the pasted zones, also one keyed by its name.
    const named = pasted(crypt({ instanceId: undefined }))
    assert.deepEqual(buildPreview(named, setup([]), noAnswers()).zones.map((zone) => answerSubject(zone.id, named).name), ['Some Other Crypt'])
  })
})

describe('the import panel: answering keeps the block the leader is in', () => {
  const BARROW = 50_000_123 // "Test Barrow", a raid of 10 made in Settings
  const barrow = zoneDoc(BARROW, 0, { name: 'Test Barrow', kind: 'raid', players: 10, removed: false })
  const hollow = (sources: DropsSource[]): DropsZone => ({ name: 'Hollow Test Barrow', kind: 'raid', players: 40, instanceId: 9901, sources })
  // React keys: a zone block by its row id, a creature block by creatureBlockKey. The same key keeps the block, and the select in it, mounted.
  const keys = (preview: ReturnType<typeof buildPreview>) => preview.zones.map((zone) => [zone.id, zone.creatures.map((row) => creatureBlockKey(row))])

  it('a Zone pick or "Make a new zone" keeps the zone block, and the block stays open', () => {
    const docs = [barrow, sourceDoc(BARROW, 'n990001', 0, { name: 'Grimtooth the Test Boss', kind: 'boss', npcId: 990001, itemIds: [900001] })]
    const night = pasted(hollow([boss(990001, 'Grimtooth the Test Boss', [900001])]))
    const unanswered = buildPreview(night, setup(docs), noAnswers())
    const picked = buildPreview(night, setup(docs), answers({ zones: { u9901: { pick: BARROW } } }))
    const made = buildPreview(night, setup(docs), answers({ zones: { u9901: { make: true, zoneId: 61_234_567 } } }))
    // The Zone select is in the zone block, which keeps its key. Nothing can be answered under the creatures until the zone is decided, so their rows
    // move from the pasted zone's key to the zone's then.
    assert.deepEqual([keys(unanswered), keys(picked), keys(made)], [[['u9901', ['u9901|cn990001']]], [['u9901', ['z50000123|cn990001']]], [['u9901', ['z61234567|cn990001']]]])
    assert.deepEqual(zoneSelects(picked.zones[0] as NonNullable<typeof picked.zones[0]>).map((one) => one.answerKey), ['u9901'])
    // Everything under the picked zone is already listed: the zone still shows open, with the pick that was just answered.
    assert.deepEqual(picked.zones[0]?.creatures[0]?.items.map((item) => item.status), ['already'])
    assert.deepEqual([zoneOpen(unanswered.zones[0] as NonNullable<typeof unanswered.zones[0]>), zoneOpen(picked.zones[0] as NonNullable<typeof picked.zones[0]>), zoneOpen(made.zones[0] as NonNullable<typeof made.zones[0]>)], [true, true, true])
  })

  it('"Same as" keeps the creature block, and the zone stays open', () => {
    const docs = [barrow, sourceDoc(BARROW, 'cgrim1', 0, { name: 'Grimtooth', kind: 'boss', itemIds: [900001] })]
    const night = pasted(hollow([{ name: 'Grimtooth the Test Boss', kind: 'boss', itemIds: [900001], seen: [{ itemId: 900001, n: 1, last: '2026-12-10', via: 'window' }] }]))
    const pick = { zones: { u9901: { pick: BARROW } } }
    const asked = buildPreview(night, setup(docs), answers(pick))
    const same = buildPreview(night, setup(docs), answers({ ...pick, creatures: { 'u9901|ctgrimtooth the test boss': { same: 'cgrim1' } } }))
    const fresh = buildPreview(night, setup(docs), answers({ ...pick, creatures: { 'u9901|ctgrimtooth the test boss': { make: true } } }))
    assert.equal(asked.zones[0]?.creatures[0]?.status, 'unmatched')
    assert.deepEqual([same.zones[0]?.creatures[0]?.status, fresh.zones[0]?.creatures[0]?.status], ['matched', 'new'])
    // The row moves to the creature "same as" names (its id is that creature's key), but its block keeps its key: the question's first answer key.
    assert.notEqual(same.zones[0]?.creatures[0]?.id, asked.zones[0]?.creatures[0]?.id)
    assert.deepEqual(keys(asked), [['u9901', ['u9901|ctgrimtooth the test boss']]])
    assert.deepEqual(keys(same), keys(asked))
    assert.deepEqual(keys(fresh), keys(asked))
    assert.deepEqual([zoneOpen(same.zones[0] as NonNullable<typeof same.zones[0]>), zoneOpen(fresh.zones[0] as NonNullable<typeof fresh.zones[0]>)], [true, true])
  })
})

describe("the import panel: Tick DungeonJournal's items", () => {
  const BARROW = 50_000_123
  const barrow = zoneDoc(BARROW, 0, { name: 'Test Barrow', kind: 'raid', players: 10, removed: false })
  const keep = (sources: DropsSource[]) => mergeDrops([{ schema: 1, id: 'd-test-0002', at: 1797474600, by: 'IntrepidManager/test', journal: 'ForeverDungeonJournal/2.0.3', zones: [{ name: 'Test Barrow', kind: 'raid', players: 10, sources }] }])
  const warden = (extra: Partial<SourceTableDoc> = {}) => sourceDoc(BARROW, 'n990011', 0, { name: 'Warden of Fixtures', kind: 'boss', npcId: 990011, itemIds: [900100], ...extra })
  const night = keep([{ npcId: 990011, name: 'Warden of Fixtures', kind: 'boss', itemIds: [900101, 900102], journal: [900101, 900102] }])

  it('ticks only the new ones, never an item a leader took off', () => {
    const docs = [barrow, warden({ hiddenItemIds: [900102] })]
    const row = buildPreview(night, setup(docs), noAnswers()).zones[0]?.creatures[0] as NonNullable<ReturnType<typeof buildPreview>['zones'][0]['creatures'][0]>
    assert.deepEqual(row.items.map((item) => [item.itemId, item.status, item.tickable]), [[900101, 'new', true], [900102, 'takenOff', true]])
    assert.deepEqual(journalToTick(row).map((item) => item.itemId), [900101])
    const after = buildPreview(night, setup(docs), tickJournal(noAnswers(), row)).zones[0]?.creatures[0]
    assert.deepEqual(after?.items.map((item) => [item.itemId, item.ticked]), [[900101, true], [900102, false]])
  })

  it('is not offered under a creature a leader took out: Bring back comes first', () => {
    const docs = [barrow, warden({ removed: true })]
    const row = buildPreview(night, setup(docs), noAnswers()).zones[0]?.creatures[0] as NonNullable<ReturnType<typeof buildPreview>['zones'][0]['creatures'][0]>
    assert.deepEqual([row.status, row.saved], ['takenOut', false])
    assert.deepEqual(journalToTick(row), [])
  })

  it('never takes an item the game saw under another creature of the zone, in either paste order and whatever is ticked', () => {
    const seenOnce = (itemId: number) => ({ itemId, n: 1, last: '2026-12-10', via: 'window' as const })
    const aaa: DropsSource = { npcId: 990001, name: 'Aaa Test Boss', kind: 'boss', itemIds: [900101, 900777], seen: [seenOnce(900101)], journal: [900101, 900777] }
    const bbb: DropsSource = { npcId: 990002, name: 'Bbb Test Boss', kind: 'boss', itemIds: [900777, 900201], seen: [seenOnce(900777)], journal: [900201, 900777] }
    for (const order of [[aaa, bbb], [bbb, aaa]]) {
      const shared = keep(order)
      const rowOf = (preview: ReturnType<typeof buildPreview>, name: string) => preview.zones[0]?.creatures.find((row) => row.name === name) as NonNullable<ReturnType<typeof buildPreview>['zones'][0]['creatures'][0]>
      const before = buildPreview(shared, setup([barrow]), noAnswers())
      const listed = rowOf(before, 'Aaa Test Boss')
      assert.deepEqual(listed.items.map((item) => [item.itemId, item.status, item.where, item.tickable]), [[900101, 'new', undefined, true], [900777, 'claimed', 'Bbb Test Boss', false]])
      assert.deepEqual(journalToTick(listed), [])
      // Even a tick the leader gave it before doesn't take it, and the boss that dropped it saves it.
      const forced = buildPreview(shared, setup([barrow]), tickJournal(answers({ ticks: { [`${listed.id}|900777`]: true } }), rowOf(before, 'Bbb Test Boss')))
      assert.deepEqual(rowOf(forced, 'Aaa Test Boss').items.map((item) => [item.status, item.ticked]), [['new', true], ['claimed', false]])
      assert.deepEqual(rowOf(forced, 'Bbb Test Boss').items.map((item) => [item.itemId, item.status, item.ticked]), [[900777, 'new', true], [900201, 'new', true]])
    }
  })

  it('never pushes an item the game saw into "no room"', () => {
    const journal = Array.from({ length: 79 }, (_, i) => 910000 + i)
    const seenOnce = (itemId: number) => ({ itemId, n: 1, last: '2026-12-10', via: 'window' as const })
    const night2 = keep([{ npcId: 990011, name: 'Warden of Fixtures', kind: 'boss', itemIds: [900001, ...journal, 900002, 900003], seen: [seenOnce(900001), seenOnce(900002), seenOnce(900003)], journal }])
    const row = buildPreview(night2, setup([barrow]), noAnswers()).zones[0]?.creatures[0] as NonNullable<ReturnType<typeof buildPreview>['zones'][0]['creatures'][0]>
    assert.equal(journalToTick(row).length, 79)
    const after = buildPreview(night2, setup([barrow]), tickJournal(noAnswers(), row))
    const items = after.zones[0]?.creatures[0]?.items ?? []
    assert.deepEqual(items.filter((item) => !item.journalOnly).map((item) => [item.itemId, item.status, item.ticked]), [[900001, 'new', true], [900002, 'new', true], [900003, 'new', true]])
    assert.deepEqual(items.filter((item) => item.journalOnly).map((item) => item.status).filter((status) => status === 'noRoom').length, 2)
    assert.deepEqual([after.counts.items, after.counts.journalItems], [3, 77])
    assert.deepEqual(items.map((item) => item.itemId), [900001, ...journal, 900002, 900003]) // shown in the paste's order
  })

  it('a new creature with only DungeonJournal items is ticked with them', () => {
    const row = buildPreview(night, setup([barrow]), noAnswers()).zones[0]?.creatures[0] as NonNullable<ReturnType<typeof buildPreview>['zones'][0]['creatures'][0]>
    assert.deepEqual([row.status, row.saved, journalToTick(row).length], ['new', false, 2])
    const after = buildPreview(night, setup([barrow]), tickJournal(noAnswers(), row))
    assert.deepEqual([after.zones[0]?.creatures[0]?.saved, after.counts.journalItems], [true, 2])
  })
})

describe('the import panel: ticking an item under a creature that is not saved', () => {
  const BARROW = 50_000_123
  const barrow = zoneDoc(BARROW, 0, { name: 'Test Barrow', kind: 'raid', players: 10, removed: false })
  const barrowNight = (sources: DropsSource[]) => pasted({ name: 'Test Barrow', kind: 'raid', players: 10, sources })
  type Row = NonNullable<ReturnType<typeof buildPreview>['zones'][0]['creatures'][0]>
  // Click the first item's checkbox, as the panel does, and read the creature again.
  const click = (night: CandidateZones, docs: LootTableDoc[], before: ImportAnswers, value: boolean) => {
    const row = buildPreview(night, setup(docs), before).zones[0]?.creatures[0] as Row
    const next = tickItem(before, row, row.items[0] as Row['items'][0], value)
    const after = buildPreview(night, setup(docs), next).zones[0]?.creatures[0] as Row
    return { row, next, after }
  }

  it('a guessed boss is ticked with it, so the click shows', () => {
    const night = barrowNight([boss(990004, 'Maybe Test Boss', [900010], { guessed: true })])
    const { row, after } = click(night, [barrow], noAnswers(), true)
    assert.deepEqual([row.saved, row.items[0]?.ticked], [false, false])
    assert.deepEqual([after.saved, after.items[0]?.ticked], [true, true])
  })

  it('ticks only the item clicked: the creature\'s other items stay unticked until the leader ticks them', () => {
    const three = [900010, 900011, 900012]
    const out = [barrow, sourceDoc(BARROW, 'n990003', 0, { name: 'Warden of the Test Barrow', kind: 'boss', npcId: 990003, itemIds: [900008], removed: true })]
    for (const [night, docs] of [
      [barrowNight([boss(990004, 'Maybe Test Boss', three, { guessed: true })]), [barrow]],
      [barrowNight([boss(990003, 'Warden of the Test Barrow', three)]), out],
      [barrowNight([boss(990001, 'Grimtooth the Test Boss', three)]), [barrow]],
    ] as const) {
      const unticked = night[0]?.sources[0]?.npcId === 990001 ? answers({ ticks: { 'z50000123|cn990001': false } }) : noAnswers()
      const { next, after } = click(night, [...docs], unticked, true)
      assert.deepEqual([after.saved, after.items.map((item) => [item.itemId, item.ticked])], [true, [[900010, true], [900011, false], [900012, false]]])
      // A tick the leader gave before stays.
      const kept = click(night, [...docs], { ...unticked, ticks: { ...unticked.ticks, [`${after.id}|900012`]: true } }, true)
      assert.deepEqual(kept.after.items.map((item) => item.ticked), [true, false, true])
      assert.equal(buildPreview(night, setup([...docs]), next).counts.items, 1)
    }
  })

  it('ticks only the item clicked also near the room limit: an item with no room before the click never comes in by default after it', () => {
    const held = Array.from({ length: 77 }, (_, i) => 910000 + i)
    const four = [900020, 900021, 900022, 900023]
    const out = [barrow, sourceDoc(BARROW, 'n990003', 0, { name: 'Warden of the Test Barrow', kind: 'boss', npcId: 990003, itemIds: held, removed: true })]
    const takenOut = click(barrowNight([boss(990003, 'Warden of the Test Barrow', four)]), out, noAnswers(), true)
    assert.deepEqual(takenOut.row.items.map((item) => item.status), ['new', 'new', 'new', 'noRoom'])
    assert.deepEqual(takenOut.after.items.map((item) => [item.itemId, item.ticked]), [[900020, true], [900021, false], [900022, false], [900023, false]])
    const many = Array.from({ length: 82 }, (_, i) => 920000 + i)
    const guessed = click(barrowNight([boss(990004, 'Maybe Test Boss', many, { guessed: true })]), [barrow], noAnswers(), true)
    assert.deepEqual(guessed.after.items.filter((item) => item.ticked).map((item) => item.itemId), [920000])
  })

  it('a creature a leader took out is brought back with it', () => {
    const docs = [barrow, sourceDoc(BARROW, 'n990003', 0, { name: 'Warden of the Test Barrow', kind: 'boss', npcId: 990003, itemIds: [900008], removed: true })]
    const night = barrowNight([boss(990003, 'Warden of the Test Barrow', [900009])])
    const { row, after } = click(night, docs, noAnswers(), true)
    assert.deepEqual([row.status, row.saved], ['takenOut', false])
    assert.deepEqual([after.saved, after.items[0]?.ticked], [true, true])
  })

  it('a new creature the leader unticked is ticked again with it', () => {
    const night = barrowNight([boss(990001, 'Grimtooth the Test Boss', [900001])])
    const { after } = click(night, [barrow], answers({ ticks: { 'z50000123|cn990001': false } }), true)
    assert.deepEqual([after.saved, after.items[0]?.ticked], [true, true])
  })

  it('a new creature with no item ticked by default is left to the model: saved with the item, and not without it', () => {
    const night = barrowNight([boss(990002, 'Quest Test Boss', [900020], { seen: [{ itemId: 900020, n: 1, last: '2026-12-10', via: 'window', quest: true }] })])
    const ticked = click(night, [barrow], noAnswers(), true)
    assert.deepEqual([ticked.row.saved, ticked.after.saved, ticked.next.ticks['z50000123|cn990002']], [false, true, undefined])
    const unticked = click(night, [barrow], ticked.next, false)
    assert.deepEqual([unticked.after.saved, unticked.after.items[0]?.ticked], [false, false])
  })
})

describe('the import panel: the colors of the zones it makes', () => {
  const docs = [zoneDoc(50_000_123, 0, { name: 'Test Barrow', kind: 'raid', players: 10, removed: false })]
  it('saves a suggested color for each zone with none chosen, and counts the zones that keep the automatic color when that fails', async () => {
    const sent: Record<string, string>[] = []
    const ok = (colors: Record<string, string>) => { sent.push(colors); return Promise.resolve() }
    assert.equal(await colorMadeZones([50_009_300, 50_009_301], setup(docs), { '50009301': '#278794' }, ok), 0)
    assert.deepEqual(sent.map((colors) => Object.keys(colors)), [['50009300']])
    assert.equal(await colorMadeZones([50_009_301], setup(docs), { '50009301': '#278794' }, ok), 0)
    assert.equal(sent.length, 1, 'nothing to save when every zone has a color chosen')
    assert.equal(await colorMadeZones([50_009_300, 50_009_302], setup(docs), {}, () => Promise.reject(new Error('permission-denied'))), 2)
  })

  it('says when a made zone keeps the automatic color', () => {
    assert.equal(keptColorText(1), '1 new zone keeps its automatic color.')
    assert.equal(keptColorText(2), '2 new zones keep their automatic color.')
  })
})

describe('the import panel: a capture file', () => {
  it('gives its text', async () => {
    assert.deepEqual(await readFileText({ text: () => Promise.resolve('{"format":1}') }), { text: '{"format":1}' })
  })

  it("says so when it can't be read, instead of failing unseen", async () => {
    assert.deepEqual(await readFileText({ text: () => Promise.reject(new Error('NotReadableError')) }), { error: "The file couldn't be read." })
  })
})

describe('the import panel: reading the paste', () => {
  it('reads nothing from blank text, and names what the reader refuses', () => {
    assert.equal(readPaste('  \n'), null)
    const refused = readPaste('IM1:drops:not a string')
    assert.ok(refused && 'errors' in refused && refused.errors.length === 1)
  })

  it('never throws: an exception from reading or merging is shown as a paste error', () => {
    const broken = (where: 'read' | 'merge') => ({
      ...pasteReaders,
      readDropsPaste: where === 'read' ? () => { throw new Error('Test reader broke') } : pasteReaders.readDropsPaste,
      mergeDrops: where === 'merge' ? () => { throw new RangeError('Test merge broke') } : pasteReaders.mergeDrops,
    })
    const text = 'IM1:drops:not a string'
    assert.deepEqual(readPaste(text, broken('read')), { errors: ["The text couldn't be read: Test reader broke"] })
    const good = { ...pasteReaders, readDropsPaste: () => ({ ok: true as const, strings: [] }) }
    assert.deepEqual(readPaste(text, { ...good, mergeDrops: broken('merge').mergeDrops }), { errors: ["The text couldn't be read: Test merge broke"] })
    assert.deepEqual(readPaste(text, { ...pasteReaders, looksLikeCapture: () => { throw 'not an error' } }), { errors: ["The text couldn't be read."] })
  })
})

describe('the import panel: building the preview', () => {
  it('never throws: an exception from matching is shown as a paste error', () => {
    const night = pasted(testAbbey([boss(990100, 'Abbot of Fixtures', [900105])]))
    const built = previewOf(night, setup([]), noAnswers())
    assert.ok('preview' in built && built.preview.zones.length === 1)
    assert.deepEqual(previewOf(night, setup([]), noAnswers(), () => { throw new Error('Test match broke') }), { errors: ["The preview couldn't be made: Test match broke"] })
    assert.deepEqual(previewOf(night, setup([]), noAnswers(), () => { throw 'not an error' }), { errors: ["The preview couldn't be made."] })
  })
})

describe('the import panel: a large import into the live phase', () => {
  const line = 'Phase 3 is live: everyone sees this import at once. To prepare it for later, pick Phase 4 below.'

  it('points to the next phase at 20 items or more, DungeonJournal items included', () => {
    assert.equal(nextPhaseHint(counts({ zones: 1, creatures: 3, items: 20 }), 'Phase 3', 'Phase 4'), line)
    assert.equal(nextPhaseHint(counts({ zones: 1, creatures: 3, items: 12, journalItems: 8 }), 'Phase 3', 'Phase 4'), line)
  })

  it('says nothing for a smaller import, or when the phase picked is not the live one', () => {
    assert.equal(nextPhaseHint(counts({ zones: 1, creatures: 3, items: 19 }), 'Phase 3', 'Phase 4'), undefined)
    assert.equal(nextPhaseHint(counts({ zones: 1, creatures: 3, items: 40 }), 'Phase 4', undefined), undefined)
  })
})
