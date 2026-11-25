// Loot tables: the lootTables block of firestore.rules (validTableCreate, validTableEdit and the table branch of the audit entry rules).
//
// The guild's own changes to the drop lists of Browse drops, one document per zone or creature PER LOOT PHASE. A document carries the phase it was
// written in (`phaseNo`) and means "from this phase on, until a later phase's document says otherwise", and it says only what its phase changes. Three
// kinds: a zone the guild made (a number of 50 million or more), a "presence" document for a zone of the built-in captures (it only says whether the
// zone is in the lists), and a creature or the zone-wide list (`type: 'source'`: items added in the phase and items taken off from it).
//
// Like a priority, a table is written only together with its audit entry (type 'table') in the same batch, with the stamps the rules set, and only in
// the current phase or the next one. Unlike a priority it is never deleted (an entry id can be used once), so taking one away is `removed: true`.
// Only the sizes of the lists are checked. See docs/design/audit-first-loot.md.
import assert from 'node:assert/strict'
import { describe, test } from 'node:test'
import { deleteDoc, getDoc, serverTimestamp, setDoc, writeBatch, type DocumentData } from 'firebase/firestore'
import { LABEL, RAID_STAFF, UID, without } from './support/fixtures.ts'
import { asAdmin, dbFor, expectAllowed, expectDenied, guildDoc, outcomeOf, resetData, setUpGuildEmulator, stored } from './support/harness.ts'
import {
  BUILT_IN_SOURCE_TABLE, BUILT_IN_ZONE_NO, GONE, NPC_KEY, PRESENCE_TABLE, SOURCE_TABLE, ZONE_NO, ZONE_TABLE, changePhase, createTable, editTable, entry, entryId, inPhase,
  overlayTableDoc, phaseTableId, presenceTableDoc, sourceTableDoc, sourceTableId, storeTable, tableIdOf, zoneTableDoc, zoneTableId, type CreateTableOptions, type EditTableOptions, type Staff,
} from './support/audit.ts'
import { asDouble, rawCommit, requestTime } from './support/raw.ts'

setUpGuildEmulator()

const ids = (count: number, from = 1000) => Array.from({ length: count }, (_, index) => from + index)
/** A value of the same type that differs from `value`, for an entry that misreports it. */
const other = (value: unknown): unknown => (typeof value === 'number' ? value + 1 : typeof value === 'string' ? `${value}x` : typeof value === 'boolean' ? !value : Array.isArray(value) ? [...value, 9] : 'other')
const KINDS_OF_SOURCE = ['boss', 'rare', 'trash', 'zonewide']

// The fields another kind of document has and this one must not gain.
const SOURCE_ONLY: DocumentData = { key: 'c9', npcId: 4887, order: 10, itemIds: [1], hiddenItemIds: [2] }
const ZONE_ONLY: DocumentData = { players: 5 }
const PRESENCE_FOREIGN: DocumentData = { name: 'Test Hollow', kind: 'dungeon', players: 5, ...SOURCE_ONLY }

