// What the roster ids and the notes change for the people who read a priority: who has received it, who it is offered to, what the toolbar and the
// search find, what the member dashboard shows, how it is carried over and how the Log tells it. Names are invented: this repository is public.
import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { makeWho } from '../../src/shared/game/candidates.ts'
import { listingProgress, recipientChoices } from '../../src/shared/game/completion.ts'
import { describeEntry, showLines } from '../../src/features/loot/auditText.ts'
import { carryOverFields } from '../../src/features/loot/carryOver.ts'
import { filterOptions, filterPriorities, visiblePriorities } from '../../src/features/loot/filters.ts'
import { noPriorityFilters } from '../../src/features/loot/priorityFilters.ts'
import { myAwards, myPriorities } from '../../src/features/dashboard/myCharacters.ts'
import type { AuditEntry } from '../../src/shared/game/lootAudit.ts'

const roster = [
  { id: 'p-1', name: 'Morrowind', className: 'Warlock', specialization: 'Demonology' },
  { id: 'p-2', name: 'Aurelia', className: 'Mage', specialization: 'Frost' },
  { id: 'p-3', name: 'Vex', className: 'Warlock', specialization: 'Affliction' },
]
const who = makeWho(roster)
// Morrow was renamed Morrowind after this list and these awards were written.
const list = (overrides: Record<string, unknown> = {}) => ({ id: 'pr1', item: 'Signet of the Deep Earth', encounter: 'Test Hall \u00b7 Warden', councilNote: '', rankedPlayers: ['Morrow', 'Any warlock who did not get the staff', 'Aurelia'], rankedIds: ['p-1', '', 'p-2'], ...overrides })
const award = (recipient: string, overrides: Record<string, unknown> = {}) => ({ priorityId: 'pr1', item: 'Signet of the Deep Earth', recipient, ...overrides })

describe('who has received a priority, with ids and notes', () => {
  it('counts an award by id for the character even after a rename, and an old award by name when the roster has that name', () => {
    assert.deepEqual(listingProgress(list(), [award('Morrow', { recipientId: 'p-1' })], undefined, who).received, [true, false, false])
    assert.deepEqual(listingProgress(list(), [award('Aurelia')], undefined, who).received, [false, false, true])
  })
  it('does not count an old award under a name the roster no longer has (history as written)', () => {
    assert.deepEqual(listingProgress(list(), [award('Morrow')], undefined, who).received, [false, false, false])
  })
  it('never receives a note, and keeps the priority open while a note is open', () => {
    const progress = listingProgress(list(), [award('Morrow', { recipientId: 'p-1' }), award('Aurelia', { recipientId: 'p-2' })], undefined, who)
    assert.deepEqual(progress.received, [true, false, true])
    assert.equal(progress.next, 1) // the open note is what is next
    assert.equal(progress.complete, false)
  })
  it('is complete when every character has received it and every note is finished', () => {
    const done = list({ rankedIds: ['p-1', '!', 'p-2'] })
    const awards = [award('Morrow', { recipientId: 'p-1' }), award('Aurelia', { recipientId: 'p-2' })]
    const progress = listingProgress(done, awards, undefined, who)
    assert.equal(progress.complete, true)
    assert.equal(progress.next, -1)
    assert.equal(listingProgress(done, [awards[0]!], undefined, who).complete, false)
  })
  it('counts a person listed twice once per receipt, by id', () => {
    const twice = list({ rankedPlayers: ['Morrow', 'Vex', 'Morrowind'], rankedIds: ['p-1', 'p-3', 'p-1'] })
    assert.deepEqual(listingProgress(twice, [award('Morrowind', { recipientId: 'p-1' })], undefined, who).received, [true, false, false])
    assert.deepEqual(listingProgress(twice, [award('Morrowind', { recipientId: 'p-1' }), award('Morrowind', { recipientId: 'p-1' })], undefined, who).received, [true, false, true])
  })
  it('a winner put on a character line through a note shows as received by the same award', () => {
    const afterReceipt = list({ rankedPlayers: ['Morrow', 'Vex', 'Any warlock who did not get the staff', 'Aurelia'], rankedIds: ['p-1', 'p-3', '', 'p-2'] })
    const progress = listingProgress(afterReceipt, [award('Vex', { recipientId: 'p-3' })], undefined, who)
    assert.deepEqual(progress.received, [false, true, false, false])
    assert.equal(progress.next, 0)
  })
  it('a priority with names only still works exactly as before without a roster', () => {
    const plain = { id: 'pr2', item: 'x', rankedPlayers: ['Morrow', 'Vex'] }
    assert.deepEqual(listingProgress(plain, [award('vex', { priorityId: 'pr2', item: 'x' })]).received, [false, true])
  })
})

