import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { describe, it } from 'node:test'
import { ExchangeReadError, crc32, exchangeMessage, readEnvelopes, readSingleEnvelope, type ExchangeKind } from '../../src/shared/lib/exchangeString.ts'
import { captureCandidate, checkDrops, looksLikeCapture, mergeDrops, mergeEvidence, readCapturePaste, readDropsPaste, type DropsModel, type DropsSource, type DropsZone } from '../../src/shared/game/dropsString.ts'

// The fixtures of docs/spec/fixtures/ are the authority (docs/spec/exchange-v0.md section 12): the Python reference reader and the addon's Lua reader
// give these answers on every case. Every name in them and here is invented.
const fixture = (name: string) => readFileSync(new URL(`../../docs/spec/fixtures/${name}`, import.meta.url), 'utf8')
type Case = { file: string; box: ExchangeKind; expect: string; layer?: 'content'; rowErrors?: string[]; sameAs?: string; envelopes?: number }
const cases = JSON.parse(fixture('cases/cases.json')) as Case[]

// The app's importers read every envelope; the addon's night box takes exactly one (section 1.1, step 10).
function read(text: string, box: ExchangeKind) {
  const check = box === 'drops' ? checkDrops : undefined
  return box === 'night' ? [readSingleEnvelope(text, box, check)] : readEnvelopes(text, box, check)
}
const codeOf = (run: () => unknown) => {
  try { run() } catch (error) { if (error instanceof ExchangeReadError) return error.code; throw error }
  return 'OK'
}
// A hand-made drops string around an ASCII payload, sealed as section 1 says.
const seal = (payload: string) => {
  const sealed = `IM1:drops:j:${payload.length}:${payload}:`
  return sealed + crc32(sealed)
}