for (const who of RAID_STAFF as readonly Staff[]) {
  const make = (fields: DocumentData, extra: Omit<CreateTableOptions, 'fields'> = {}) => createTable(dbFor(who), who, { fields, ...extra })
  const zone = (overrides: DocumentData = {}, extra: Omit<CreateTableOptions, 'fields'> = {}) => make(zoneTableDoc(overrides), extra)
  const presence = (overrides: DocumentData = {}, extra: Omit<CreateTableOptions, 'fields'> = {}) => make(presenceTableDoc(overrides), extra)
  const source = (overrides: DocumentData = {}, extra: Omit<CreateTableOptions, 'fields'> = {}) => make(sourceTableDoc(overrides), extra)
  const stamps: [string, DocumentData][] = [
    ['a revision other than 1', { rev: 2 }],
    ['a revision that is text', { rev: '1' }],
    ['a revision of 1.5', { rev: 1.5 }],
    ['someone else as the updater', { updatedBy: UID[who === 'guildLeader' ? 'raidLeader' : 'guildLeader'] }],
    ['an update time from the client', { updatedAt: new Date('2026-01-01T00:00:00Z') }],
    ['an update time that is text', { updatedAt: 'now' }],
    ['a createdBy, which only awards have', { createdBy: UID[who] }],
    ['a createdAt, which only awards have', { createdAt: serverTimestamp() }],
  ]

  describe(`a ${LABEL[who]} creates a zone of the guild's own`, () => {
    test('with its entry, a zone is stored with the stamps the rules set, and the entry says who made it and what it holds', async () => {
      await expectAllowed(zone())
      const saved = await stored(`lootTables/${ZONE_TABLE}`)
      assert.equal(saved?.rev, 1)
      assert.equal(saved?.updatedBy, UID[who])
      assert.equal(saved?.name, 'Test Hollow')
      assert.equal(saved?.phaseNo, 0)
      const logged = await stored(`auditLog/${entryId('table', ZONE_TABLE, 1)}`)
      assert.equal(logged?.by, UID[who])
      assert.equal(logged?.action, 'create')
      assert.equal(logged?.item, 'Test Hollow')
      assert.equal(logged?.after?.players, 5)
      assert.equal(logged?.after?.phaseNo, 0)
    })

    test('a zone for the next phase carries the phase in its id', async () => {
      await expectAllowed(zone({ phaseNo: 1 }))
      assert.equal((await stored(`lootTables/${zoneTableId(ZONE_NO, 1)}`))?.phaseNo, 1)
    })

    test('a zone says only what it sets: every optional field can be left out or given, alone or together', async () => {
      const variants: [string, DocumentData][] = [
        ['nothing but its number', { name: undefined, kind: undefined, players: undefined }],
        ['a name alone', { kind: undefined, players: undefined }],
        ['a kind alone', { name: undefined, players: undefined }],
        ['a size alone', { name: undefined, kind: undefined }],
        ['removed: true alone', { name: undefined, kind: undefined, players: undefined, removed: true }],
        ['removed: false alone', { name: undefined, kind: undefined, players: undefined, removed: false }],
        ['every field', { removed: false }],
        ['a name and removed: true', { kind: undefined, players: undefined, removed: true }],
      ]
      for (const [index, [label, overrides]] of variants.entries()) await expectAllowed(zone({ zoneId: 60_000_100 + index, ...overrides }), label)
      const bare = await stored(`auditLog/${entryId('table', zoneTableId(60_000_100, 0), 1)}`)
      assert.equal(bare?.item, '', 'a zone with no name is logged with an empty label')
    })

    test('a raid of 40, the longest name and the highest number are accepted', async () => {
      await expectAllowed(zone({ zoneId: 100_000_000, name: 'x'.repeat(100), kind: 'raid', players: 40 }))
    })

    test('the lowest number of a zone of the guild\'s own (50 million) is accepted, and one below it is a built-in zone with another shape', async () => {
      await expectAllowed(zone({ zoneId: 50_000_000 }))
      await expectDenied(zone({ zoneId: 49_999_999 }), 'a built-in number with a name, kind and size')
      await expectDenied(zone({ zoneId: 1581 }), 'a built-in zone')
    })

    test('a zone numbered 50 million is checked like any other zone of the guild\'s own: a bad name, kind or size is refused there too', async () => {
      for (const overrides of [{ name: '' }, { name: '  ' }, { kind: 'boss' }, { players: 0 }, { players: 41 }, { name: 5 }]) {
        await expectDenied(zone({ zoneId: 50_000_000, ...overrides }), JSON.stringify(overrides))
        await expectDenied(zone({ zoneId: 50_000_001, ...overrides }), `one above: ${JSON.stringify(overrides)}`)
      }
    })

    test('a name of one character and a size of 1 are accepted, and a name with spaces around it is too', async () => {
      await expectAllowed(zone({ name: 'x', players: 1 }), 'the smallest')
      await expectAllowed(zone({ zoneId: 60_000_101, name: '  Test Hollow  ' }), 'spaces around it')
    })

    test('a zone without its entry, or with the entry of another document, is refused', async () => {
      await expectDenied(zone({}, { skipEntry: true }), 'no entry')
      await expectDenied(zone({}, { entryKey: entryId('table', zoneTableId(60_000_002, 0), 1) }), 'an entry for another zone')
      await expectDenied(zone({}, { audit: { action: 'edit' } }), 'an entry that says edit')
      await expectDenied(zone({}, { audit: { action: 'delete' } }), 'an entry that says delete')
      await expectDenied(zone({}, { audit: { after: { ...zoneTableDoc(), name: 'Another Hollow' } } }), 'an entry that lists another name')
      await expectDenied(zone({}, { audit: { item: 'Another Hollow' } }), 'an entry with another label')
      await expectDenied(zone({}, { audit: { item: '' } }), 'an entry with an empty label, though the zone has a name')
    })

    for (const field of ['type', 'zoneId', 'phaseNo']) {
      test(`a zone with no ${field} is refused`, async () => {
        await expectDenied(createTable(dbFor(who), who, { id: ZONE_TABLE, fields: without(zoneTableDoc(), field) }))
      })
    }
    for (const field of ['rev', 'updatedBy', 'updatedAt']) {
      test(`a zone with no ${field} is refused`, async () => {
        await expectDenied(zone({}, { table: { [field]: undefined } }))
      })
    }

    const bad: [string, DocumentData][] = [
      ['an unknown field', { extra: 'anything' }],
      ['an empty name', { name: '' }],
      ['a name of spaces', { name: '   ' }],
      ['a name of a tab and a line break', { name: '\t\n' }],
      ['a name over 100 characters', { name: 'x'.repeat(101) }],
      ['a name of 100 characters and a space in front, which is over 100 characters long', { name: ` ${'x'.repeat(100)}` }],
      ['a name that is not text', { name: 5 }],
      ['a name of null', { name: null }],
      ['a name that is a list', { name: ['Test Hollow'] }],
      ['a kind that is neither dungeon nor raid', { kind: 'boss' }],
      ['a creature kind (rare)', { kind: 'rare' }],
      ['a creature kind (trash)', { kind: 'trash' }],
      ['a creature kind (zonewide)', { kind: 'zonewide' }],
      ['a kind spelled with a capital', { kind: 'Dungeon' }],
      ['a kind that is not text', { kind: 5 }],
      ['a kind of null', { kind: null }],
      ['0 players', { players: 0 }],
      ['41 players', { players: 41 }],
      ['-1 players', { players: -1 }],
      ['5.5 players', { players: 5.5 }],
      ['players as text', { players: '5' }],
      ['players of null', { players: null }],
      ['a zone number that is text', { zoneId: '60000001' }],
      ['a zone number of 1.5', { zoneId: 60_000_001.5 }],
      ['a zone number of 0', { zoneId: 0 }],
      ['a negative zone number', { zoneId: -60_000_001 }],
      ['a zone number over 100 million', { zoneId: 100_000_001 }],
      ['a type that is neither zone nor source', { type: 'dungeon' }],
      ['a type that is not text', { type: 5 }],
      ['removed as text', { removed: 'true' }],
      ['removed as a number', { removed: 1 }],
      ['removed as null', { removed: null }],
      ['removed as a list', { removed: [true] }],
      ['removed as a map', { removed: { a: true } }],
    ]
    for (const [label, overrides] of bad) {
      test(`a zone with ${label} is refused`, async () => {
        await expectDenied(zone(overrides))
      })
    }
    // The stamps are the rules' to set: they go in the document (`table`), not in the fields the entry tells, as a client that cheated would send them.
    for (const [label, table] of stamps) {
      test(`a zone with ${label} is refused`, async () => {
        await expectDenied(zone({}, { table }))
      })
    }

    test('a zone cannot have the fields of a creature, whatever the value', async () => {
      for (const [field, value] of Object.entries(SOURCE_ONLY)) await expectDenied(zone({ [field]: value }), field)
      await expectDenied(zone({ kind: 'zonewide' }), 'a creature kind')
      await expectDenied(zone({}, { audit: { after: { ...zoneTableDoc(), itemIds: [1] }, changed: [...Object.keys(zoneTableDoc()), 'itemIds'] }, table: { itemIds: [1] } }), 'with an entry that lists it')
    })

    test('a zone filed under an id that is not made from its number and phase is refused', async () => {
      for (const id of [zoneTableId(60_000_002, 0), zoneTableId(ZONE_NO, 1), ZONE_TABLE.replace(/_0$/, ''), 'zone-1', `z${ZONE_NO}_00`, `Z${ZONE_NO}_0`, `s${ZONE_NO}_0`, `s${ZONE_NO}_c1_0`, `z${ZONE_NO}_0_`]) {
        await expectDenied(createTable(dbFor(who), who, { id, fields: zoneTableDoc() }), id)
      }
      await expectAllowed(zone(), 'the id its fields make')
    })

    test('a revision other than 1 is refused even with the entry of that revision', async () => {
      await expectDenied(zone({}, { table: { rev: 2 }, entryKey: entryId('table', ZONE_TABLE, 2), audit: { rev: 2 } }), 'revision 2 with its own entry')
    })
  })

  describe(`a ${LABEL[who]} takes a zone of the built-in captures out of the lists, or puts it back`, () => {
    test('a presence document is stored with the stamps the rules set, and its entry has no label (the document has no name)', async () => {
      await expectAllowed(presence())
      const saved = await stored(`lootTables/${PRESENCE_TABLE}`)
      assert.equal(saved?.removed, true)
      assert.equal(saved?.updatedBy, UID[who])
      assert.deepEqual(Object.keys(saved ?? {}).sort(), ['phaseNo', 'removed', 'rev', 'type', 'updatedAt', 'updatedBy', 'zoneId'])
      const logged = await stored(`auditLog/${entryId('table', PRESENCE_TABLE, 1)}`)
      assert.equal(logged?.item, '')
      assert.equal(logged?.action, 'create')
      assert.deepEqual(((logged?.changed ?? []) as string[]).slice().sort(), ['phaseNo', 'removed', 'type', 'zoneId'])
    })

    test('removed: true and removed: false are both accepted, in either phase that can be written', async () => {
      await expectAllowed(presence({ removed: false }), 'back in')
      await expectAllowed(presence({ zoneId: 1582 }), 'out')
      await expectAllowed(presence({ zoneId: 1583, phaseNo: 1 }), 'out from the next phase')
    })

    test('the lowest and highest numbers of a built-in zone are accepted', async () => {
      await expectAllowed(presence({ zoneId: 1 }))
      await expectAllowed(presence({ zoneId: 49_999_999 }))
      await expectDenied(presence({ zoneId: 0 }), 'zone 0')
      await expectDenied(presence({ zoneId: -1 }), 'a negative number')
      await expectDenied(presence({ zoneId: 1.5 }), 'a number that is not whole')
      await expectDenied(presence({ zoneId: '1581' }), 'a number that is text')
    })

    test('it has to say removed: a document that says nothing is not created', async () => {
      await expectDenied(createTable(dbFor(who), who, { id: PRESENCE_TABLE, fields: without(presenceTableDoc(), 'removed') }), 'no removed')
      await expectAllowed(presence(), 'with it')
    })

    test('removed has to be a true or false', async () => {
      for (const removed of ['true', 'false', 1, 0, null, [true], { a: true }, '']) await expectDenied(presence({ removed }), JSON.stringify(removed))
    })

    for (const field of ['type', 'zoneId', 'phaseNo']) {
      test(`a presence document with no ${field} is refused`, async () => {
        await expectDenied(createTable(dbFor(who), who, { id: PRESENCE_TABLE, fields: without(presenceTableDoc(), field) }))
      })
    }
    for (const field of ['rev', 'updatedBy', 'updatedAt']) {
      test(`a presence document with no ${field} is refused`, async () => {
        await expectDenied(presence({}, { table: { [field]: undefined } }))
      })
    }

    test('nothing else is allowed on it: no name, kind or size of the zone, no creature field, nothing unknown', async () => {
      for (const [field, value] of Object.entries(PRESENCE_FOREIGN)) await expectDenied(presence({ [field]: value }), field)
      await expectDenied(presence({ extra: 'anything' }), 'an unknown field')
      for (const [label, table] of stamps) await expectDenied(presence({}, { table }), label)
    })

    test('its entry names no label: a label is refused, and so is a name field the entry invents', async () => {
      await expectDenied(presence({}, { audit: { item: 'Test Hollow' } }), 'a label')
      await expectDenied(presence({}, { audit: { item: PRESENCE_TABLE } }), 'the id as a label')
      await expectAllowed(presence(), 'the empty label')
    })

    test('a presence document filed under an id that is not made from its number and phase is refused', async () => {
      for (const id of [zoneTableId(1582, 0), zoneTableId(BUILT_IN_ZONE_NO, 1), `z${BUILT_IN_ZONE_NO}`, `s${BUILT_IN_ZONE_NO}_0`]) {
        await expectDenied(createTable(dbFor(who), who, { id, fields: presenceTableDoc() }), id)
      }
    })

    test('without its entry, or with an entry that tells it differently, it is refused', async () => {
      await expectDenied(presence({}, { skipEntry: true }), 'no entry')
      await expectDenied(presence({}, { audit: { after: { ...presenceTableDoc(), removed: false } } }), 'an entry that says removed: false')
      await expectDenied(presence({}, { audit: { action: 'edit' } }), 'an entry that says edit')
    })
  })

  describe(`a ${LABEL[who]} creates a creature`, () => {
    test('a creature of a custom zone is stored and logged, with the items it drops', async () => {
      await expectAllowed(source())
      const saved = await stored(`lootTables/${SOURCE_TABLE}`)
      assert.deepEqual(saved?.itemIds, [1111, 2222])
      assert.equal(saved?.updatedBy, UID[who])
      assert.equal(saved?.phaseNo, 0)
      const logged = await stored(`auditLog/${entryId('table', SOURCE_TABLE, 1)}`)
      assert.equal(logged?.item, 'Test Boss')
      assert.deepEqual(logged?.after?.itemIds, [1111, 2222])
      assert.equal(logged?.after?.key, 'c1')
    })

    test('what a phase adds to or takes off a creature of the captures is accepted, with no name and no number', async () => {
      await expectAllowed(make(overlayTableDoc()))
      const saved = await stored(`lootTables/${BUILT_IN_SOURCE_TABLE}`)
      assert.deepEqual(saved?.itemIds, [3333])
      assert.deepEqual(saved?.hiddenItemIds, [4444])
      assert.equal(saved?.name, undefined)
      assert.equal((await stored(`auditLog/${entryId('table', BUILT_IN_SOURCE_TABLE, 1)}`))?.item, '', 'no name, so an empty label')
    })

    test('a creature says only what it sets: every optional field can be left out or given, alone or together', async () => {
      const bare = { name: undefined, kind: undefined, order: undefined }
      const variants: [string, DocumentData][] = [
        ['nothing but its lists', bare],
        ['a name alone', { ...bare, name: 'Test Boss' }],
        ['a kind alone', { ...bare, kind: 'rare' }],
        ['an order alone', { ...bare, order: 0 }],
        ['a creature number alone', { ...bare, npcId: 4887 }],
        ['removed: true alone', { ...bare, removed: true }],
        ['removed: false alone', { ...bare, removed: false }],
        ['empty lists', { ...bare, itemIds: [], hiddenItemIds: [] }],
        ['every field', { npcId: 4887, removed: false }],
      ]
      for (const [index, [label, overrides]] of variants.entries()) await expectAllowed(source({ key: `v${index}`, ...overrides }), label)
    })

    test('the zone-wide list and every kind of creature are accepted', async () => {
      for (const kind of KINDS_OF_SOURCE) await expectAllowed(source({ key: kind === 'zonewide' ? 'zonewide' : `k${kind}`, kind }), kind)
    })

    test('the creature of a built-in zone can carry the number the game gives it, and a custom creature may add one', async () => {
      await expectAllowed(make(overlayTableDoc({ npcId: 4887 })))
      await expectAllowed(source({ npcId: 100_000_000 }))
    })

    test('the longest allowed values are accepted', async () => {
      const key = 'k'.repeat(30)
      await expectAllowed(source({ zoneId: 100_000_000, key, name: 'x'.repeat(100), npcId: 100_000_000, order: 100_000, itemIds: ids(80), hiddenItemIds: ids(80, 5000), removed: true }))
      await expectAllowed(source({ key: 'k0', order: 0, npcId: 1, itemIds: [], hiddenItemIds: [] }), 'the smallest')
    })

    test('a creature without its entry, or with an entry that tells it differently, is refused', async () => {
      await expectDenied(source({}, { skipEntry: true }), 'no entry')
      await expectDenied(source({}, { entryKey: entryId('table', 'sx', 1) }), 'an entry for another document')
      await expectDenied(source({}, { audit: { action: 'edit' } }), 'an entry that says edit')
      await expectDenied(source({}, { audit: { after: { ...sourceTableDoc(), itemIds: [9] } } }), 'an entry that lists other items')
      await expectDenied(source({}, { audit: { changed: ['name'], before: { name: null }, after: { name: 'Test Boss' } } }), 'an entry that leaves fields out')
      await expectDenied(source({}, { audit: { changed: [...Object.keys(sourceTableDoc()), 'players'], after: { ...sourceTableDoc(), players: 5 } } }), 'an entry that lists a field the document does not have')
    })

    for (const field of ['type', 'zoneId', 'key', 'phaseNo', 'itemIds', 'hiddenItemIds']) {
      test(`a creature with no ${field} is refused`, async () => {
        await expectDenied(createTable(dbFor(who), who, { id: SOURCE_TABLE, fields: without(sourceTableDoc(), field) }))
      })
    }
    for (const field of ['rev', 'updatedBy', 'updatedAt']) {
      test(`a creature with no ${field} is refused`, async () => {
        await expectDenied(source({}, { table: { [field]: undefined } }))
      })
    }

    const bad: [string, DocumentData][] = [
      ['an unknown field', { extra: 'anything' }],
      ['a zone field (players)', { players: 5 }],
      ['an empty name', { name: '' }],
      ['a name of spaces', { name: '   ' }],
      ['a name of a tab and a line break', { name: '\t\n' }],
      ['a name over 100 characters', { name: 'x'.repeat(101) }],
      ['a name of 100 characters and a space in front, which is over 100 characters long', { name: ` ${'x'.repeat(100)}` }],
      ['a name that is not text', { name: ['Test Boss'] }],
      ['a name of null', { name: null }],
      ['a kind the list does not have', { kind: 'dragon' }],
      ['a zone kind (dungeon)', { kind: 'dungeon' }],
      ['a zone kind (raid)', { kind: 'raid' }],
      ['a kind spelled with a capital', { kind: 'Boss' }],
      ['a kind that is not text', { kind: 1 }],
      ['a kind of null', { kind: null }],
      ['a creature number of 0', { npcId: 0 }],
      ['a creature number of -1', { npcId: -1 }],
      ['a creature number of 1.5', { npcId: 1.5 }],
      ['a creature number that is text', { npcId: '4887' }],
      ['a creature number of null', { npcId: null }],
      ['a creature number over 100 million', { npcId: 100_000_001 }],
      ['an order below 0', { order: -1 }],
      ['an order over 100000', { order: 100_001 }],
      ['an order of 1.5', { order: 1.5 }],
      ['an order that is text', { order: '10' }],
      ['an order of null', { order: null }],
      ['81 items', { itemIds: ids(81) }],
      ['items that are text, not a list', { itemIds: '1111,2222' }],
      ['items that are a map, which has a size too', { itemIds: { a: 1 } }],
      ['items of null', { itemIds: null }],
      ['items that are one number', { itemIds: 5 }],
      ['81 hidden items', { hiddenItemIds: ids(81) }],
      ['hidden items that are not a list', { hiddenItemIds: 5 }],
      ['hidden items that are text, which has a size too', { hiddenItemIds: 'abc' }],
      ['hidden items that are a map, which has a size too', { hiddenItemIds: { a: 1 } }],
      ['hidden items of null', { hiddenItemIds: null }],
      ['a zone number of 0', { zoneId: 0 }],
      ['a zone number of 1.5', { zoneId: 1.5 }],
      ['a zone number that is text', { zoneId: '60000001' }],
      ['a zone number over 100 million', { zoneId: 100_000_001 }],
      ['a type that is neither zone nor source', { type: 'creature' }],
      ['removed as text', { removed: 'true' }],
      ['removed as a number', { removed: 1 }],
      ['removed as null', { removed: null }],
      ['removed as a list', { removed: [true] }],
    ]
    for (const [label, overrides] of bad) {
      test(`a creature with ${label} is refused`, async () => {
        await expectDenied(source(overrides))
      })
    }
    for (const [label, table] of stamps) {
      test(`a creature with ${label} is refused`, async () => {
        await expectDenied(source({}, { table }))
      })
    }

    test('a key with a symbol, a space, a non-ASCII letter or over 30 characters is refused even under the id that matches it', async () => {
      for (const key of ['a_b', 'a-b', 'a b', 'k'.repeat(31), '\u00fcber', 'a.b', '']) {
        await expectDenied(createTable(dbFor(who), who, { id: sourceTableId(ZONE_NO, key, 0), fields: sourceTableDoc({ key }) }), JSON.stringify(key))
      }
      await expectDenied(source({ key: 7 }), 'a key that is not text')
      await expectDenied(source({ key: null }), 'a key of null')
      await expectDenied(source({ key: ['c1'] }), 'a key that is a list')
      await expectAllowed(source({ key: 'K9z' }), 'letters and digits')
    })

    test('a creature filed under an id that is not made from its zone, key and phase is refused', async () => {
      for (const id of [`s${ZONE_NO}_c2_0`, 's60000002_c1_0', sourceTableId(ZONE_NO, 'c1', 1), `s${ZONE_NO}_c1`, `s${ZONE_NO}_c1_00`, `S${ZONE_NO}_c1_0`, `z${ZONE_NO}_0`, zoneTableId(ZONE_NO, 'c1_0')]) {
        await expectDenied(createTable(dbFor(who), who, { id, fields: sourceTableDoc() }), id)
      }
      await expectDenied(createTable(dbFor(who), who, { id: SOURCE_TABLE, fields: zoneTableDoc() }), 'a zone under the id of a creature')
      await expectAllowed(source(), 'the id its fields make')
    })

    test('the key and the kind agree: only the zone-wide list has the kind zonewide, and the zone-wide list has no other kind', async () => {
      await expectAllowed(source({ key: 'zonewide', kind: 'zonewide' }), 'zonewide and zonewide')
      await expectAllowed(source({ zoneId: 60_000_002, key: 'zonewide', kind: undefined }), 'the zone-wide key with no kind')
      for (const kind of ['boss', 'rare', 'trash']) {
        await expectDenied(source({ key: 'zonewide', kind }), `the zone-wide key with kind ${kind}`)
        await expectAllowed(source({ key: `k${kind}`, kind }), `a creature of kind ${kind}`)
      }
      await expectDenied(source({ key: 'c1', kind: 'zonewide' }), 'a creature with the kind zonewide')
      await expectDenied(source({ key: NPC_KEY, kind: 'zonewide' }), 'a capture creature with the kind zonewide')
      await expectDenied(source({ key: 'zonewide2', kind: 'zonewide' }), 'a key that only starts with zonewide')
      await expectDenied(source({ key: 'Zonewide', kind: 'zonewide' }), 'a key that differs in case')
      await expectAllowed(source({ key: 'zonewide2', kind: 'boss' }), 'a creature whose key only starts with zonewide')
    })

    test('a creature of the captures and the zone-wide list can never be removed, though removed: false is harmless', async () => {
      for (const key of ['npc1', NPC_KEY, 'npc0042', `npc${'9'.repeat(27)}`, 'zonewide']) {
        await expectDenied(source({ key, kind: undefined, removed: true }), `${key} removed`)
        await expectAllowed(source({ key, kind: undefined, removed: false }), `${key} not removed`)
      }
    })

    test('a creature the guild added can be removed, and so can one whose key only looks like a capture creature', async () => {
      for (const key of ['c1', 'npc', 'npcx', 'npc12x', 'xnpc12', 'Npc12', 'zonewide1', 'npc1npc']) await expectAllowed(source({ key, kind: undefined, removed: true }), `${key} removed`)
    })

    test('the items it adds and the items it takes off cannot share an item', async () => {
      const disjoint: [number[], number[]][] = [[[1, 2], [3, 4]], [[1], []], [[], [1]], [[], []], [[1, 1, 2], [3]], [ids(80), ids(80, 5000)]]
      for (const [index, [itemIds, hiddenItemIds]] of disjoint.entries()) await expectAllowed(source({ key: `d${index}`, itemIds, hiddenItemIds }), `disjoint ${index}`)
      const shared: [number[], number[]][] = [[[1, 2], [2, 3]], [[1], [1]], [[1, 2, 3], [4, 5, 3]], [[7, 8], [7]], [ids(80), [...ids(79, 5000), 1079]], [[...ids(79), 5000], [5000, ...ids(79, 6000)]]]
      for (const [index, [itemIds, hiddenItemIds]] of shared.entries()) await expectDenied(source({ key: `s${index}`, itemIds, hiddenItemIds }), `overlapping ${index}`)
    })

    test('the zone-wide list and the captures\' creatures are subject to the overlap rule too', async () => {
      await expectDenied(source({ key: 'zonewide', kind: 'zonewide', itemIds: [5], hiddenItemIds: [5] }), 'the zone-wide list')
      await expectDenied(make(overlayTableDoc({ itemIds: [3333], hiddenItemIds: [3333] })), 'a capture creature')
    })
  })

  // The current phase is the number of finished phases in the settings (none stored means phase 0). A table document is filed under the current
  // phase, or the next one, which leaders prepare ahead of time. The next phase of the 30th finished phase is 31 (more than validPhaseNo allows).
  describe(`the loot phase of a table a ${LABEL[who]} creates`, () => {
    const kinds: [string, (phaseNo: unknown) => DocumentData][] = [
      ['a zone of the guild\'s own', (phaseNo) => zoneTableDoc({ phaseNo })],
      ['a built-in zone', (phaseNo) => presenceTableDoc({ phaseNo })],
      ['a creature', (phaseNo) => sourceTableDoc({ phaseNo })],
      ['a change to a creature of the captures', (phaseNo) => overlayTableDoc({ phaseNo })],
    ]
    /** What the rules say to a document of each kind for each phase: one outcome per phase and kind, each under the id its fields make. */
    const outcomes = async (phases: unknown[]) => Object.fromEntries(await Promise.all(kinds.map(async ([label, fields]) => {
      const result: Record<string, string> = {}
      for (const phaseNo of phases) result[JSON.stringify(phaseNo)] = await outcomeOf(make(fields(phaseNo)))
      return [label, result] as const
    })))
    const expected = (phases: unknown[], allowed: unknown[]) => Object.fromEntries(kinds.map(([label]) => [label, Object.fromEntries(phases.map((phaseNo) => [JSON.stringify(phaseNo), allowed.includes(phaseNo) ? 'allowed' : 'denied']))]))

    test('with no settings stored, phase 0 and phase 1 are accepted and the rest is refused', async () => {
      const phases = [0, 1, 2, 3, 30, 31, -1]
      assert.deepEqual(await outcomes(phases), expected(phases, [0, 1]))
    })

    test('with two finished phases, phase 2 (current) and phase 3 (next) are accepted, an earlier phase and a later one are refused', async () => {
      await inPhase(2)
      const phases = [0, 1, 2, 3, 4, 5, 30, 31]
      assert.deepEqual(await outcomes(phases), expected(phases, [2, 3]))
    })

    test('with the most finished phases a guild can have (30), phase 30 and phase 31 are accepted', async () => {
      await inPhase(30)
      const phases = [0, 29, 30, 31, 32, 33]
      assert.deepEqual(await outcomes(phases), expected(phases, [30, 31]))
    })

    test('a phase that is not a whole number is refused: text, null, a fraction, a list, a map, true, and a whole-number double', async () => {
      await inPhase(2)
      for (const phaseNo of ['2', null, 2.5, [2], { a: 2 }, true, '', 'two']) {
        for (const [label, fields] of kinds) {
          await expectDenied(make(fields(phaseNo)), `${label}: phase ${JSON.stringify(phaseNo)} under the id its fields make`)
          await expectDenied(make(fields(phaseNo), { id: tableIdOf(fields(2)) }), `${label}: phase ${JSON.stringify(phaseNo)} under the id of phase 2`)
        }
      }
    })

    test('a phase number sent as a double with a whole value is refused (the SDK sends integers, so this takes a hand-built request)', async () => {
      const staff = UID[who]
      const create = (phaseNo: unknown, id: string) => {
        const fields = zoneTableDoc({ phaseNo })
        const nulls = Object.fromEntries(Object.keys(fields).map((key) => [key, null]))
        return rawCommit(staff, [
          { path: `lootTables/${id}`, fields: { ...fields, rev: 1, updatedBy: staff, updatedAt: requestTime } },
          { path: `auditLog/${entryId('table', id, 1)}`, fields: entry(who, 'table', id, 1, { at: requestTime, action: 'create', item: 'Test Hollow', changed: Object.keys(fields), before: nulls, after: fields }) },
        ])
      }
      assert.equal(await create(asDouble(0), zoneTableId(ZONE_NO, '0.0')), 'denied', 'phase 0.0 under the id with .0')
      assert.equal(await create(asDouble(0), ZONE_TABLE), 'denied', 'phase 0.0 under the plain id')
      assert.equal(await create(0, ZONE_TABLE), 'allowed', 'phase 0 (control: the same request with an integer)')
    })

    // The SDK sends whole numbers as integers, so a double with a whole value takes a hand-built request (support/raw.ts). `is int` is what refuses it.
    test('a whole-number double is refused wherever a whole number is wanted: revision, zone number, size, order, creature number', async () => {
      const staff = UID[who]
      const send = (id: string, fields: DocumentData) => {
        const nulls = Object.fromEntries(Object.keys(fields).map((key) => [key, null]))
        return rawCommit(staff, [
          { path: `lootTables/${id}`, fields: { rev: 1, ...fields, updatedBy: staff, updatedAt: requestTime } },
          { path: `auditLog/${entryId('table', id, 1)}`, fields: entry(who, 'table', id, 1, { at: requestTime, action: 'create', item: '', changed: Object.keys(fields).filter((key) => key !== 'rev'), before: Object.fromEntries(Object.entries(nulls).filter(([key]) => key !== 'rev')), after: Object.fromEntries(Object.entries(fields).filter(([key]) => key !== 'rev')) }) },
        ])
      }
      const zoneFields = (overrides: DocumentData) => without(zoneTableDoc({ name: undefined, kind: undefined, players: undefined, ...overrides }), 'name', 'kind', 'players')
      assert.equal(await send(ZONE_TABLE, zoneFields({ rev: asDouble(1) })), 'denied', 'revision 1.0')
      assert.equal(await send(zoneTableId(asDouble(60_000_001).$double, 0), zoneFields({ zoneId: asDouble(60_000_001) })), 'denied', 'zone number 60000001.0')
      assert.equal(await send(ZONE_TABLE, { ...zoneFields({}), players: asDouble(5) }), 'denied', 'size 5.0')
      const creature = (overrides: DocumentData) => without(sourceTableDoc({ name: undefined, kind: undefined, ...overrides }), 'name', 'kind')
      assert.equal(await send(SOURCE_TABLE, creature({ order: asDouble(10) })), 'denied', 'order 10.0')
      assert.equal(await send(SOURCE_TABLE, creature({ npcId: asDouble(4887) })), 'denied', 'creature number 4887.0')
      assert.equal(await send(SOURCE_TABLE, creature({})), 'allowed', 'a creature with whole numbers (control: the same request with integers)')
    })

    test('the number a document carries has to be the number in its id', async () => {
      await expectDenied(createTable(dbFor(who), who, { id: zoneTableId(ZONE_NO, 0), fields: zoneTableDoc({ phaseNo: 1 }) }), 'phase 1 filed under phase 0')
      await expectDenied(createTable(dbFor(who), who, { id: zoneTableId(ZONE_NO, 1), fields: zoneTableDoc({ phaseNo: 0 }) }), 'phase 0 filed under phase 1')
      await expectDenied(createTable(dbFor(who), who, { id: sourceTableId(ZONE_NO, 'c1', 1), fields: sourceTableDoc({ phaseNo: 0 }) }), 'a creature of phase 0 filed under phase 1')
    })

    test('the same zone and creature can have a document in each of the two phases that can be written', async () => {
      await expectAllowed(zone({ phaseNo: 0 }))
      await expectAllowed(zone({ phaseNo: 1, name: 'Renamed Hollow' }))
      await expectAllowed(source({ phaseNo: 0 }))
      await expectAllowed(source({ phaseNo: 1, name: undefined, kind: undefined, order: undefined, itemIds: [], hiddenItemIds: [1111] }))
    })
  })
}