describe('who the award dialog offers', () => {
  it('lists each character once under the roster\'s current name, with their listings and receipts, and no note', () => {
    const twice = list({ rankedPlayers: ['Morrow', 'Any warlock', 'Morrowind', 'Aurelia'], rankedIds: ['p-1', '', 'p-1', 'p-2'] })
    const progress = listingProgress(twice, [award('Morrowind', { recipientId: 'p-1' })], undefined, who)
    assert.deepEqual(recipientChoices(twice, progress, who), [
      { key: 'id:p-1', name: 'Morrowind', id: 'p-1', listed: 2, received: 1 },
      { key: 'id:p-2', name: 'Aurelia', id: 'p-2', listed: 1, received: 0 },
    ])
  })
})

describe('the priority list filters', () => {
  const priorities = [list(), list({ id: 'pr2', item: 'Old Cloak', encounter: 'Cave \u00b7 Queen', rankedPlayers: ['Vex'], rankedIds: ['p-3'] })] as Parameters<typeof visiblePriorities>[0]
  const slotOf = () => undefined
  it('searches by a character\'s current name and the text of a note', () => {
    assert.deepEqual(filterPriorities(priorities, 'morrowind', who).map((priority) => priority.id), ['pr1'])
    assert.deepEqual(filterPriorities(priorities, 'did not get', who).map((priority) => priority.id), ['pr1'])
    assert.deepEqual(filterPriorities(priorities, 'morrow', who).map((priority) => priority.id), ['pr1'])
    assert.deepEqual(filterPriorities(priorities, 'Morrow\u00a0x', who).map((priority) => priority.id), [])
  })
  it('filters by the person: the same character under any name they were listed with', () => {
    const only = (player: string) => visiblePriorities(priorities, [], '', { ...noPriorityFilters, player }, slotOf, undefined, who).map((priority) => priority.id)
    assert.deepEqual(only('id:p-1'), ['pr1'])
    assert.deepEqual(only('id:p-3'), ['pr2'])
    assert.deepEqual(only('id:p-9'), [])
  })
  it('hides completed priorities, an open note keeping its priority on the list', () => {
    const complete = list({ id: 'pr3', rankedPlayers: ['Vex'], rankedIds: ['p-3'] })
    const awards = [award('Vex', { priorityId: 'pr3', recipientId: 'p-3' })]
    const shown = (items: unknown[]) => visiblePriorities(items as Parameters<typeof visiblePriorities>[0], awards, '', { ...noPriorityFilters, hideCompleted: true }, slotOf, undefined, who).map((priority) => priority.id)
    assert.deepEqual(shown([complete, priorities[0]]), ['pr1'])
  })
  it('offers each person on a character line once, by current name, and never a note', () => {
    const options = filterOptions(priorities, noPriorityFilters, who).players
    assert.deepEqual(options, [{ key: 'id:p-2', name: 'Aurelia' }, { key: 'id:p-1', name: 'Morrowind' }, { key: 'id:p-3', name: 'Vex' }])
    assert.deepEqual(filterOptions(priorities, { ...noPriorityFilters, player: 'id:p-9' }, who).players.find((player) => player.key === 'id:p-9'), { key: 'id:p-9', name: 'p-9' })
  })
})

describe('the member dashboard', () => {
  const mine = [roster[0]!, roster[2]!] // a main and an alt, both Warlocks
  it('finds a character by id under any name, marks received ones, and ignores notes', () => {
    const found = myPriorities([list() as never], mine as never, [award('Morrow', { recipientId: 'p-1' })] as never)
    assert.deepEqual(found.map((entry) => [entry.character.id, entry.position, entry.received]), [['p-1', 1, true]])
  })
  it('lists the latest phase first, then the place on the list', () => {
    const found = myPriorities([list({ id: 'a', phaseNo: 0 }), list({ id: 'b', phaseNo: 2, rankedPlayers: ['Vex', 'Morrow'], rankedIds: ['p-3', 'p-1'] })] as never, mine as never)
    assert.deepEqual(found.map((entry) => [entry.priority.id, entry.character.id, entry.position, entry.phaseNo]), [['b', 'p-3', 1, 2], ['b', 'p-1', 2, 2], ['a', 'p-1', 1, 0]])
  })
  it('still finds a line that has a name only, by the first name', () => {
    const found = myPriorities([{ id: 'x', item: 'Old', encounter: '', councilNote: '', rankedPlayers: ['vex'] }] as never, mine as never)
    assert.deepEqual(found.map((entry) => entry.character.id), ['p-3'])
  })
  it('finds awards by recipient id, or by name when an award has none', () => {
    const awards = [award('Morrow', { recipientId: 'p-1' }), award('Vex'), award('Aurelia', { recipientId: 'p-2' }), award('Morrow')] as never[]
    assert.equal(myAwards(awards, mine as never).length, 2)
  })
  it('does not list a removed award as loot received', () => {
    const awards = [award('Morrow', { recipientId: 'p-1' }), award('Morrow', { recipientId: 'p-1', status: 'removed' }), award('Vex', { status: 'active' })] as never[]
    assert.equal(myAwards(awards, mine as never).length, 2)
  })
})