describe('the shared envelope reader and the spec cases', () => {
  it('computes every CRC-32 test vector', () => {
    for (const vector of JSON.parse(fixture('crc32-vectors.json')) as { text: string; crc32: string }[]) assert.equal(crc32(vector.text), vector.crc32, JSON.stringify(vector.text))
  })

  for (const entry of cases) {
    // Content checks exist here for the drops box only: a night or awards case that fails in step 9 reads as OK with the envelope steps alone (section 12).
    const contentOnly = entry.box !== 'drops' && (entry.layer === 'content' || (entry.rowErrors?.length ?? 0) > 0)
    it(`${entry.file} in the ${entry.box} box: ${contentOnly ? 'reads (its content check is not this reader\'s)' : entry.expect}`, () => {
      const text = fixture(entry.file)
      if (contentOnly) { assert.equal(codeOf(() => read(text, entry.box)), 'OK'); return }
      assert.equal(codeOf(() => read(text, entry.box)), entry.expect)
      if (entry.expect !== 'OK') return
      const found = read(text, entry.box)
      if (entry.envelopes !== undefined) assert.equal(found.length, entry.envelopes)
      if (entry.box === 'drops') assert.deepEqual(found.flatMap((one) => one.rowErrors).sort(), [...(entry.rowErrors ?? [])].sort())
      if (entry.sameAs) assert.deepEqual(found[0]?.model, JSON.parse(fixture(`${entry.sameAs}.model.json`)))
    })
  }

  it('reads every good fixture to its model', () => {
    for (const [name, box] of [['drops-small', 'drops'], ['awards-small', 'awards'], ['night-small', 'night'], ['night-empty', 'night']] as const) {
      const [one] = read(fixture(`${name}.j.txt`), box)
      assert.deepEqual(one?.model, JSON.parse(fixture(`${name}.model.json`)), name)
      assert.deepEqual(one?.rowErrors, [])
    }
  })

  it("words each error as the spec's table does, with the kind it found", () => {
    const kind = new ExchangeReadError('E_KIND', 'awards', 'awards')
    assert.equal(exchangeMessage(kind, 'drops'), 'This is an awards string; this box takes drops strings. Paste awards strings into the Raid Desk importer.')
    assert.equal(exchangeMessage(new ExchangeReadError('E_KIND', 'night', 'night'), 'drops'), 'This is a night string; this box takes drops strings. Paste night strings into the addon.')
    assert.equal(exchangeMessage(new ExchangeReadError('E_TRUNCATED', '120 of 2636'), 'drops'), 'Only part of the string arrived (120 of 2636 characters). Copy it again, all of it.')
    assert.equal(exchangeMessage(new ExchangeReadError('E_SCHEMA', '2'), 'drops'), 'This string uses schema 2; this version reads up to 1. Update the addon (or reload the Raid Desk).')
    assert.equal(codeOf(() => readEnvelopes('Here it is: IM2:drops:j:2:{}:00000000', 'drops')), 'E_VERSION')
    assert.equal(codeOf(() => readEnvelopes('nothing here', 'drops')), 'E_NOT_IM')
  })

  // The Python reference reader (addon/tools/exchange_fixtures.py) gives these answers: "__proto__" is a key like any other, so an unknown field.
  describe('a "__proto__" key is an unknown field, as in the reference reader', () => {
    const head = '"schema":1,"id":"d-test-0001","at":1,"by":"IntrepidManager/test"'
    const keep = '{"name":"Hollow Test Keep","kind":"dungeon","players":5,"sources":[]}'

    it('in a zone: the zone has no name, kind or size, so it is the row error zone:1', () => {
      const result = readDropsPaste(seal(`{${head},"zones":[{"__proto__":{"name":"Hollow Test Barrow","kind":"raid","players":40},"sources":[]},${keep}]}`))
      assert.equal(result.ok, true)
      if (!result.ok) return
      assert.deepEqual(result.strings[0]?.rowErrors, ['zone:1'])
      assert.deepEqual(mergeDrops(result.strings.map((one) => one.model)).map((zone) => zone.name), ['Hollow Test Keep'])
    })

    it('in a source: the source has no name or kind, so it is the row error zone:1/source:1', () => {
      const result = readDropsPaste(seal(`{${head},"zones":[{"name":"Hollow Test Keep","kind":"dungeon","players":5,"sources":[{"__proto__":{"name":"Grimtooth","kind":"boss"},"itemIds":[]}]}]}`))
      assert.equal(result.ok, true)
      if (result.ok) assert.deepEqual(result.strings[0]?.rowErrors, ['zone:1/source:1'])
    })

    it('beside the fields a row needs: ignored, and kept as an ordinary field of a plain object', () => {
      const payload = `{${head},"zones":[{"__proto__":{"name":"x"},"name":"Hollow Test Keep","kind":"dungeon","players":5,"sources":[{"__proto__":{"kind":"trash"},"name":"Grimtooth","kind":"boss","itemIds":[]}]}]}`
      const [one] = readEnvelopes(seal(payload), 'drops', checkDrops)
      assert.deepEqual(one?.rowErrors, [])
      assert.deepEqual(one?.model, JSON.parse(payload))
      const zone = (one?.model.zones as Record<string, unknown>[] | undefined)?.[0] as Record<string, unknown>
      assert.equal(Object.getPrototypeOf(zone), Object.prototype)
      assert.equal(zone.name, 'Hollow Test Keep')
      const result = readDropsPaste(seal(payload))
      assert.equal(result.ok, true)
      if (result.ok) assert.deepEqual(mergeDrops(result.strings.map((read) => read.model))[0]?.sources.map((source) => [source.name, source.kind]), [['Grimtooth', 'boss']])
    })

    it('at the top level: what is inside it is not read', () => {
      const zones = `"zones":[${keep}]`
      assert.equal(codeOf(() => readEnvelopes(seal(`{"__proto__":{${head},${zones}}}`), 'drops', checkDrops)), 'E_PAYLOAD')
      assert.equal(codeOf(() => readEnvelopes(seal(`{"schema":1,"__proto__":{"id":"d-test-0001","at":1,"by":"IntrepidManager/test",${zones}}}`), 'drops', checkDrops)), 'E_PAYLOAD')
      assert.equal(codeOf(() => readEnvelopes(seal(`{"__proto__":{"schema":1},"schema":2,"id":"d-test-0001","at":1,"by":"IntrepidManager/test",${zones}}`), 'drops', checkDrops)), 'E_SCHEMA')
      assert.equal(codeOf(() => readEnvelopes(seal(`{"__proto__":{"schema":9},${head},${zones}}`), 'drops', checkDrops)), 'OK')
    })
  })
})