for (const who of RAID_STAFF as readonly Staff[]) {
  const edit = (changes: DocumentData, extra: EditTableOptions = {}) => editTable(dbFor(who), who, { changes, ...extra })
  const editOf = (id: string, changes: DocumentData, extra: EditTableOptions = {}) => editTable(dbFor(who), who, { id, changes, ...extra })
  const stamps: [string, DocumentData][] = [
    ['no revision', { rev: undefined }],
    ['a revision that is text', { rev: '2' }],
    ['a revision of 2.5', { rev: 2.5 }],
    ['no updater', { updatedBy: undefined }],
    ['someone else as the updater', { updatedBy: UID[who === 'guildLeader' ? 'raidLeader' : 'guildLeader'] }],
    ['no update time', { updatedAt: undefined }],
    ['an update time from the client', { updatedAt: new Date('2026-01-01T00:00:00Z') }],
    ['a createdBy, which only awards have', { createdBy: UID[who] }],
    ['a createdAt, which only awards have', { createdAt: serverTimestamp() }],
  ]

  describe(`a ${LABEL[who]} changes a creature`, () => {
    test('adding items is one step of its revision, keeps the rest, and is in the log with the old and new lists', async () => {
      await storeTable(SOURCE_TABLE, sourceTableDoc())
      await expectAllowed(edit({ itemIds: [1111, 2222, 3333] }))
      const saved = await stored(`lootTables/${SOURCE_TABLE}`)
      assert.equal(saved?.rev, 2)
      assert.equal(saved?.updatedBy, UID[who])
      assert.deepEqual(saved?.itemIds, [1111, 2222, 3333])
      assert.equal(saved?.name, 'Test Boss')
      assert.equal(saved?.phaseNo, 0)
      const logged = await stored(`auditLog/${entryId('table', SOURCE_TABLE, 2)}`)
      assert.deepEqual(logged?.changed, ['itemIds'])
      assert.deepEqual(logged?.before, { itemIds: [1111, 2222] })
      assert.deepEqual(logged?.after, { itemIds: [1111, 2222, 3333] })
      assert.equal(logged?.item, 'Test Boss')
      assert.equal(logged?.action, 'edit')
    })

    test('taking an item off, putting it back and emptying both lists are accepted', async () => {
      await storeTable(SOURCE_TABLE, sourceTableDoc({ itemIds: [1, 2, 3], hiddenItemIds: [] }))
      await expectAllowed(edit({ itemIds: [1, 3], hiddenItemIds: [2] }), 'taking item 2 off')
      await expectAllowed(edit({ itemIds: [1, 3, 2], hiddenItemIds: [] }), 'putting it back')
      await expectAllowed(edit({ itemIds: [], hiddenItemIds: [] }), 'both lists empty')
    })

    test('every field can be changed in one edit, and the entry lists them all', async () => {
      await storeTable(SOURCE_TABLE, sourceTableDoc({ npcId: 4887, removed: false }))
      const changes = { name: 'Renamed Boss', kind: 'rare', npcId: 4888, order: 30, itemIds: [7], hiddenItemIds: [8], removed: true }
      await expectAllowed(edit(changes))
      const logged = await stored(`auditLog/${entryId('table', SOURCE_TABLE, 2)}`)
      assert.deepEqual(((logged?.changed ?? []) as string[]).slice().sort(), Object.keys(changes).sort())
      assert.equal(logged?.item, 'Test Boss', 'the label is the name before the change')
      assert.equal(logged?.before?.removed, false)
      assert.equal(logged?.after?.removed, true)
    })

    test('the entry label is the name before the change', async () => {
      await storeTable(SOURCE_TABLE, sourceTableDoc())
      await expectDenied(edit({ name: 'Renamed Boss' }, { audit: { item: 'Renamed Boss' } }), 'the new name')
      await expectDenied(edit({ name: 'Renamed Boss' }, { audit: { item: '' } }), 'an empty label though the document had a name')
      await expectAllowed(edit({ name: 'Renamed Boss' }), 'the old name')
    })

    test('a document with no name has an empty label, whatever the edit gives it', async () => {
      await storeTable(BUILT_IN_SOURCE_TABLE, overlayTableDoc())
      await expectDenied(editOf(BUILT_IN_SOURCE_TABLE, { name: 'Named Now' }, { audit: { item: 'Named Now' } }), 'the name it gets')
      await expectDenied(editOf(BUILT_IN_SOURCE_TABLE, { itemIds: [3333, 5555] }, { audit: { item: 'Test Boss' } }), 'a label it never had')
      await expectAllowed(editOf(BUILT_IN_SOURCE_TABLE, { name: 'Named Now' }), 'an empty label for the edit that names it')
      await expectAllowed(editOf(BUILT_IN_SOURCE_TABLE, { itemIds: [3333, 5555] }), 'and the name it has now for the next edit')
      assert.equal((await stored(`auditLog/${entryId('table', BUILT_IN_SOURCE_TABLE, 3)}`))?.item, 'Named Now')
    })

    test('a field can be added or taken away: name, kind, order, creature number and removed', async () => {
      const fields: [string, unknown][] = [['name', 'Named Now'], ['kind', 'rare'], ['order', 5], ['npcId', 4887], ['removed', true]]
      for (const [index, [field, value]] of fields.entries()) {
        const key = `a${index}`
        const id = sourceTableId(ZONE_NO, key, 0)
        await storeTable(id, overlayTableDoc({ zoneId: ZONE_NO, key }))
        await expectAllowed(editOf(id, { [field]: value }), `${field} added`)
        await expectAllowed(editOf(id, { [field]: GONE }), `${field} taken away`)
        assert.equal((await stored(`lootTables/${id}`))?.[field], undefined)
        assert.deepEqual((await stored(`auditLog/${entryId('table', id, 3)}`))?.after, { [field]: null })
      }
    })

    test('one edit can name a creature document that has no name, with its kind, number, order and items, and put it back (the drop list import does)', async () => {
      // A leader changed the creature's items while this phase followed another, and the link was then taken away: the document names nothing.
      const id = sourceTableId(ZONE_NO, 'n4887', 0)
      await storeTable(id, { type: 'source', zoneId: ZONE_NO, key: 'n4887', phaseNo: 0, itemIds: [1111], hiddenItemIds: [2222], removed: true })
      await expectAllowed(editOf(id, { name: 'Test Boss', kind: 'boss', npcId: 4887, order: 10, removed: false, itemIds: [1111, 3333] }))
      const saved = await stored(`lootTables/${id}`)
      assert.deepEqual([saved?.name, saved?.kind, saved?.npcId, saved?.order, saved?.removed, saved?.itemIds, saved?.hiddenItemIds, saved?.rev], ['Test Boss', 'boss', 4887, 10, false, [1111, 3333], [2222], 2])
      const logged = await stored(`auditLog/${entryId('table', id, 2)}`)
      assert.equal(logged?.item, '', 'the label is the name before the edit: none')
      assert.deepEqual(((logged?.changed ?? []) as string[]).slice().sort(), ['itemIds', 'kind', 'name', 'npcId', 'order', 'removed'])
    })

    test('a creature can be taken out of the lists and brought back, with the items it has', async () => {
      await storeTable(SOURCE_TABLE, sourceTableDoc())
      await expectAllowed(edit({ removed: true }), 'out')
      assert.equal((await stored(`lootTables/${SOURCE_TABLE}`))?.removed, true)
      assert.deepEqual((await stored(`lootTables/${SOURCE_TABLE}`))?.itemIds, [1111, 2222])
      await expectAllowed(edit({ removed: false }), 'back in')
      await expectAllowed(edit({ removed: true }), 'out again')
      await expectAllowed(edit({ removed: GONE }), 'follow the earlier phase again')
      assert.equal((await stored(`lootTables/${SOURCE_TABLE}`))?.removed, undefined)
    })

    test('removed has to stay true or false', async () => {
      await storeTable(SOURCE_TABLE, sourceTableDoc())
      for (const removed of ['true', 1, null, ['x'], { a: 1 }, '']) await expectDenied(edit({ removed }), JSON.stringify(removed))
    })

    test('the revision has to go up by exactly one, and the entry has to be the one of that revision', async () => {
      await storeTable(SOURCE_TABLE, sourceTableDoc())
      await expectDenied(edit({ itemIds: [1] }, { rev: 1 }), 'the same revision')
      await expectDenied(edit({ itemIds: [1] }, { rev: 3 }), 'two steps')
      await expectDenied(edit({ itemIds: [1] }, { table: { rev: 2.5 }, entryKey: entryId('table', SOURCE_TABLE, 2) }), 'a revision that is not whole')
      await expectDenied(edit({ itemIds: [1] }, { entryKey: entryId('table', SOURCE_TABLE, 3), audit: { rev: 3 } }), 'the entry of a later revision')
      await expectDenied(edit({ itemIds: [1] }, { audit: { rev: 3 } }), 'an entry that says another revision')
      await expectDenied(edit({ itemIds: [1] }, { skipEntry: true }), 'no entry')
      await expectAllowed(edit({ itemIds: [1] }), 'the honest edit')
      await expectDenied(edit({ itemIds: [2] }, { rev: 2 }), 'the same revision again')
      await expectAllowed(edit({ itemIds: [2] }), 'the next step')
    })

    for (const [label, table] of stamps) {
      test(`an edit with ${label} is refused`, async () => {
        await storeTable(SOURCE_TABLE, sourceTableDoc())
        await expectDenied(edit({ itemIds: [1] }, { table }))
      })
    }

    test('a revision sent as a whole-number double is refused on an edit, and the same request with an integer is accepted', async () => {
      await storeTable(SOURCE_TABLE, sourceTableDoc())
      const staff = UID[who]
      const send = (rev: unknown) => rawCommit(staff, [
        { path: `lootTables/${SOURCE_TABLE}`, mask: ['order', 'rev', 'updatedBy', 'updatedAt'], fields: { order: 11, rev, updatedBy: staff, updatedAt: requestTime } },
        { path: `auditLog/${entryId('table', SOURCE_TABLE, 2)}`, fields: entry(who, 'table', SOURCE_TABLE, 2, { at: requestTime, item: 'Test Boss', changed: ['order'], before: { order: 10 }, after: { order: 11 } }) },
      ])
      assert.equal(await send(asDouble(2)), 'denied', 'revision 2.0')
      assert.equal(await send(2), 'allowed', 'revision 2')
    })

    test('what a creature is cannot change: its phase, its kind of document, its zone and its key', async () => {
      await storeTable(SOURCE_TABLE, sourceTableDoc())
      await expectDenied(edit({ phaseNo: 1 }), 'moved to the next phase')
      await expectDenied(edit({ phaseNo: GONE }), 'its phase taken away')
      await expectDenied(edit({ type: 'zone' }), 'type')
      await expectDenied(edit({ type: GONE }), 'type taken away')
      await expectDenied(edit({ zoneId: 60_000_002 }), 'zoneId')
      await expectDenied(edit({ zoneId: GONE }), 'zoneId taken away')
      await expectDenied(edit({ key: 'c2' }), 'key')
      await expectDenied(edit({ key: GONE }), 'key taken away')
      await expectAllowed(edit({ itemIds: [1] }), 'an ordinary edit of the same creature')
    })

    test('a creature cannot be turned into a zone by changing its type and taking its creature fields away', async () => {
      await storeTable(SOURCE_TABLE, sourceTableDoc({ name: undefined, kind: undefined, order: undefined }))
      await expectDenied(edit({ type: 'zone', key: GONE, itemIds: GONE, hiddenItemIds: GONE }), 'a creature that becomes a custom zone')
    })

    const bad: [string, DocumentData][] = [
      ['an unknown field', { extra: 'anything' }],
      ['a zone field (players)', { players: 5 }],
      ['an empty name', { name: '' }],
      ['a name of spaces', { name: '   ' }],
      ['a name of a tab and a line break', { name: '\t\n' }],
      ['a name over 100 characters', { name: 'x'.repeat(101) }],
      ['a name of 100 characters and a space in front, which is over 100 characters long', { name: ` ${'x'.repeat(100)}` }],
      ['a name that is not text', { name: 5 }],
      ['a name of null', { name: null }],
      ['a kind the list does not have', { kind: 'zone' }],
      ['a zone kind (dungeon)', { kind: 'dungeon' }],
      ['a kind that is not text', { kind: 3 }],
      ['a creature number of 0', { npcId: 0 }],
      ['a creature number of 1.5', { npcId: 1.5 }],
      ['a creature number that is text', { npcId: '4887' }],
      ['a creature number over 100 million', { npcId: 100_000_001 }],
      ['an order of -1', { order: -1 }],
      ['an order over 100000', { order: 100_001 }],
      ['an order that is text', { order: '5' }],
      ['81 items', { itemIds: ids(81) }],
      ['items that are not a list', { itemIds: 'all of them' }],
      ['items that are a map', { itemIds: { a: 1 } }],
      ['items of null', { itemIds: null }],
      ['hidden items that are text, which has a size too', { hiddenItemIds: 'abc' }],
      ['hidden items that are a map', { hiddenItemIds: { a: 1 } }],
      ['hidden items of null', { hiddenItemIds: null }],
      ['81 hidden items', { hiddenItemIds: ids(81) }],
      ['a createdBy', { createdBy: UID[who] }],
    ]
    for (const [label, changes] of bad) {
      test(`a creature edit with ${label} is refused`, async () => {
        await storeTable(SOURCE_TABLE, sourceTableDoc())
        await expectDenied(edit(changes))
      })
    }

    test('the lists keep their longest allowed size', async () => {
      await storeTable(SOURCE_TABLE, sourceTableDoc())
      await expectAllowed(edit({ itemIds: ids(80), hiddenItemIds: ids(80, 5000), name: 'x'.repeat(100), order: 100_000, npcId: 100_000_000 }))
    })

    test('taking a required field away is refused, and the optional ones can go', async () => {
      await storeTable(SOURCE_TABLE, sourceTableDoc({ npcId: 4887, removed: false }))
      for (const field of ['itemIds', 'hiddenItemIds', 'type', 'zoneId', 'key', 'phaseNo', 'rev', 'updatedBy', 'updatedAt']) {
        await expectDenied(edit({ [field]: GONE }, field === 'rev' || field === 'updatedBy' || field === 'updatedAt' ? { table: { [field]: undefined } } : {}), field)
      }
      await expectAllowed(edit({ name: GONE, kind: GONE, order: GONE, npcId: GONE, removed: GONE }), 'name, kind, order, npcId and removed')
      const saved = await stored(`lootTables/${SOURCE_TABLE}`)
      assert.deepEqual(Object.keys(saved ?? {}).sort(), ['hiddenItemIds', 'itemIds', 'key', 'phaseNo', 'rev', 'type', 'updatedAt', 'updatedBy', 'zoneId'])
    })

    test('a creature cannot gain a field of a zone, whatever the value', async () => {
      await storeTable(SOURCE_TABLE, sourceTableDoc())
      for (const [field, value] of Object.entries(ZONE_ONLY)) await expectDenied(edit({ [field]: value }), field)
    })

    test('a field the entry does not list is refused, and so is a createdBy or createdAt the entry has nothing to say about', async () => {
      await storeTable(SOURCE_TABLE, sourceTableDoc())
      await expectDenied(edit({ itemIds: [1], name: 'Other' }, { audit: { changed: ['itemIds'], before: { itemIds: [1111, 2222] }, after: { itemIds: [1] } } }))
      for (const extra of [{ createdBy: UID[who] }, { createdAt: serverTimestamp() }]) {
        await expectDenied(edit({}, { table: extra, audit: { changed: [], before: {}, after: {} } }), JSON.stringify(Object.keys(extra)))
      }
      await expectAllowed(edit({}, { audit: { changed: [], before: {}, after: {} } }), 'a plain stamp-only change is fine')
    })

    test('the items it adds and the items it takes off cannot share an item, whichever list the edit changes', async () => {
      await storeTable(SOURCE_TABLE, sourceTableDoc({ itemIds: [1, 2], hiddenItemIds: [3] }))
      await expectDenied(edit({ hiddenItemIds: [3, 2] }), 'hiding an item it adds')
      await expectDenied(edit({ itemIds: [1, 2, 3] }), 'adding an item it takes off')
      await expectDenied(edit({ itemIds: [5], hiddenItemIds: [5] }), 'both lists given the same item')
      await expectDenied(edit({ itemIds: [3] }), 'adding the only hidden item')
      await expectDenied(edit({ hiddenItemIds: [1] }), 'hiding the first added item')
      await expectAllowed(edit({ itemIds: [1], hiddenItemIds: [3, 2] }), 'moving an item from one list to the other')
      await expectAllowed(edit({ itemIds: [3, 2, 1], hiddenItemIds: [] }), 'and back, the other way')
    })

    test('the key and the kind keep agreeing: only the zone-wide list can be the kind zonewide', async () => {
      await storeTable(SOURCE_TABLE, sourceTableDoc())
      const wide = sourceTableId(ZONE_NO, 'zonewide', 0)
      await storeTable(wide, sourceTableDoc({ key: 'zonewide', kind: 'zonewide' }))
      await expectDenied(edit({ kind: 'zonewide' }), 'a creature made zonewide')
      await expectDenied(editOf(wide, { kind: 'boss' }), 'the zone-wide list made a boss')
      await expectDenied(editOf(wide, { kind: 'dragon' }), 'the zone-wide list given a kind that does not exist')
      await expectAllowed(editOf(wide, { kind: GONE }), 'the zone-wide list with no kind')
      await expectDenied(editOf(wide, { kind: 'rare' }, { rev: 3 }), 'and then given a creature kind')
      await expectAllowed(editOf(wide, { kind: 'zonewide' }), 'and the kind back')
      await expectAllowed(edit({ kind: 'rare' }), 'an ordinary kind for a creature')
    })

    test('a creature of the captures and the zone-wide list can never be removed, though removed: false stays harmless', async () => {
      const keys = ['npc1', NPC_KEY, 'zonewide']
      for (const key of keys) await storeTable(sourceTableId(ZONE_NO, key, 0), sourceTableDoc({ key, kind: key === 'zonewide' ? 'zonewide' : 'boss' }))
      for (const key of keys) {
        const id = sourceTableId(ZONE_NO, key, 0)
        await expectDenied(editOf(id, { removed: true }), `${key} removed`)
        await expectDenied(editOf(id, { removed: true, itemIds: [1] }), `${key} removed with another change`)
        await expectAllowed(editOf(id, { removed: false }), `${key} not removed`)
        await expectDenied(editOf(id, { removed: true }, { rev: 3 }), `${key} removed after being put back`)
        await expectAllowed(editOf(id, { removed: GONE }), `${key} with removed taken away`)
      }
    })

    test('a creature that was taken out of the lists can still be changed', async () => {
      await storeTable(SOURCE_TABLE, sourceTableDoc({ removed: true }))
      await expectAllowed(edit({ itemIds: [1] }), 'a change to a removed creature')
    })
  })

  describe(`a ${LABEL[who]} changes a zone of the guild's own`, () => {
    test('renaming, resizing and changing the kind are accepted, each alone and together, and logged', async () => {
      await storeTable(ZONE_TABLE, zoneTableDoc())
      await expectAllowed(editOf(ZONE_TABLE, { name: 'Renamed Hollow' }), 'a name')
      await expectAllowed(editOf(ZONE_TABLE, { kind: 'raid' }), 'a kind')
      await expectAllowed(editOf(ZONE_TABLE, { players: 25 }), 'a size')
      await expectAllowed(editOf(ZONE_TABLE, { name: 'Again', kind: 'dungeon', players: 10, removed: true }), 'all of them and removed')
      const saved = await stored(`lootTables/${ZONE_TABLE}`)
      assert.equal(saved?.rev, 5)
      assert.equal(saved?.name, 'Again')
      assert.equal((await stored(`auditLog/${entryId('table', ZONE_TABLE, 2)}`))?.item, 'Test Hollow')
      assert.deepEqual((await stored(`auditLog/${entryId('table', ZONE_TABLE, 5)}`))?.changed?.slice().sort(), ['kind', 'name', 'players', 'removed'])
    })

    test('it can be taken out of the lists and put back', async () => {
      await storeTable(ZONE_TABLE, zoneTableDoc())
      await expectAllowed(editOf(ZONE_TABLE, { removed: true }), 'out')
      await expectAllowed(editOf(ZONE_TABLE, { removed: false }), 'back')
      await expectAllowed(editOf(ZONE_TABLE, { removed: GONE }), 'follow the earlier phase')
    })

    test('a document that says little can gain a name, kind and size, and lose them again', async () => {
      await storeTable(ZONE_TABLE, zoneTableDoc({ name: undefined, kind: undefined, players: undefined }))
      await expectAllowed(editOf(ZONE_TABLE, { name: 'Named Now', kind: 'raid', players: 40 }), 'gained')
      assert.equal((await stored(`auditLog/${entryId('table', ZONE_TABLE, 2)}`))?.item, '', 'the label is the name it had: none')
      await expectAllowed(editOf(ZONE_TABLE, { name: GONE, kind: GONE, players: GONE }), 'lost')
      assert.deepEqual(Object.keys((await stored(`lootTables/${ZONE_TABLE}`)) ?? {}).sort(), ['phaseNo', 'rev', 'type', 'updatedAt', 'updatedBy', 'zoneId'])
    })

    const bad: [string, DocumentData][] = [
      ['an unknown field', { extra: 'anything' }],
      ['a bad kind', { kind: 'boss' }],
      ['a kind that is not text', { kind: 5 }],
      ['0 players', { players: 0 }],
      ['41 players', { players: 41 }],
      ['5.5 players', { players: 5.5 }],
      ['players as text', { players: '5' }],
      ['players of null', { players: null }],
      ['an empty name', { name: '' }],
      ['a name of spaces', { name: '  ' }],
      ['a name over 100 characters', { name: 'x'.repeat(101) }],
      ['a name of 100 characters and a space in front, which is over 100 characters long', { name: ` ${'x'.repeat(100)}` }],
      ['a name that is not text', { name: 7 }],
      ['a creature kind (boss)', { kind: 'boss' }],
      ['a creature kind (zonewide)', { kind: 'zonewide' }],
      ['removed as text', { removed: 'true' }],
      ['removed as a number', { removed: 0 }],
      ['removed as null', { removed: null }],
    ]
    for (const [label, changes] of bad) {
      test(`a zone edit with ${label} is refused`, async () => {
        await storeTable(ZONE_TABLE, zoneTableDoc())
        await expectDenied(editOf(ZONE_TABLE, changes))
      })
    }

    test('a zone cannot gain a field of a creature, whatever the value', async () => {
      await storeTable(ZONE_TABLE, zoneTableDoc())
      for (const [field, value] of Object.entries(SOURCE_ONLY)) await expectDenied(editOf(ZONE_TABLE, { [field]: value }), field)
      await expectDenied(editOf(ZONE_TABLE, { kind: 'zonewide' }), 'a creature kind')
    })

    test('what a zone is cannot change: its phase, its kind of document and its number', async () => {
      await storeTable(ZONE_TABLE, zoneTableDoc())
      await expectDenied(editOf(ZONE_TABLE, { phaseNo: 1 }), 'phase')
      await expectDenied(editOf(ZONE_TABLE, { phaseNo: GONE }), 'phase taken away')
      await expectDenied(editOf(ZONE_TABLE, { type: 'source' }), 'type')
      await expectDenied(editOf(ZONE_TABLE, { zoneId: 60_000_002 }), 'another custom number')
      await expectDenied(editOf(ZONE_TABLE, { zoneId: 100_000_000 }), 'the highest custom number')
      await expectDenied(editOf(ZONE_TABLE, { zoneId: GONE }), 'its number taken away')
    })

    test('a zone of the guild\'s own cannot be turned into a built-in zone\'s presence document, nor the other way round', async () => {
      await storeTable(ZONE_TABLE, zoneTableDoc())
      await expectDenied(editOf(ZONE_TABLE, { zoneId: BUILT_IN_ZONE_NO, name: GONE, kind: GONE, players: GONE, removed: true }), 'a custom zone becoming a presence document')
      await storeTable(PRESENCE_TABLE, presenceTableDoc())
      await expectDenied(editOf(PRESENCE_TABLE, { zoneId: 60_000_002, name: 'Test Hollow', kind: 'dungeon', players: 5 }), 'a presence document becoming a custom zone')
    })

    test('the required fields cannot be taken away', async () => {
      await storeTable(ZONE_TABLE, zoneTableDoc())
      for (const field of ['type', 'zoneId', 'phaseNo']) await expectDenied(editOf(ZONE_TABLE, { [field]: GONE }), field)
      for (const field of ['rev', 'updatedBy', 'updatedAt']) await expectDenied(editOf(ZONE_TABLE, { [field]: GONE }, { table: { [field]: undefined } }), field)
    })

    test('the revision goes up by one and the stamps are checked', async () => {
      await storeTable(ZONE_TABLE, zoneTableDoc())
      for (const [label, table] of stamps) await expectDenied(editOf(ZONE_TABLE, { players: 6 }, { table }), label)
      await expectDenied(editOf(ZONE_TABLE, { players: 6 }, { rev: 1 }), 'the same revision')
      await expectDenied(editOf(ZONE_TABLE, { players: 6 }, { rev: 3 }), 'two steps')
      await expectAllowed(editOf(ZONE_TABLE, { players: 6 }), 'the honest edit')
    })
  })

  describe(`a ${LABEL[who]} changes the presence of a zone of the built-in captures`, () => {
    test('out and back, with an empty label, and the document can end up saying nothing', async () => {
      await storeTable(PRESENCE_TABLE, presenceTableDoc())
      await expectAllowed(editOf(PRESENCE_TABLE, { removed: false }), 'back in')
      assert.equal((await stored(`auditLog/${entryId('table', PRESENCE_TABLE, 2)}`))?.item, '')
      await expectAllowed(editOf(PRESENCE_TABLE, { removed: true }), 'out again')
      await expectAllowed(editOf(PRESENCE_TABLE, { removed: GONE }), 'follow the earlier phase: the document says nothing')
      assert.equal((await stored(`lootTables/${PRESENCE_TABLE}`))?.removed, undefined)
      await expectAllowed(editOf(PRESENCE_TABLE, { removed: true }), 'and it can say something again')
      assert.equal((await stored(`lootTables/${PRESENCE_TABLE}`))?.rev, 5)
    })

    test('nothing else can be added to it', async () => {
      await storeTable(PRESENCE_TABLE, presenceTableDoc())
      for (const [field, value] of Object.entries(PRESENCE_FOREIGN)) await expectDenied(editOf(PRESENCE_TABLE, { [field]: value }), field)
      await expectDenied(editOf(PRESENCE_TABLE, { extra: 'anything' }), 'an unknown field')
      await expectDenied(editOf(PRESENCE_TABLE, { kind: 'zonewide' }), 'a creature kind')
    })

    test('removed has to stay true or false', async () => {
      await storeTable(PRESENCE_TABLE, presenceTableDoc())
      for (const removed of ['true', 0, 1, null, [true], { a: true }, '']) await expectDenied(editOf(PRESENCE_TABLE, { removed }), JSON.stringify(removed))
    })

    test('what it is cannot change: its phase, its kind of document and its number', async () => {
      await storeTable(PRESENCE_TABLE, presenceTableDoc())
      await expectDenied(editOf(PRESENCE_TABLE, { phaseNo: 1 }), 'phase')
      await expectDenied(editOf(PRESENCE_TABLE, { type: 'source' }), 'type')
      await expectDenied(editOf(PRESENCE_TABLE, { zoneId: 1582 }), 'another built-in number')
      await expectDenied(editOf(PRESENCE_TABLE, { zoneId: 1 }), 'the lowest built-in number')
      await expectDenied(editOf(PRESENCE_TABLE, { zoneId: GONE }), 'its number taken away')
      await expectDenied(editOf(PRESENCE_TABLE, { phaseNo: GONE }), 'its phase taken away')
      await expectDenied(editOf(PRESENCE_TABLE, { type: GONE }), 'its type taken away')
      for (const field of ['rev', 'updatedBy', 'updatedAt']) await expectDenied(editOf(PRESENCE_TABLE, { removed: false }, { table: { [field]: undefined } }), `${field} left out`)
      await expectAllowed(editOf(PRESENCE_TABLE, { removed: false }), 'an ordinary edit of the same document')
    })

    test('the revision goes up by one and the stamps are checked', async () => {
      await storeTable(PRESENCE_TABLE, presenceTableDoc())
      for (const [label, table] of stamps) await expectDenied(editOf(PRESENCE_TABLE, { removed: false }, { table }), label)
      await expectDenied(editOf(PRESENCE_TABLE, { removed: false }, { rev: 3 }), 'two steps')
      await expectAllowed(editOf(PRESENCE_TABLE, { removed: false }), 'the honest edit')
    })
  })

  // A finished phase is a record. The current phase and the next one can be written; a phase two ahead cannot be written (it can be stored: reopening
  // a phase leaves documents ahead).
  describe(`a ${LABEL[who]} and a table document of another phase`, () => {
    const kinds: [string, (phaseNo: number) => DocumentData, DocumentData][] = [
      ['a zone of the guild\'s own', (phaseNo) => zoneTableDoc({ phaseNo }), { players: 6 }],
      ['a built-in zone', (phaseNo) => presenceTableDoc({ phaseNo }), { removed: false }],
      ['a creature', (phaseNo) => sourceTableDoc({ phaseNo }), { order: 11 }],
      ['a change to a creature of the captures', (phaseNo) => overlayTableDoc({ phaseNo }), { itemIds: [3333, 5555] }],
    ]
    /** Every kind of document stored under each phase, then edited: one outcome per kind and phase. */
    const attempt = async (phases: number[]) => {
      const result: Record<string, Record<number, string>> = {}
      for (const [label, fields, changes] of kinds) {
        result[label] = {}
        for (const phaseNo of phases) {
          const stored = fields(phaseNo)
          const id = tableIdOf(stored)
          await storeTable(id, stored)
          result[label][phaseNo] = await outcomeOf(editOf(id, changes))
        }
      }
      return result
    }
    const expected = (phases: number[], allowed: number[]) => Object.fromEntries(kinds.map(([label]) => [label, Object.fromEntries(phases.map((phaseNo) => [phaseNo, allowed.includes(phaseNo) ? 'allowed' : 'denied']))]))

    test('with no settings stored, a document of phase 0 or phase 1 can be edited and one of phase 2 or later cannot', async () => {
      const phases = [0, 1, 2, 3, 31]
      assert.deepEqual(await attempt(phases), expected(phases, [0, 1]))
    })

    test('in the current phase and the next one a document can be edited, in a finished phase or two ahead it cannot', async () => {
      await inPhase(2)
      const phases = [0, 1, 2, 3, 4, 5, 30]
      assert.deepEqual(await attempt(phases), expected(phases, [2, 3]))
    })

    test('with the most finished phases a guild can have (30), phases 30 and 31 can be edited', async () => {
      await inPhase(30)
      const phases = [0, 29, 30, 31, 32]
      assert.deepEqual(await attempt(phases), expected(phases, [30, 31]))
    })

    test('starting a phase closes the documents that were current, and opens the ones prepared for the next', async () => {
      await storeTable(SOURCE_TABLE, sourceTableDoc())
      const prepared = sourceTableId(ZONE_NO, 'c1', 1)
      await storeTable(prepared, sourceTableDoc({ phaseNo: 1 }))
      await expectAllowed(edit({ order: 11 }), 'a current document, before')
      await expectAllowed(editOf(prepared, { order: 11 }), 'a prepared document, before')
      await inPhase(1)
      await expectDenied(edit({ order: 12 }), 'the document of the phase that closed')
      await expectAllowed(editOf(prepared, { order: 12 }), 'the prepared document, now current')
      await inPhase(2)
      await expectDenied(editOf(prepared, { order: 13 }), 'and closed in its turn')
    })

    test('a document two phases ahead, which reopening a phase can leave behind, cannot be edited until its phase is next', async () => {
      const ahead = sourceTableId(ZONE_NO, 'c1', 3)
      await storeTable(ahead, sourceTableDoc({ phaseNo: 3 }))
      await inPhase(1)
      await expectDenied(editOf(ahead, { order: 11 }), 'two phases ahead')
      await inPhase(2)
      await expectAllowed(editOf(ahead, { order: 11 }), 'now the next phase')
    })
  })

  // The entry has to say exactly what the batch does to the document: the fields that differ, with their old and new values.
  describe(`the entry of a table a ${LABEL[who]} writes tells the truth`, () => {
    const full: [string, DocumentData][] = [
      ['a zone of the guild\'s own', zoneTableDoc({ removed: false })],
      ['a built-in zone', presenceTableDoc()],
      ['a creature', sourceTableDoc({ npcId: 4887, removed: false })],
      ['a change to a creature of the captures', overlayTableDoc({ npcId: 4887, name: 'Named Now', kind: 'boss', order: 10, removed: false })],
    ]

    test('a new document\'s entry cannot give another value for any field, leave one out, list one it does not have, or claim an old value', async () => {
      for (const [label, fields] of full) {
        const keys = Object.keys(fields)
        for (const field of keys) {
          await expectDenied(createTable(dbFor(who), who, { fields, audit: { after: { ...fields, [field]: other(fields[field]) } } }), `${label}: ${field} misreported`)
          const rest = keys.filter((key) => key !== field)
          await expectDenied(createTable(dbFor(who), who, { fields, audit: { changed: rest, before: Object.fromEntries(rest.map((key) => [key, null])), after: Object.fromEntries(rest.map((key) => [key, fields[key]])) } }), `${label}: ${field} left out`)
          await expectDenied(createTable(dbFor(who), who, { fields, audit: { before: { ...Object.fromEntries(keys.map((key) => [key, null])), [field]: fields[field] } } }), `${label}: an old value for ${field}`)
        }
        await expectDenied(createTable(dbFor(who), who, { fields, audit: { changed: [...keys, 'players', 'rev'] } }), `${label}: fields it does not have`)
        await expectDenied(createTable(dbFor(who), who, { fields, audit: { changed: [], before: {}, after: {} } }), `${label}: nothing listed`)
        await expectAllowed(createTable(dbFor(who), who, { fields }), `${label}: the honest entry`)
      }
    })

    test('an entry for a new document cannot say it is a document of another kind, zone, key or phase', async () => {
      await expectDenied(createTable(dbFor(who), who, { fields: zoneTableDoc(), audit: { after: { ...zoneTableDoc(), type: 'source' } } }), 'a zone said to be a creature')
      await expectDenied(createTable(dbFor(who), who, { fields: zoneTableDoc(), audit: { after: { ...zoneTableDoc(), zoneId: 60_000_002 } } }), 'a zone said to have another number')
      await expectDenied(createTable(dbFor(who), who, { fields: zoneTableDoc(), audit: { after: { ...zoneTableDoc(), phaseNo: 1 } } }), 'a zone said to be of another phase')
      await expectDenied(createTable(dbFor(who), who, { fields: sourceTableDoc(), audit: { after: { ...sourceTableDoc(), type: 'zone' } } }), 'a creature said to be a zone')
      await expectDenied(createTable(dbFor(who), who, { fields: sourceTableDoc(), audit: { after: { ...sourceTableDoc(), zoneId: 60_000_002 } } }), 'a creature said to be in another zone')
      await expectDenied(createTable(dbFor(who), who, { fields: sourceTableDoc(), audit: { after: { ...sourceTableDoc(), key: 'c2' } } }), 'a creature said to have another key')
      await expectDenied(createTable(dbFor(who), who, { fields: sourceTableDoc(), audit: { after: { ...sourceTableDoc(), phaseNo: 1 } } }), 'a creature said to be of another phase')
      await expectAllowed(createTable(dbFor(who), who, { fields: sourceTableDoc() }), 'the honest entry')
    })

    // Each field gets its own document: an entry id is used once, so the same document cannot go from revision 1 to 2 again.
    test('an edit of a creature: each field is checked against the stored document, for a change, for adding it and for taking it away', async () => {
      const fields: [string, unknown, unknown][] = [
        ['name', 'Renamed Boss', 'Other Name'], ['kind', 'rare', 'trash'], ['order', 30, 40], ['hiddenItemIds', [4444], [5555]], ['npcId', 4888, 4889], ['itemIds', [7], [8]], ['removed', true, false],
      ]
      const optional = ['name', 'kind', 'order', 'npcId', 'removed']
      for (const [index, [field, value, wrong]] of fields.entries()) {
        const key = `f${index}`
        const id = sourceTableId(ZONE_NO, key, 0)
        const was = sourceTableDoc({ key, npcId: 4887, removed: false })
        await storeTable(id, was)
        await expectDenied(editOf(id, { [field]: value }, { audit: { after: { [field]: wrong } } }), `${field}: a wrong new value`)
        await expectDenied(editOf(id, { [field]: value }, { audit: { before: { [field]: other(was[field]) } } }), `${field}: a wrong old value`)
        await expectDenied(editOf(id, { [field]: value }, { audit: { before: {} } }), `${field}: an old value left out`)
        await expectDenied(editOf(id, { [field]: value }, { audit: { changed: [], before: {}, after: {} } }), `${field}: the field left out`)
        await expectDenied(editOf(id, { [field]: value }, { audit: { changed: [field, 'phaseNo'], before: { [field]: was[field], phaseNo: 0 }, after: { [field]: value, phaseNo: 0 } } }), `${field}: a field that did not change`)
        await expectAllowed(editOf(id, { [field]: value }), `${field}: the honest entry`)
        if (!optional.includes(field)) continue
        await expectDenied(editOf(id, { [field]: GONE }, { audit: { after: { [field]: value } } }), `${field}: taken away, said to be unchanged`)
        await expectAllowed(editOf(id, { [field]: GONE }), `${field}: taken away`)
        assert.deepEqual((await stored(`auditLog/${entryId('table', id, 3)}`))?.after, { [field]: null })
        await expectDenied(editOf(id, { [field]: value }, { audit: { before: { [field]: value } } }), `${field}: added back with an old value it did not have`)
        await expectAllowed(editOf(id, { [field]: value }), `${field}: added back`)
        assert.deepEqual((await stored(`auditLog/${entryId('table', id, 4)}`))?.before, { [field]: null })
      }
    })

    test('an edit of a zone: each field is checked against the stored document', async () => {
      const fields: [string, unknown, unknown][] = [['name', 'Renamed Hollow', 'Other'], ['kind', 'raid', 'dungeon'], ['players', 25, 20], ['removed', true, false]]
      for (const [index, [field, value, wrong]] of fields.entries()) {
        const zoneId = 60_000_100 + index
        const id = zoneTableId(zoneId, 0)
        const was = zoneTableDoc({ zoneId, removed: false })
        await storeTable(id, was)
        await expectDenied(editOf(id, { [field]: value }, { audit: { after: { [field]: wrong } } }), `${field}: a wrong new value`)
        await expectDenied(editOf(id, { [field]: value }, { audit: { before: { [field]: other(was[field]) } } }), `${field}: a wrong old value`)
        await expectDenied(editOf(id, { [field]: value }, { audit: { changed: [], before: {}, after: {} } }), `${field}: the field left out`)
        await expectAllowed(editOf(id, { [field]: value }), `${field}: the honest entry`)
      }
    })

    test('an edit of a presence document: removed is checked against the stored document', async () => {
      await storeTable(PRESENCE_TABLE, presenceTableDoc())
      await expectDenied(editOf(PRESENCE_TABLE, { removed: false }, { audit: { after: { removed: true } } }), 'a wrong new value')
      await expectDenied(editOf(PRESENCE_TABLE, { removed: false }, { audit: { before: { removed: false } } }), 'a wrong old value')
      await expectDenied(editOf(PRESENCE_TABLE, { removed: false }, { audit: { changed: [], before: {}, after: {} } }), 'left out')
      await expectDenied(editOf(PRESENCE_TABLE, { removed: false }, { audit: { item: 'Test Hollow' } }), 'a label')
      await expectAllowed(editOf(PRESENCE_TABLE, { removed: false }), 'the honest entry')
    })

    test('the entry cannot list the fields that never change, since they did not', async () => {
      await storeTable(SOURCE_TABLE, sourceTableDoc())
      for (const field of ['type', 'zoneId', 'key', 'phaseNo']) {
        const value = sourceTableDoc()[field]
        await expectDenied(edit({ itemIds: [1] }, { audit: { changed: ['itemIds', field], before: { itemIds: [1111, 2222], [field]: value }, after: { itemIds: [1], [field]: value } } }), field)
      }
    })

    test('an entry for a table can only say create or edit, the one that fits, and only for its own document', async () => {
      await storeTable(SOURCE_TABLE, sourceTableDoc())
      for (const action of ['remove', 'delete', 'reorder', 'cancel', 'start', 'reopen', 'create']) {
        await expectDenied(edit({ itemIds: [1] }, { audit: { action } }), `${action} for a change`)
        await expectDenied(edit({ itemIds: [1] }, { audit: { action, reason: 'A reason, in case that is what was missing' } }), `${action} for a change, with a reason`)
      }
      for (const action of ['remove', 'delete', 'reorder', 'cancel', 'start', 'reopen', 'edit']) {
        await expectDenied(createTable(dbFor(who), who, { fields: zoneTableDoc(), audit: { action } }), `${action} for a new document`)
        await expectDenied(createTable(dbFor(who), who, { fields: zoneTableDoc(), audit: { action, reason: 'A reason, in case that is what was missing' } }), `${action} for a new document, with a reason`)
      }
      await expectDenied(edit({ removed: true }, { audit: { action: 'remove', reason: 'Taken out of the lists' } }), 'removing a creature is an edit that sets removed, not a remove')
      await expectDenied(edit({ itemIds: [1] }, { audit: { reason: 'x'.repeat(301) } }), 'a reason over 300 characters')
      await expectDenied(edit({ itemIds: [1] }, { audit: { targetId: sourceTableId(60_000_002, 'c1', 0) } }), 'another target')
      await expectDenied(edit({ itemIds: [1] }, { audit: { targetType: 'priority' } }), 'another type')
      await expectDenied(edit({ itemIds: [1] }, { audit: { targetType: 'award' } }), 'the type award')
      await expectDenied(edit({ itemIds: [1] }, { entryKey: `table_${sourceTableId(60_000_002, 'c1', 0)}_2` }), 'filed under another id')
      await expectDenied(edit({ itemIds: [1] }, { audit: { by: UID[who === 'guildLeader' ? 'raidLeader' : 'guildLeader'] } }), 'another author')
      await expectAllowed(edit({ itemIds: [1] }), 'the honest entry')
    })

    test('an entry cannot be filed alone: it needs its table, and a table needs its entry', async () => {
      await expectDenied(setDoc(guildDoc(dbFor(who), `auditLog/${entryId('table', ZONE_TABLE, 1)}`), entry(who, 'table', ZONE_TABLE, 1, { action: 'create', item: 'Test Hollow', changed: [] })), 'an entry for a table that is not there')
      await storeTable(SOURCE_TABLE, sourceTableDoc())
      const alone = writeBatch(dbFor(who))
      alone.set(guildDoc(dbFor(who), `auditLog/${entryId('table', SOURCE_TABLE, 2)}`), entry(who, 'table', SOURCE_TABLE, 2, { item: 'Test Boss', changed: [] }))
      await expectDenied(alone.commit(), 'an entry for a change that is not in the batch')
      assert.equal((await stored(`lootTables/${SOURCE_TABLE}`))?.rev, 1)
    })
  })

  // The widest entries the app can write: all 11 fields of a first creature document, all 7 of a first custom zone document, and the largest edit.
  describe(`the widest entries a ${LABEL[who]} writes`, () => {
    test('a first creature document with all 11 fields, both lists full and the longest strings', async () => {
      const fields = sourceTableDoc({ zoneId: 100_000_000, key: 'k'.repeat(30), phaseNo: 1, name: 'x'.repeat(100), kind: 'trash', npcId: 100_000_000, order: 100_000, itemIds: ids(80), hiddenItemIds: ids(80, 5000), removed: true })
      assert.equal(Object.keys(fields).length, 11)
      await expectAllowed(createTable(dbFor(who), who, { fields }))
      assert.equal((await stored(`auditLog/${entryId('table', tableIdOf(fields), 1)}`))?.changed?.length, 11)
    })

    test('a first custom zone document with all 7 fields', async () => {
      const fields = zoneTableDoc({ zoneId: 100_000_000, phaseNo: 1, name: 'x'.repeat(100), kind: 'raid', players: 40, removed: false })
      assert.equal(Object.keys(fields).length, 7)
      await expectAllowed(createTable(dbFor(who), who, { fields }))
    })

    test('an edit that changes every field it can: 7 for a creature, 4 for a zone', async () => {
      await storeTable(SOURCE_TABLE, sourceTableDoc({ npcId: 4887, removed: false }))
      await expectAllowed(edit({ name: 'x'.repeat(100), kind: 'trash', npcId: 100_000_000, order: 100_000, itemIds: ids(80), hiddenItemIds: ids(80, 5000), removed: true }))
      await storeTable(ZONE_TABLE, zoneTableDoc({ removed: false }))
      await expectAllowed(editOf(ZONE_TABLE, { name: 'x'.repeat(100), kind: 'raid', players: 40, removed: true }))
    })

    test('an edit that takes every optional field away', async () => {
      await storeTable(SOURCE_TABLE, sourceTableDoc({ npcId: 4887, removed: false }))
      await expectAllowed(edit({ name: GONE, kind: GONE, npcId: GONE, order: GONE, removed: GONE }))
    })

    // The drop list import (LOOT-008) writes a reason on every entry, such as "Imported from the addon (d-...)": the widest writes still fit with the longest one.
    test('the widest creature document and the widest edit, each with a reason of 300 characters', async () => {
      const fields = sourceTableDoc({ zoneId: 100_000_000, key: 'k'.repeat(30), phaseNo: 1, name: 'x'.repeat(100), kind: 'trash', npcId: 100_000_000, order: 100_000, itemIds: ids(80), hiddenItemIds: ids(80, 5000), removed: true })
      await expectAllowed(createTable(dbFor(who), who, { fields, audit: { reason: 'r'.repeat(300) } }))
      assert.equal((await stored(`auditLog/${entryId('table', tableIdOf(fields), 1)}`))?.reason, 'r'.repeat(300))
      await storeTable(SOURCE_TABLE, sourceTableDoc({ npcId: 4887, removed: false }))
      await expectAllowed(edit({ name: 'x'.repeat(100), kind: 'trash', npcId: 100_000_000, order: 100_000, itemIds: ids(80), hiddenItemIds: ids(80, 5000), removed: true }, { audit: { reason: 'r'.repeat(300) } }))
    })
  })
}

