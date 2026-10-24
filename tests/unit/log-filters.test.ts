import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { makeWho, nameKey } from '../../src/shared/game/candidates.ts'
import { logFacts, logFilterActive, logPlayers, matchesLogFilter, noLogFilter, type LogFacts } from '../../src/features/loot/logFilters.ts'

// Invented names.
const priorities = [
  { id: 'p1', item: 'Iron Ring', encounter: 'Test Hall \u00b7 Warden', rankedPlayers: ['Aria', 'Brock'], itemId: 101 },
  { id: 'p2', item: 'Old Cloak', encounter: 'Cave \u00b7 Queen', rankedPlayers: ['Cleo'] },
]
const byId = (id: string) => priorities.find((priority) => priority.id === id)
// Without a roster a person is known by name; `person` is what a name becomes.
const who = makeWho([])
const person = (name: string) => ({ key: `name:${nameKey(name)}`, name: name.trim() })
const entry = (overrides: Record<string, unknown>) => ({ targetType: 'priority', targetId: 'p1', item: 'Iron Ring', before: {}, after: {}, ...overrides }) as Parameters<typeof logFacts>[0]
const slotOf = (item: { item: string; itemId?: number }) => (item.itemId === 101 ? 'Finger' : item.itemId === undefined ? 'Other' : undefined)

describe('logFacts', () => {
  it('takes what the entry lists, and the rest from the priority as it stands', () => {
    const facts = logFacts(entry({ after: { councilNote: 'x' } }), byId, who)
    assert.deepEqual(facts, { about: 'item', item: 'Iron Ring', itemId: 101, encounter: 'Test Hall \u00b7 Warden', players: [person('Aria'), person('Brock')] })
  })
  it('prefers what the entry says, and knows the players an edit added or took off', () => {
    const facts = logFacts(entry({ before: { rankedPlayers: ['Aria', 'Dax'], encounter: 'Old Hall \u00b7 Boss' }, after: { rankedPlayers: ['Aria', 'Brock'], encounter: 'Test Hall \u00b7 Warden' } }), byId, who)
    assert.equal(facts.encounter, 'Test Hall \u00b7 Warden')
    assert.deepEqual(facts.players.map((entry) => entry.name).sort(), ['Aria', 'Brock', 'Dax'])
  })
  it('works for a priority that no longer exists, from the entry alone', () => {
    const facts = logFacts(entry({ targetId: 'gone', item: 'Lost Hat', action: 'delete', before: { encounter: 'Cave \u00b7 Queen', rankedPlayers: ['Cleo'], itemId: 7 } }), byId, who)
    assert.deepEqual(facts, { about: 'item', item: 'Lost Hat', itemId: 7, encounter: 'Cave \u00b7 Queen', players: [person('Cleo')] })
  })
  it('reads an award as its recipient and the candidates it was decided among, and finds its item through the priority', () => {
    const facts = logFacts(entry({ targetType: 'award', targetId: 'a1', after: { priorityId: 'p1', recipient: 'Brock', prioritySnapshot: ['Aria', 'Brock'], encounter: 'Test Hall \u00b7 Warden' } }), byId, who)
    assert.deepEqual(facts.players, [person('Brock'), person('Aria')])
    assert.equal(facts.itemId, 101)
  })
  it('has nothing to say about an item for a phase entry, and never throws on odd values', () => {
    assert.equal(logFacts(entry({ targetType: 'phase', targetId: 'settings' }), byId, who).about, 'phase')
    assert.equal(logFacts(entry({ targetType: 'table', targetId: 's900_npc11' }), byId, who).about, 'table')
    assert.deepEqual(logFacts(entry({ targetId: 'p2', after: { rankedPlayers: 'Cleo', itemId: 'x', encounter: 5 } }), byId, who).players, [person('Cleo')])
  })
})