describe('readDropsPaste', () => {
  it('leaves out the rows that failed and names them', () => {
    const result = readDropsPaste(fixture('cases/drops-ok-row-errors.txt'))
    assert.equal(result.ok, true)
    if (!result.ok) return
    const [one] = result.strings
    assert.deepEqual([...(one?.rowErrors ?? [])].sort(), ['zone:1/source:2', 'zone:1/source:5', 'zone:2'])
    const raw = readEnvelopes(fixture('cases/drops-ok-row-errors.txt'), 'drops')[0]?.model as { zones: { sources: unknown[] }[] }
    assert.equal(one?.model.zones.length, raw.zones.length - 1)
    assert.equal(one?.model.zones[0]?.sources.length, (raw.zones[0]?.sources.length ?? 0) - 2)
  })

  it('answers a damaged paste with the message for the person who pasted it', () => {
    const result = readDropsPaste(fixture('cases/drops-bad-altered.txt'))
    assert.deepEqual(result, { ok: false, code: 'E_CHECKSUM', message: 'The string was changed after it was copied. Copy it again from the source.' })
    const wrongBox = readDropsPaste(fixture('awards-small.j.txt'))
    assert.equal(wrongBox.ok, false)
    if (!wrongBox.ok) assert.match(wrongBox.message, /^This is an awards string; this box takes drops strings\./)
  })

  it('reads two strings pasted together', () => {
    const result = readDropsPaste(fixture('cases/drops-ok-two-strings.txt'))
    assert.equal(result.ok && result.strings.length, 2)
  })
})

// ---- Merging (section 14.4 and the design's worked examples)

const model = (zones: DropsZone[], journal?: string): DropsModel => ({ schema: 1, id: 'd-test-0001', at: 1797474600, by: 'IntrepidManager/test', ...(journal ? { journal } : {}), zones })
const raid = (sources: DropsSource[], extra: Partial<DropsZone> = {}): DropsZone => ({ name: 'Hollow Test Barrow', kind: 'raid', players: 40, instanceId: 9901, difficultyId: 9, sources, ...extra })
const seen = (itemId: number, n: number, last: string, via: 'window' | 'roll' = 'window') => ({ itemId, n, last, via })