// The four kinds of document, each with something the persona writes: a new one, and a change to an existing one.
const WRITES: [string, string, DocumentData, DocumentData][] = [
  ['the document of a phase', phaseTableId(1), { type: 'phase', phaseNo: 1 }, { follows: 0 }],
  ['a zone of the guild\'s own', ZONE_TABLE, zoneTableDoc(), { players: 6 }],
  ['a built-in zone', PRESENCE_TABLE, presenceTableDoc(), { removed: false }],
  ['a creature', SOURCE_TABLE, sourceTableDoc(), { itemIds: [1111, 2222, 3333] }],
  ['a change to a creature of the captures', BUILT_IN_SOURCE_TABLE, overlayTableDoc(), { itemIds: [3333, 5555] }],
]

describe('who may write a table', () => {
  for (const who of ['member', 'stranger', 'otherGuildLeader', 'anonymous'] as const) {
    test(`a ${LABEL[who]} cannot create or edit one, with every entry in place`, async () => {
      for (const [, id, fields] of WRITES) await storeTable(id, fields)
      const db = dbFor(who)
      // The payload a Raid Leader would send (its stamps and entry name the Raid Leader, which a request by anyone else cannot truthfully do).
      for (const [label, id, , changes] of WRITES) await expectDenied(editTable(db, 'raidLeader', { id, changes }), `edit ${label}`)
      for (const [label, , fields] of WRITES) await expectDenied(createTable(db, 'raidLeader', { fields: { ...fields, phaseNo: 1 } }), `create ${label}`)
      assert.deepEqual((await stored(`lootTables/${SOURCE_TABLE}`))?.itemIds, [1111, 2222])
      assert.equal(await stored(`lootTables/${zoneTableId(ZONE_NO, 1)}`), undefined)
    })
  }

  for (const who of ['member', 'stranger', 'otherGuildLeader'] as const) {
    test(`a ${LABEL[who]} who signs honestly, with their own account in every stamp and in the entry, is refused too`, async () => {
      for (const [, id, fields] of WRITES) await storeTable(id, fields)
      const signer = who as unknown as Staff // the helpers write the stamps and the entry for this account
      for (const [label, id, , changes] of WRITES) await expectDenied(editTable(dbFor(who), signer, { id, changes }), `edit ${label}`)
      for (const [label, , fields] of WRITES) await expectDenied(createTable(dbFor(who), signer, { fields: { ...fields, phaseNo: 1 } }), `create ${label}`)
    })
  }

  test('the payloads of the tests above are accepted from a Raid Leader (control)', async () => {
    for (const [label, , fields] of WRITES) await expectAllowed(createTable(dbFor('raidLeader'), 'raidLeader', { fields: { ...fields, phaseNo: 1 } }), `create ${label}`)
  })

  test('one leader cannot sign for another', async () => {
    await expectDenied(createTable(dbFor('raidLeader'), 'guildLeader'), 'a Raid Leader signing as the Guild Leader')
    await storeTable(SOURCE_TABLE, sourceTableDoc())
    await expectDenied(editTable(dbFor('guildLeader'), 'raidLeader'), 'a Guild Leader signing as the Raid Leader')
  })

  test('a plain write is refused even when it carries stamps and a phase', async () => {
    for (const [label, id, fields] of WRITES) await expectDenied(setDoc(guildDoc(dbFor('raidLeader'), `lootTables/${id}`), { ...fields, phaseNo: 1, rev: 1, updatedBy: UID.raidLeader, updatedAt: serverTimestamp() }), label)
  })

  test('every guild role can read the tables, and nobody else', async () => {
    await storeTable(SOURCE_TABLE, sourceTableDoc())
    await storeTable(PRESENCE_TABLE, presenceTableDoc())
    for (const who of ['member', 'raidLeader', 'guildLeader'] as const) {
      assert.ok((await getDoc(guildDoc(dbFor(who), `lootTables/${SOURCE_TABLE}`))).exists(), `${who} reads`)
      assert.ok((await getDoc(guildDoc(dbFor(who), `lootTables/${PRESENCE_TABLE}`))).exists(), `${who} reads a presence document`)
    }
    for (const who of ['stranger', 'otherGuildLeader', 'anonymous'] as const) await expectDenied(getDoc(guildDoc(dbFor(who), `lootTables/${SOURCE_TABLE}`)), `${who} reads`)
  })
})