describe('carrying over a priority with ids', () => {
  it('copies the ids with the names, so a character stays that character and a note stays a note', () => {
    const fields = carryOverFields({ id: 'pr1', item: 'Ring', encounter: '', rankedPlayers: ['Morrow', 'Any warlock', 'Old idea'], rankedIds: ['p-1', '', '!'], councilNote: '' }, 1)
    assert.deepEqual(fields.rankedPlayers, ['Morrow', 'Any warlock', 'Old idea'])
    assert.deepEqual((fields as { rankedIds?: string[] }).rankedIds, ['p-1', '', '!'])
  })
  it('copies no ids for a priority that has none, and drops ids that do not line up', () => {
    assert.equal('rankedIds' in carryOverFields({ id: 'a', item: 'x', encounter: '', rankedPlayers: ['Morrow'], councilNote: '' }, 1), false)
    assert.equal('rankedIds' in carryOverFields({ id: 'a', item: 'x', encounter: '', rankedPlayers: ['Morrow', 'Vex'], rankedIds: ['p-1'], councilNote: '' }, 1), false)
  })
})

describe('the Log in words', () => {
  const phaseName = (no: number) => `Phase ${no}`
  const entry = (overrides: Partial<AuditEntry>): AuditEntry => ({ id: 'x', at: null, by: 'uid', byName: 'A Leader', targetType: 'priority', targetId: 'pr1', rev: 1, action: 'edit', item: 'Ring', changed: [], before: {}, after: {}, reason: '', ...overrides })
  it('shows candidate lines as names with a note marked, and a finished note as finished', () => {
    assert.equal(showLines(['Morrow', 'Any warlock', 'Old idea'], ['p-1', '', '!']), 'Morrow, note: Any warlock, note: Old idea (finished)')
    assert.equal(showLines(['Morrow'], undefined), 'Morrow')
    assert.equal(showLines([], undefined), '(nobody)')
  })
  it('does not show the ids of a change to the candidates, only the names', () => {
    const text = describeEntry(entry({ changed: ['rankedPlayers', 'rankedIds'], before: { rankedPlayers: ['Morrow', 'Any warlock'], rankedIds: ['p-1', ''] }, after: { rankedPlayers: ['Morrow', 'Vex', 'Any warlock'], rankedIds: ['p-1', 'p-3', ''] } }), phaseName)
    assert.deepEqual(text.details, ['Candidates: Morrow, note: Any warlock \u2192 Morrow, Vex, note: Any warlock'])
  })
  it('says what a change of the ids alone is', () => {
    const only = (before: unknown, after: unknown) => describeEntry(entry({ changed: ['rankedIds'], before: { rankedIds: before }, after: { rankedIds: after } }), phaseName).details
    assert.deepEqual(only(null, ['p-1']), ['Linked the candidates to the roster'])
    assert.deepEqual(only(['p-1', ''], ['p-1', '!']), ['Finished a note'])
    assert.deepEqual(only(['p-1', '!'], ['p-1', '']), ['Reopened a note'])
    assert.deepEqual(only(['p-1', 'p-2'], ['p-2', 'p-1']), ['Changed the candidate lines'])
  })
  it('hides the recipient id and the snapshot ids of an award', () => {
    const text = describeEntry(entry({ targetType: 'award', action: 'create', changed: ['item', 'recipient', 'recipientId', 'prioritySnapshot', 'prioritySnapshotIds'], after: { item: 'Ring', recipient: 'Vex', recipientId: 'p-3', prioritySnapshot: ['Morrow', 'Any warlock'], prioritySnapshotIds: ['p-1', ''] } }), phaseName)
    assert.deepEqual(text.details, ['Candidates at the time: Morrow, note: Any warlock'])
    assert.equal(text.title, 'Awarded \u201cRing\u201d to Vex')
  })
})