describe('mergeDrops', () => {
  it("joins a raider's rolls to the loot master's corpse of the same encounter (worked example 18)", () => {
    const lootMaster = model([raid([{ npcId: 990001, encounterId: 9101, name: 'Grimtooth the Test Boss', kind: 'boss', kills: 1, first: '2026-12-10', last: '2026-12-10', itemIds: [900001], seen: [seen(900001, 1, '2026-12-10')] }])])
    const raider = model([raid([{ encounterId: 9101, name: 'Grimtooth Encounter', kind: 'boss', kills: 1, first: '2026-12-10', last: '2026-12-10', itemIds: [900001, 900007], seen: [seen(900001, 1, '2026-12-10', 'roll'), seen(900007, 1, '2026-12-10', 'roll')] }])])
    const [zone] = mergeDrops([lootMaster, raider])
    assert.equal(zone?.sources.length, 1)
    const boss = zone?.sources[0]
    assert.equal(boss?.npcId, 990001)
    assert.equal(boss?.name, 'Grimtooth the Test Boss')
    assert.deepEqual(boss?.items.map((item) => item.itemId), [900001, 900007])
    assert.deepEqual(boss?.items[0]?.evidence.seen, { n: 1, last: '2026-12-10', via: 'window' })
  })

  it('takes the larger count two clients saw, never the sum, and the widest dates', () => {
    const a = model([raid([{ npcId: 990001, name: 'Grimtooth the Test Boss', kind: 'boss', kills: 2, first: '2026-12-10', last: '2026-12-17', itemIds: [900001], seen: [seen(900001, 2, '2026-12-17')] }])])
    const b = model([raid([{ npcId: 990001, name: 'Grimtooth the Test Boss', kind: 'boss', kills: 1, first: '2026-12-03', last: '2026-12-10', itemIds: [900001], seen: [{ itemId: 900001, n: 1, last: '2026-12-10', via: 'roll', name: 'Blade of the Fixture', quality: 4 }] }])])
    const boss = mergeDrops([a, b])[0]?.sources[0]
    assert.equal(boss?.kills, 2)
    assert.equal(boss?.first, '2026-12-03')
    assert.equal(boss?.last, '2026-12-17')
    assert.deepEqual(boss?.items[0]?.evidence.seen, { n: 2, last: '2026-12-17', via: 'window', name: 'Blade of the Fixture', quality: 4 })
  })

  it('merges repeated zones and creatures of one string, and keeps every difficulty seen', () => {
    const one = model([
      raid([{ npcId: 990001, name: 'Grimtooth the Test Boss', kind: 'boss', itemIds: [900001], seen: [seen(900001, 1, '2026-12-10')] }]),
      raid([{ npcId: 990001, name: 'Grimtooth the Test Boss', kind: 'boss', itemIds: [900002], seen: [seen(900002, 1, '2026-12-10')] }]),
      raid([], { difficultyId: 186 }),
    ])
    const zones = mergeDrops([one])
    assert.equal(zones.length, 2) // instance 9901 at difficulty 9, and at 186: grouped by the preview, not here
    assert.deepEqual(zones[0]?.sources[0]?.items.map((item) => item.itemId), [900001, 900002])
    assert.deepEqual(zones[0]?.difficultyIds, [9])
  })

  it('keeps the rolls of a fight of several bosses apart from both corpses', () => {
    const one = model([raid([
      { npcId: 990011, encounterId: 9110, name: 'Test Twin One', kind: 'boss', itemIds: [900011], seen: [seen(900011, 1, '2026-12-10')] },
      { npcId: 990012, encounterId: 9110, name: 'Test Twin Two', kind: 'boss', itemIds: [900012], seen: [seen(900012, 1, '2026-12-10')] },
      { encounterId: 9110, name: 'The Test Twins', kind: 'boss', itemIds: [900013], seen: [seen(900013, 1, '2026-12-10', 'roll')] },
    ])])
    assert.deepEqual(mergeDrops([one])[0]?.sources.map((source) => source.name), ['Test Twin One', 'Test Twin Two', 'The Test Twins'])
  })

  // Design 2.2 step 3: a guess is confirmed only by a sure boss row for the same npc (the game's, or DungeonJournal naming it as a boss).
  describe('a guessed boss', () => {
    const guessedRow: DropsSource = { npcId: 990005, encounterId: 9105, name: 'Guessed Test Boss', kind: 'boss', guessed: true, kills: 1, itemIds: [900020], seen: [seen(900020, 1, '2026-12-10')] }
    const guessed = model([raid([guessedRow])])
    const only = (zones: ReturnType<typeof mergeDrops>) => {
      assert.equal(zones.length, 1)
      assert.equal(zones[0]?.sources.length, 1)
      return zones[0]?.sources[0]
    }

    it('stays guessed alone, and with another guess of the same kill', () => {
      assert.equal(only(mergeDrops([guessed]))?.guessed, true)
      assert.equal(only(mergeDrops([guessed, guessed]))?.guessed, true)
    })

    it("stays guessed, and a boss, when a raider's string has the same npc as trash, in either order", () => {
      const raider = model([raid([{ npcId: 990005, name: 'Guessed Test Boss', kind: 'trash', kills: 1, itemIds: [900020, 900021], seen: [seen(900020, 1, '2026-12-10'), seen(900021, 1, '2026-12-10')] }])])
      for (const strings of [[guessed, raider], [raider, guessed]]) {
        const merged = only(mergeDrops(strings))
        assert.equal(merged?.guessed, true)
        assert.equal(merged?.kind, 'boss')
        assert.deepEqual(merged?.items.map((item) => item.itemId).sort(), [900020, 900021])
      }
    })

    it("stays guessed when the encounter's rolls join the corpse, in one string or two", () => {
      const rollsRow: DropsSource = { encounterId: 9105, name: 'Guessed Test Encounter', kind: 'boss', kills: 1, itemIds: [900040], seen: [seen(900040, 1, '2026-12-17', 'roll')] }
      for (const strings of [[model([raid([guessedRow, rollsRow])])], [guessed, model([raid([rollsRow])])], [model([raid([rollsRow])]), guessed]]) {
        const merged = only(mergeDrops(strings))
        assert.equal(merged?.npcId, 990005)
        assert.equal(merged?.guessed, true)
        assert.deepEqual(merged?.items.map((item) => item.itemId), [900020, 900040])
      }
    })

    it('is confirmed by a sure boss row for the same npc, in either order', () => {
      const sure = model([raid([{ npcId: 990005, encounterId: 9105, name: 'Guessed Test Boss', kind: 'boss', kills: 1, itemIds: [900020], seen: [seen(900020, 1, '2026-12-17')] }])])
      for (const strings of [[guessed, sure], [sure, guessed]]) assert.equal(only(mergeDrops(strings))?.guessed, undefined)
    })

    it('is confirmed by DungeonJournal naming the same npc as a boss', () => {
      const journal = model([raid([{ npcId: 990005, name: 'Guessed Test Boss', kind: 'boss', itemIds: [900020, 900022], journal: [900020, 900022] }])], 'ForeverDungeonJournal/2.0.3')
      for (const strings of [[guessed, journal], [journal, guessed]]) {
        const merged = only(mergeDrops(strings))
        assert.equal(merged?.guessed, undefined)
        assert.equal(merged?.kind, 'boss')
      }
    })

    it('stays guessed when a trash row and the rolls both join it, and a sure boss row still confirms it after them', () => {
      const raider = { npcId: 990005, name: 'Guessed Test Boss', kind: 'trash' as const, itemIds: [900021], seen: [seen(900021, 1, '2026-12-10')] }
      const rolls = { encounterId: 9105, name: 'Guessed Test Encounter', kind: 'boss' as const, itemIds: [900040], seen: [seen(900040, 1, '2026-12-17', 'roll')] }
      assert.equal(only(mergeDrops([model([raid([raider, rolls, guessedRow])])]))?.guessed, true)
      const sure = { npcId: 990005, name: 'Guessed Test Boss', kind: 'boss' as const, itemIds: [900020], seen: [seen(900020, 1, '2026-12-17')] }
      assert.equal(only(mergeDrops([model([raid([raider, rolls, guessedRow, sure])])]))?.guessed, undefined)
    })
  })

  // Spec section 2: only ASCII spaces are blank. A tab, a no-break space or an ideographic space is text, and the name key keeps it.
  describe('names', () => {
    it('trims ASCII spaces only, so a name of tabs (the fixture drops-ok-blank-names) stays a name', () => {
      const result = readDropsPaste(fixture('cases/drops-ok-blank-names.txt'))
      assert.equal(result.ok, true)
      if (!result.ok) return
      const source = mergeDrops(result.strings.map((one) => one.model)).flatMap((zone) => zone.sources).find((one) => one.npcId === 990001)
      assert.equal(source?.name, '\t\t')
      const zones = mergeDrops([model([raid([
        { npcId: 990001, name: '  Grimtooth the Test Boss  ', kind: 'boss', itemIds: [900001], seen: [seen(900001, 1, '2026-12-10')] },
        { npcId: 990002, name: ' Lady Test Ipsum　', kind: 'boss', itemIds: [900002], seen: [seen(900002, 1, '2026-12-10')] },
      ], { name: ' Hollow Test Barrow ' })])])
      assert.equal(zones[0]?.name, 'Hollow Test Barrow ')
      assert.deepEqual(zones[0]?.sources.map((one) => one.name), ['Grimtooth the Test Boss', ' Lady Test Ipsum　'])
    })

    it('joins names the name key joins, and keeps apart names that differ by other whitespace', () => {
      const ghoul = (name: string): DropsSource => ({ name, kind: 'trash', itemIds: [900030], seen: [seen(900030, 1, '2026-12-10')] })
      const names = (...rows: DropsSource[]) => mergeDrops([model([raid(rows)])])[0]?.sources.map((one) => one.name)
      assert.deepEqual(names(ghoul(' Stone  Test Ghoul'), ghoul('Stone Test Ghoul')), ['Stone  Test Ghoul'])
      assert.deepEqual(names(ghoul('\tStone Test Ghoul'), ghoul('Stone Test Ghoul')), ['\tStone Test Ghoul', 'Stone Test Ghoul'])
      assert.deepEqual(names(ghoul('Stone Test Ghoul '), ghoul('Stone Test Ghoul')), ['Stone Test Ghoul ', 'Stone Test Ghoul'])
    })

    it('trims ASCII spaces only in a capture file too', () => {
      const zone = captureCandidate({
        format: 1, zoneId: 5555, name: ' Hollow Test Barrow ', kind: 'raid', players: 40, source: 'https://example.invalid/test', capturedAt: '2026-12-10',
        sources: [{ npcId: 990001, name: '\tGrimtooth the Test Boss  ', kind: 'boss', itemIds: [900001] }], zoneWideItemIds: [],
      } as never)
      assert.equal(zone.name, 'Hollow Test Barrow ')
      assert.equal(zone.sources[0]?.name, '\tGrimtooth the Test Boss')
    })
  })

  it("names a creature as the game does, not as DungeonJournal does, whichever string comes first", () => {
    const game = model([raid([{ npcId: 990011, name: 'The Fixture Warden', kind: 'boss', kills: 1, itemIds: [900101], seen: [seen(900101, 1, '2026-12-01')] }])])
    const journal = model([raid([{ npcId: 990011, name: 'Warden of Fixtures', kind: 'boss', itemIds: [900101, 900102], journal: [900101, 900102] }])], 'ForeverDungeonJournal/2.0.3')
    const noItemsYet = model([raid([{ npcId: 990011, name: 'The Fixture Warden', kind: 'boss', kills: 1, itemIds: [] }])])
    for (const strings of [[game, journal], [journal, game], [noItemsYet, journal], [journal, noItemsYet]]) {
      assert.deepEqual(mergeDrops(strings)[0]?.sources.map((source) => source.name), ['The Fixture Warden'])
    }
  })

  it("marks DungeonJournal's items and carries its version and notes on the zone", () => {
    const journal = model([{ name: 'Hollow Test Keep', kind: 'dungeon', players: 5, journalPartial: true, journalSkipped: 2, sources: [
      { npcId: 990011, name: 'Warden of Fixtures', kind: 'boss', itemIds: [900101, 900102], seen: [seen(900101, 1, '2026-12-01')], journal: [900101, 900102] },
    ] }], 'ForeverDungeonJournal/2.0.3')
    const [zone] = mergeDrops([journal])
    assert.equal(zone?.journal, 'ForeverDungeonJournal/2.0.3')
    assert.equal(zone?.journalPartial, true)
    assert.equal(zone?.journalSkipped, 2)
    const listed = ['ForeverDungeonJournal/2.0.3']
    assert.deepEqual(zone?.sources[0]?.items.map((item) => item.evidence), [{ seen: { n: 1, last: '2026-12-01', via: 'window' }, journal: listed }, { journal: listed }])
  })

  it("keeps on each DungeonJournal item the versions of the strings that list it", () => {
    const keep = (itemIds: number[]) => [{ name: 'Hollow Test Keep', kind: 'dungeon' as const, players: 5, instanceId: 9100, sources: [{ npcId: 990011, name: 'Warden of Fixtures', kind: 'boss' as const, itemIds, journal: itemIds }] }]
    const newer = model(keep([900102, 900103]), 'ForeverDungeonJournal/2.10.0')
    const older = model(keep([900101, 900103]), 'ForeverDungeonJournal/2.9.1')
    for (const strings of [[newer, older], [older, newer]]) {
      const items = mergeDrops(strings)[0]?.sources[0]?.items ?? []
      assert.deepEqual(Object.fromEntries(items.map((item) => [item.itemId, item.evidence.journal])), {
        900101: ['ForeverDungeonJournal/2.9.1'], 900102: ['ForeverDungeonJournal/2.10.0'], 900103: ['ForeverDungeonJournal/2.9.1', 'ForeverDungeonJournal/2.10.0'],
      })
    }
    // A string that lists the journal's items without saying its version has the version the addon sends when it doesn't know it.
    assert.deepEqual(mergeDrops([model(keep([900101]))])[0]?.sources[0]?.items[0]?.evidence, { journal: ['ForeverDungeonJournal/unknown'] })
    assert.deepEqual(mergeEvidence({ journal: ['ForeverDungeonJournal/2.1.0'], seen: { n: 1, last: '2026-12-01' } }, { journal: ['ForeverDungeonJournal/2.0.3', 'ForeverDungeonJournal/2.1.0'] }), { seen: { n: 1, last: '2026-12-01' }, journal: ['ForeverDungeonJournal/2.0.3', 'ForeverDungeonJournal/2.1.0'] })
  })

  it('merges the fixture drops-small into its two zones', () => {
    const result = readDropsPaste(fixture('drops-small.j.txt'))
    assert.equal(result.ok, true)
    if (!result.ok) return
    const zones = mergeDrops(result.strings.map((one) => one.model))
    assert.deepEqual(zones.map((zone) => [zone.name, zone.kind, zone.players]), [['Hollow Test Barrow', 'raid', 40], ['Hollow Test Keep', 'dungeon', 5]])
    for (const zone of zones) for (const source of zone.sources) for (const item of source.items) assert.ok(Object.keys(item.evidence).length > 0, `${source.name} ${item.itemId}`)
  })
})