describe('a table is never deleted', () => {
  for (const who of ['member', 'raidLeader', 'guildLeader', 'stranger', 'anonymous'] as const) {
    test(`not by a ${LABEL[who]}, with an entry for the delete or without one`, async () => {
      for (const [, id, fields] of WRITES) await storeTable(id, fields)
      for (const [label, id] of WRITES) {
        await expectDenied(deleteDoc(guildDoc(dbFor(who), `lootTables/${id}`)), `a plain delete of ${label}`)
        const batch = writeBatch(dbFor(who))
        batch.delete(guildDoc(dbFor(who), `lootTables/${id}`))
        batch.set(guildDoc(dbFor(who), `auditLog/${entryId('table', id, 2)}`), entry(who === 'raidLeader' || who === 'guildLeader' ? who : 'raidLeader', 'table', id, 2, { action: 'delete', item: '', changed: [] }))
        await expectDenied(batch.commit(), `a delete of ${label} with a delete entry`)
        assert.ok(await stored(`lootTables/${id}`), `${label} is still there`)
      }
    })
  }
})

// An entry stays for ever, so an id that was used before has entries from its earlier life. They must not count: a write is accepted only with an
// entry written in the same batch.
describe('an entry left from an earlier life of a table id', () => {
  const left = (id: string, revs: number[]) => asAdmin(async (db) => {
    for (const rev of revs) await setDoc(guildDoc(db, `auditLog/${entryId('table', id, rev)}`), { at: new Date('2026-01-01T00:00:00Z'), by: UID.raidLeader, byName: 'An earlier leader', targetType: 'table', targetId: id, rev, action: 'create', item: '', changed: [] })
  })

  test('does not let a table be created without a new entry, whichever kind it is', async () => {
    for (const [label, id, fields] of WRITES) {
      await left(id, [1])
      await expectDenied(createTable(dbFor('raidLeader'), 'raidLeader', { fields, skipEntry: true }), `${label}: a create with no entry`)
      await expectDenied(setDoc(guildDoc(dbFor('raidLeader'), `lootTables/${id}`), { ...fields, rev: 1, updatedBy: UID.raidLeader, updatedAt: serverTimestamp() }), `${label}: a plain create`)
      assert.equal(await stored(`lootTables/${id}`), undefined)
    }
  })

  test('does not let a table be edited without a new entry, whichever kind it is', async () => {
    for (const [label, id, fields, changes] of WRITES) {
      await storeTable(id, fields)
      await left(id, [2])
      await expectDenied(editTable(dbFor('raidLeader'), 'raidLeader', { id, changes, skipEntry: true }), `${label}: an edit with no entry`)
      assert.equal((await stored(`lootTables/${id}`))?.rev, 1)
    }
  })

  test('a table written once cannot be created again under its id', async () => {
    await expectAllowed(createTable(dbFor('raidLeader'), 'raidLeader'))
    await asAdmin((db) => deleteDoc(guildDoc(db, `lootTables/${ZONE_TABLE}`))) // gone, as only the console could do
    await expectDenied(createTable(dbFor('raidLeader'), 'raidLeader'), 'with an entry, which would be written twice')
    await expectDenied(createTable(dbFor('raidLeader'), 'raidLeader', { skipEntry: true }), 'without one')
  })

  test('a table that was changed once cannot be changed to the same revision again', async () => {
    await storeTable(SOURCE_TABLE, sourceTableDoc())
    await expectAllowed(editTable(dbFor('raidLeader'), 'raidLeader'))
    await asAdmin((db) => setDoc(guildDoc(db, `lootTables/${SOURCE_TABLE}`), { ...sourceTableDoc(), rev: 1, updatedBy: 'uid-earlier-editor', updatedAt: new Date('2026-12-01T00:00:00Z') })) // put back, as only the console could do
    await expectDenied(editTable(dbFor('raidLeader'), 'raidLeader', { changes: { itemIds: [5] } }), 'with an entry, which would be written twice')
    await expectDenied(editTable(dbFor('raidLeader'), 'raidLeader', { changes: { itemIds: [5] }, skipEntry: true }), 'without one')
  })
})