describe('matchesLogFilter', () => {
  const facts: LogFacts = { about: 'item', item: 'Iron Ring', itemId: 101, encounter: 'Test Hall \u00b7 Warden', players: [person('Aria'), person('Brock')] }
  it('lets everything through when no dropdown is set, a phase entry included', () => {
    assert.ok(matchesLogFilter(facts, noLogFilter, slotOf))
    assert.ok(matchesLogFilter({ about: 'phase', item: '', encounter: '', players: [] }, noLogFilter, slotOf))
  })
  it('filters by the person, whatever name they had when the entry was written', () => {
    assert.ok(matchesLogFilter(facts, { ...noLogFilter, player: 'name:aria' }, slotOf))
    assert.equal(matchesLogFilter(facts, { ...noLogFilter, player: 'name:cleo' }, slotOf), false)
  })
  it('filters by slot, and an item whose slot is not known yet matches none', () => {
    assert.ok(matchesLogFilter(facts, { ...noLogFilter, slot: 'Finger' }, slotOf))
    assert.equal(matchesLogFilter(facts, { ...noLogFilter, slot: 'Head' }, slotOf), false)
    assert.equal(matchesLogFilter({ ...facts, itemId: 5 }, { ...noLogFilter, slot: 'Other' }, slotOf), false)
  })
  it('filters by dungeon or boss', () => {
    assert.ok(matchesLogFilter(facts, { ...noLogFilter, encounter: 'd:test hall' }, slotOf))
    assert.ok(matchesLogFilter(facts, { ...noLogFilter, encounter: 'b:test hall|warden' }, slotOf))
    assert.equal(matchesLogFilter(facts, { ...noLogFilter, encounter: 'b:test hall|queen' }, slotOf), false)
    assert.equal(matchesLogFilter({ ...facts, encounter: '' }, { ...noLogFilter, encounter: 'd:test hall' }, slotOf), false)
  })
  it('needs every dropdown that is set to match, and hides a phase entry as soon as one is set', () => {
    assert.ok(matchesLogFilter(facts, { ...noLogFilter, player: 'name:brock', slot: 'Finger', encounter: 'd:test hall' }, slotOf))
    assert.equal(matchesLogFilter(facts, { ...noLogFilter, player: 'name:brock', slot: 'Head', encounter: 'd:test hall' }, slotOf), false)
    assert.equal(matchesLogFilter({ about: 'phase', item: '', encounter: '', players: [] }, { ...noLogFilter, player: 'name:aria' }, slotOf), false)
    assert.equal(matchesLogFilter({ about: 'table', item: '', encounter: '', players: [] }, { ...noLogFilter, player: 'name:aria' }, slotOf), false)
    assert.ok(matchesLogFilter({ about: 'table', item: '', encounter: '', players: [] }, noLogFilter, slotOf))
  })
  it('knows whether any dropdown is set', () => {
    assert.equal(logFilterActive(noLogFilter), false)
    assert.ok(logFilterActive({ ...noLogFilter, slot: 'Head' }))
  })
})

describe('logPlayers', () => {
  it('lists each person once, alphabetically by name, and keeps the current choice', () => {
    const all: LogFacts[] = [
      { about: 'item', item: 'A', encounter: '', players: [person('Brock'), person('aria')] },
      { about: 'item', item: 'B', encounter: '', players: [person('Aria'), person(' Cleo ')] },
    ]
    assert.deepEqual(logPlayers(all, ''), [person('aria'), person('Brock'), person('Cleo')])
    assert.deepEqual(logPlayers(all, 'name:dax'), [person('aria'), person('Brock'), person('Cleo'), { key: 'name:dax', name: 'dax' }])
  })
})

describe('the Log by roster id', () => {
  const roster = [{ id: 'p-1', name: 'Ariana', className: 'Mage' }, { id: 'p-2', name: 'Brock', className: 'Warrior' }]
  const withRoster = makeWho(roster)
  it('knows a renamed character by id: an entry written under the old name is found under the new one', () => {
    const facts = logFacts(entry({ targetType: 'award', targetId: 'a1', after: { priorityId: 'p1', recipient: 'Aria', recipientId: 'p-1', prioritySnapshot: ['Aria', 'Brock', 'Any mage'], prioritySnapshotIds: ['p-1', 'p-2', ''] } }), byId, withRoster)
    assert.deepEqual(facts.players, [{ key: 'id:p-1', name: 'Ariana' }, { key: 'id:p-2', name: 'Brock' }])
    assert.ok(matchesLogFilter(facts, { ...noLogFilter, player: 'id:p-1' }, slotOf))
  })
  it('leaves a note out of the people, and reads both lists of an edit', () => {
    const facts = logFacts(entry({ before: { rankedPlayers: ['Aria', 'Any mage'], rankedIds: ['p-1', ''] }, after: { rankedPlayers: ['Aria', 'Brock', 'Any mage'], rankedIds: ['p-1', 'p-2', ''] } }), byId, withRoster)
    // The priority as it stands still spells the first name the old way, which the roster no longer has, so that line is known by name.
    assert.deepEqual(facts.players.map((entry) => entry.key), ['id:p-1', 'id:p-2', 'name:aria'])
    assert.ok(!facts.players.some((entry) => entry.name.includes('Any mage')))
  })
  it('finds an old entry that has only names when the roster still has that name', () => {
    const facts = logFacts(entry({ targetType: 'award', targetId: 'a1', after: { priorityId: 'p1', recipient: 'Brock', prioritySnapshot: ['Aria', 'Brock'] } }), byId, withRoster)
    assert.ok(facts.players.some((entry) => entry.key === 'id:p-2'))
  })
})