describe('capture files', () => {
  const capture = {
    format: 1, zoneId: 5555, name: 'Hollow Test Barrow', kind: 'raid', players: 40, source: 'https://example.invalid/test', capturedAt: '2026-12-10',
    sources: [{ npcId: 990001, name: 'Grimtooth the Test Boss', kind: 'boss', itemIds: [900001, 900002] }], zoneWideItemIds: [900050],
  }

  it("reads a capture as a candidate and keeps Wowhead's zone id apart (worked example 13)", () => {
    const result = readCapturePaste(JSON.stringify(capture))
    assert.equal(result.ok, true)
    if (!result.ok) return
    const [zone] = result.zones
    assert.equal(zone?.zoneId, undefined)
    assert.equal(zone?.captureZoneId, 5555)
    assert.deepEqual(zone?.zoneWide, [{ itemId: 900050, evidence: { capture: true } }])
    assert.deepEqual(zone, captureCandidate(capture as never))
  })

  it("lists every problem of a broken capture, and tells a capture from a drops string", () => {
    const result = readCapturePaste(JSON.stringify([capture, { ...capture, players: 0 }]))
    assert.deepEqual(result, { ok: false, errors: ['Capture 2: players must be a whole number from 1 to 40.'] })
    assert.equal(looksLikeCapture(`  ${JSON.stringify(capture)}`), true)
    assert.equal(looksLikeCapture(fixture('drops-small.j.txt')), false)
  })
})