describe('the other documents the entry rules know are unaffected', () => {
  test('an entry that names a table but is filed under another id is refused', async () => {
    await storeTable(SOURCE_TABLE, sourceTableDoc())
    await expectDenied(editTable(dbFor('raidLeader'), 'raidLeader', { entryKey: 'table_s60000001_c1_0_9' }))
  })
})

// The rules read the loot phase from the settings as they are BEFORE the batch (get), so a table document is judged against the phase the guild is in when
// it sends the batch, even when the same batch starts or reopens a phase. Only a Guild Leader writes the settings.
describe('a batch that starts or reopens a phase while it writes a table document', () => {
  const settings = (current: string, next: string, phaseHistory: string[]) => ({
    currentPhase: current, nextPhase: next, currentStatusLabel: 'Preparing', currentStatusTone: 'preparing', nextStatusLabel: 'Not started', nextStatusTone: 'paused', councilStatus: 'deliberating',
    teamNames: { blue: 'Blue', yellow: 'Yellow', red: 'Red', white: 'White' }, groupNames: { green: 'Green', pink: 'Pink', brown: 'Brown' }, phaseHistory,
  })
  /** Phase 1 is current: one finished phase. */
  const atPhaseOne = () => asAdmin((db) => setDoc(guildDoc(db, 'settings/general'), { ...settings('Phase one', 'Phase two', ['Launch prep']), phaseRev: 1 }))
  const startTwo = settings('Phase two', 'To be announced', ['Launch prep', 'Phase one'])
  const reopenZero = settings('Launch prep', 'Phase one', [])
  const doc = (phaseNo: number) => sourceTableDoc({ phaseNo })

  /** One batch by the Guild Leader: the phase change, and either a new document or a change to a stored one. */
  async function withPhaseChange(change: { settings: DocumentData; rev: number; action: 'start' | 'reopen' }, write: { create: DocumentData } | { edit: DocumentData }, stage: () => Promise<void> = atPhaseOne) {
    await resetData() // every attempt starts from the same guild: the entries of an earlier attempt would be in the way
    await stage()
    const db = dbFor('guildLeader')
    if ('edit' in write) await storeTable(tableIdOf(write.edit), write.edit)
    const batch = writeBatch(db)
    await changePhase(db, 'guildLeader', { into: batch, ...change })
    if ('create' in write) createTable(db, 'guildLeader', { into: batch, fields: write.create })
    else await editTable(db, 'guildLeader', { into: batch, id: tableIdOf(write.edit), changes: { order: 11 } })
    return outcomeOf(batch.commit())
  }
  const start = { settings: startTwo, rev: 2, action: 'start' as const }
  const reopen = { settings: reopenZero, rev: 2, action: 'reopen' as const }

  test('starting phase 2 while phase 1 is current: a document of phase 1 or 2 is accepted, one of phase 3 is not, though it is the next phase after the batch', async () => {
    assert.equal(await withPhaseChange(start, { create: doc(1) }), 'allowed', 'phase 1, the current phase before the batch')
    assert.equal(await withPhaseChange(start, { create: doc(2) }), 'allowed', 'phase 2, the next phase before the batch')
    assert.equal(await withPhaseChange(start, { create: doc(3) }), 'denied', 'phase 3, two ahead before the batch')
    assert.equal(await withPhaseChange(start, { create: doc(0) }), 'denied', 'phase 0, finished before the batch')
  })

  test('the same batch with no table document starts the phase (control)', async () => {
    await atPhaseOne()
    const db = dbFor('guildLeader')
    const batch = writeBatch(db)
    await changePhase(db, 'guildLeader', { into: batch, ...start })
    await expectAllowed(batch.commit())
    assert.equal((await stored('settings/general'))?.currentPhase, 'Phase two')
  })

  test('starting phase 2: a stored document of phase 1 or 2 can be edited in the same batch, one of phase 3 cannot, though it is the next phase after the batch', async () => {
    assert.equal(await withPhaseChange(start, { edit: doc(1) }), 'allowed', 'phase 1')
    assert.equal(await withPhaseChange(start, { edit: sourceTableDoc({ phaseNo: 2, key: 'c2' }) }), 'allowed', 'phase 2')
    assert.equal(await withPhaseChange(start, { edit: sourceTableDoc({ phaseNo: 3, key: 'c3' }) }), 'denied', 'phase 3')
    assert.equal(await withPhaseChange(start, { edit: sourceTableDoc({ phaseNo: 0, key: 'c4' }) }), 'denied', 'phase 0')
  })

  test('reopening phase 0 while phase 1 is current: a document of phase 1 or 2 is accepted, one of phase 0 is not, though it is the current phase after the batch', async () => {
    assert.equal(await withPhaseChange(reopen, { create: doc(0) }), 'denied', 'phase 0, finished before the batch')
    assert.equal(await withPhaseChange(reopen, { create: doc(1) }), 'allowed', 'phase 1, current before the batch')
    assert.equal(await withPhaseChange(reopen, { create: doc(2) }), 'allowed', 'phase 2, next before the batch')
    assert.equal(await withPhaseChange(reopen, { edit: sourceTableDoc({ phaseNo: 0, key: 'c5' }) }), 'denied', 'an edit in phase 0')
    assert.equal(await withPhaseChange(reopen, { edit: sourceTableDoc({ phaseNo: 1, key: 'c6' }) }), 'allowed', 'an edit in phase 1')
  })

  test('the very first save of the settings (none stored) starts phase 1 while the guild is still in phase 0: a document of phase 0 or 1 is accepted, one of phase 2 is not', async () => {
    const first = { settings: settings('Phase one', 'To be announced', ['Launch prep']), rev: 1, action: 'start' as const }
    const nothingStored = async () => {}
    assert.equal(await withPhaseChange(first, { create: doc(0) }, nothingStored), 'allowed', 'phase 0')
    assert.equal(await withPhaseChange(first, { create: doc(1) }, nothingStored), 'allowed', 'phase 1')
    assert.equal(await withPhaseChange(first, { create: doc(2) }, nothingStored), 'denied', 'phase 2')
    assert.equal(await withPhaseChange(first, { edit: sourceTableDoc({ phaseNo: 1, key: 'c8' }) }, nothingStored), 'allowed', 'an edit in phase 1')
    assert.equal(await withPhaseChange(first, { edit: sourceTableDoc({ phaseNo: 2, key: 'c9' }) }, nothingStored), 'denied', 'an edit in phase 2')
  })
})

// ---- Found by the independent review: identity fields cannot be rewritten as doubles on an edit, and a guild whose settings were saved before phaseHistory existed.

// An edit that rewrites one identity field of a stored document as a double with the same value. The entry lists nothing (nothing differs in value).
const rewriteIdentity = (id: string, field: string, value: unknown) => rawCommit(UID.raidLeader, [
  { path: `lootTables/${id}`, mask: [field, 'rev', 'updatedBy', 'updatedAt'], fields: { [field]: value, rev: 2, updatedBy: UID.raidLeader, updatedAt: requestTime } },
  { path: `auditLog/${entryId('table', id, 2)}`, fields: entry('raidLeader', 'table', id, 2, { at: requestTime, item: id === PRESENCE_TABLE ? '' : id === ZONE_TABLE ? 'Test Hollow' : 'Test Boss', changed: [], before: {}, after: {} }) },
])

describe('identity fields cannot be rewritten as doubles on an edit', () => {
  const kinds: [string, string, Record<string, unknown>, number][] = [
    ['a zone of the guild\'s own', ZONE_TABLE, zoneTableDoc(), ZONE_NO],
    ['a built-in zone', PRESENCE_TABLE, presenceTableDoc(), BUILT_IN_ZONE_NO],
    ['a creature', SOURCE_TABLE, sourceTableDoc(), ZONE_NO],
  ]
  for (const [label, id, fields, zoneId] of kinds) {
    // On a create a double is also refused because the id would not match the fields, so only an edit tells the `is int` checks apart.
    test(`zoneId of ${label}`, async () => {
      await storeTable(id, fields)
      assert.equal(await rewriteIdentity(id, 'zoneId', asDouble(zoneId)), 'denied', 'zoneId as a double')
      assert.equal(await rewriteIdentity(id, 'zoneId', zoneId), 'allowed', 'control: the same request with an integer')
    })
    test(`phaseNo of ${label}`, async () => {
      await storeTable(id, fields)
      assert.equal(await rewriteIdentity(id, 'phaseNo', asDouble(0)), 'denied', 'phaseNo as a double')
      assert.equal(await rewriteIdentity(id, 'phaseNo', 0), 'allowed', 'control: the same request with an integer')
    })
  }
})

describe('a guild whose settings were saved before phaseHistory existed is in phase 0', () => {
  const legacy = () => asAdmin((db) => setDoc(guildDoc(db, 'settings/general'), { currentPhase: 'Phase', nextPhase: 'Next' }))
  test('create: phase 0 and 1 are accepted, phase 2 is not', async () => {
    await legacy()
    await expectAllowed(createTable(dbFor('raidLeader'), 'raidLeader', { fields: zoneTableDoc({ zoneId: 60_000_010, phaseNo: 0 }) }), 'phase 0')
    await expectAllowed(createTable(dbFor('raidLeader'), 'raidLeader', { fields: zoneTableDoc({ zoneId: 60_000_011, phaseNo: 1 }) }), 'phase 1')
    await expectDenied(createTable(dbFor('raidLeader'), 'raidLeader', { fields: zoneTableDoc({ zoneId: 60_000_012, phaseNo: 2 }) }), 'phase 2')
  })
  test('edit: a document of phase 0 or 1 can be edited, one of phase 2 cannot', async () => {
    await legacy()
    for (const phaseNo of [0, 1, 2]) {
      const fields = sourceTableDoc({ phaseNo })
      await storeTable(tableIdOf(fields), fields)
      const run = editTable(dbFor('raidLeader'), 'raidLeader', { id: tableIdOf(fields), changes: { order: 11 } })
      if (phaseNo < 2) await expectAllowed(run, `phase ${phaseNo}`)
      else await expectDenied(run, 'phase 2')
    }
  })
})
