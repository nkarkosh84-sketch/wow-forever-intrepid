import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import type { AuditEntry } from '../../src/shared/game/lootAudit.ts'
import { describeEntry, showValue } from '../../src/features/loot/auditText.ts'

// Invented names.
const entry = (overrides: Partial<AuditEntry>): AuditEntry => ({ id: 'x', at: null, by: 'uid', byName: 'A Leader', targetType: 'priority', targetId: 'p1', rev: 1, action: 'edit', item: 'Test Sword', changed: [], before: {}, after: {}, reason: '', ...overrides })
const phaseName = (no: number) => (no === 0 ? 'Launch' : no === 1 ? 'Second' : `Phase ${no}`)
const text = (overrides: Partial<AuditEntry>) => describeEntry(entry(overrides), phaseName)

describe('showValue', () => {
  it('reads a list as names, an empty list as nobody, nothing as none, an empty text as empty', () => {
    assert.equal(showValue('rankedPlayers', ['Aria', 'Brock'], phaseName), 'Aria, Brock')
    assert.equal(showValue('rankedPlayers', [], phaseName), '(nobody)')
    assert.equal(showValue('itemId', null, phaseName), '(none)')
    assert.equal(showValue('councilNote', '  ', phaseName), '(empty)')
  })
  it('names a phase by its number', () => {
    assert.equal(showValue('phaseNo', 1, phaseName), 'Second')
    assert.equal(showValue('itemId', 1, phaseName), '1')
  })
  it('shortens a very long text', () => {
    const shown = showValue('councilNote', 'x'.repeat(500), phaseName)
    assert.equal(shown.length, 160)
    assert.ok(shown.endsWith('\u2026'))
  })
})

describe('describeEntry for a phase', () => {
  const phase = (overrides: Partial<AuditEntry>) => text({ targetType: 'phase', targetId: 'settings', item: 'Second', ...overrides })
  it('says a phase was started, which phase closed and what changed', () => {
    const { title, details } = phase({ action: 'start', changed: ['currentPhase', 'phaseHistory'], before: { currentPhase: 'Launch', phaseHistory: null }, after: { currentPhase: 'Second', phaseHistory: ['Launch'] } })
    assert.equal(title, 'Started \u201cSecond\u201d')
    assert.deepEqual(details, ['\u201cLaunch\u201d is closed and read-only', 'Current phase: Launch \u2192 Second', 'Finished phases: (none) \u2192 Launch'])
  })
  it('says a phase was reopened and which one is the next phase again', () => {
    const { title, details } = phase({ action: 'reopen', item: 'Launch', changed: ['currentPhase', 'nextPhase', 'phaseHistory'], before: { currentPhase: 'Second', nextPhase: 'To be announced', phaseHistory: ['Launch'] }, after: { currentPhase: 'Launch', nextPhase: 'Second', phaseHistory: null } })
    assert.equal(title, 'Reopened \u201cLaunch\u201d')
    assert.equal(details[0], '\u201cSecond\u201d is the next phase again')
    assert.ok(details.includes('Finished phases: Launch \u2192 (none)'))
  })
  it('still reads an entry with nothing in it', () => {
    assert.equal(phase({ action: 'start', after: {} }).title, 'Started \u201cSecond\u201d')
  })
  // RAID-019: the start dates, one line per phase whose date changed.
  it('says which phase got a start date, and which date changed or went', () => {
    const set = phase({ action: 'edit', changed: ['phaseStarts'], before: { phaseStarts: null }, after: { phaseStarts: ['', '2026-08-30'] } })
    assert.equal(set.title, 'Set the start date of \u201cSecond\u201d')
    assert.deepEqual(set.details, ['Start of \u201cSecond\u201d: (none) \u2192 Aug 30, 2026'])
    const moved = phase({ action: 'edit', changed: ['phaseStarts'], before: { phaseStarts: ['', '2026-08-30'] }, after: { phaseStarts: ['', '2026-08-31'] } })
    assert.equal(moved.title, 'Changed the start date of \u201cSecond\u201d')
    assert.deepEqual(moved.details, ['Start of \u201cSecond\u201d: Aug 30, 2026 \u2192 Aug 31, 2026'])
    const gone = phase({ action: 'edit', changed: ['phaseStarts'], before: { phaseStarts: ['2026-06-01', '2026-08-30'] }, after: { phaseStarts: ['2026-06-01'] } })
    assert.equal(gone.title, 'Removed the start date of \u201cSecond\u201d')
    assert.deepEqual(gone.details, ['Start of \u201cSecond\u201d: Aug 30, 2026 \u2192 (none)'])
  })
  it('lists every date a change moved when it moved more than one', () => {
    const { title, details } = phase({ action: 'edit', changed: ['phaseStarts'], before: { phaseStarts: null }, after: { phaseStarts: ['2026-06-01', '', '2026-10-09'] } })
    assert.equal(title, 'Changed the start dates of the loot phases')
    assert.deepEqual(details, ['Start of \u201cLaunch\u201d: (none) \u2192 Jun 1, 2026', 'Start of \u201cPhase 2\u201d: (none) \u2192 Oct 9, 2026'])
  })
  it('gives the start date a start records, and the one a reopen takes away, after the other changes', () => {
    const started = phase({ action: 'start', changed: ['currentPhase', 'phaseHistory', 'phaseStarts'], before: { currentPhase: 'Launch', phaseHistory: null, phaseStarts: null }, after: { currentPhase: 'Second', phaseHistory: ['Launch'], phaseStarts: ['', '2026-10-29'] } })
    assert.equal(started.title, 'Started \u201cSecond\u201d')
    assert.deepEqual(started.details, ['\u201cLaunch\u201d is closed and read-only', 'Current phase: Launch \u2192 Second', 'Finished phases: (none) \u2192 Launch', 'Start of \u201cSecond\u201d: (none) \u2192 Oct 29, 2026'])
    const reopened = phase({ action: 'reopen', item: 'Launch', changed: ['currentPhase', 'phaseHistory', 'phaseStarts'], before: { currentPhase: 'Second', phaseHistory: ['Launch'], phaseStarts: ['', '2026-10-29'] }, after: { currentPhase: 'Launch', phaseHistory: null, phaseStarts: null } })
    assert.equal(reopened.details.at(-1), 'Start of \u201cSecond\u201d: Oct 29, 2026 \u2192 (none)')
    assert.equal(reopened.details.some((line) => line.startsWith('Start dates:')), false)
  })
})

describe('describeEntry', () => {
  it('says a priority was added, with the fields it started with', () => {
    const { title, details } = text({ action: 'create', changed: ['item', 'rankedPlayers', 'phaseNo'], after: { item: 'Test Sword', rankedPlayers: [], phaseNo: 1 } })
    assert.equal(title, 'Added \u201cTest Sword\u201d to the list')
    assert.deepEqual(details, ['Item: Test Sword', 'Candidates: (nobody)', 'Phase: Second'])
  })
  it('says a priority was removed, with what it had', () => {
    const { title, details } = text({ action: 'delete', changed: ['rankedPlayers'], before: { rankedPlayers: ['Aria'] } })
    assert.equal(title, 'Removed \u201cTest Sword\u201d from the list')
    assert.deepEqual(details, ['Candidates: Aria'])
  })
  it('shows a reorder as the list before and after', () => {
    const { title, details } = text({ action: 'reorder', changed: ['rankedPlayers'], before: { rankedPlayers: ['Aria', 'Brock'] }, after: { rankedPlayers: ['Brock', 'Aria'] } })
    assert.equal(title, 'Reordered the candidates for \u201cTest Sword\u201d')
    assert.deepEqual(details, ['Before: Aria, Brock', 'After: Brock, Aria'])
  })
  it('shows an edit as each changed field, old value to new value', () => {
    const { title, details } = text({ changed: ['councilNote', 'itemId'], before: { councilNote: '', itemId: null }, after: { councilNote: 'Healer first', itemId: 101 } })
    assert.equal(title, 'Changed \u201cTest Sword\u201d')
    assert.deepEqual(details, ['Council note: (empty) \u2192 Healer first', 'Item id: (none) \u2192 101'])
  })
  it('says a priority was taken off the list and kept, and put back', () => {
    assert.equal(text({ changed: ['hidden'], before: { hidden: null }, after: { hidden: true } }).title, 'Took \u201cTest Sword\u201d off the list (its priorities are kept)')
    const back = text({ changed: ['hidden'], before: { hidden: true }, after: { hidden: null } })
    assert.equal(back.title, 'Put \u201cTest Sword\u201d back on the list')
    assert.deepEqual(back.details, [])
  })
  it('still shows what else changed with it', () => {
    assert.deepEqual(text({ changed: ['hidden', 'councilNote'], before: { hidden: null, councilNote: '' }, after: { hidden: true, councilNote: 'Parked' } }).details, ['Council note: (empty) \u2192 Parked'])
  })
  it('says who got an award, and what else was recorded with it', () => {
    const { title, details } = text({ targetType: 'award', action: 'create', changed: ['priorityId', 'item', 'recipient', 'awardedAt', 'awardNote', 'phaseNo'], after: { priorityId: 'p1', item: 'Test Sword', recipient: 'Aria', awardedAt: '2026-12-09', awardNote: '', phaseNo: 0 } })
    assert.equal(title, 'Awarded \u201cTest Sword\u201d to Aria')
    assert.deepEqual(details, ['Award date: 2026-12-09', 'Award note: (empty)', 'Phase: Launch'])
  })
  it('says an award was corrected or removed, with the reason', () => {
    assert.deepEqual(text({ targetType: 'award', changed: ['awardNote'], before: { awardNote: '' }, after: { awardNote: 'Rolled' } }), { title: 'Corrected the award of \u201cTest Sword\u201d', details: ['Award note: (empty) \u2192 Rolled'] })
    assert.deepEqual(text({ targetType: 'award', changed: ['recipient'], before: { recipient: 'Aria' }, after: { recipient: 'Brock' } }), { title: 'Moved the award of \u201cTest Sword\u201d from Aria to Brock', details: [] })
    const removed = text({ targetType: 'award', action: 'remove', changed: ['status', 'removedReason'], before: { status: null }, after: { status: 'removed' }, reason: 'Entered twice' })
    assert.equal(removed.title, 'Removed the award of \u201cTest Sword\u201d')
    assert.deepEqual(removed.details, ['Reason: Entered twice'])
  })
  it('says the pre-launch data was erased, once, with what was erased', () => {
    const { title, details } = text({ targetType: 'ledger', targetId: 'launch-reset', action: 'erase', item: 'Launch prep', changed: ['awards', 'priorities', 'auditEntries'], before: { phaseNo: 0, awards: 12, priorities: 30, auditEntries: 80 }, reason: 'The pre-launch test data was erased once, when the first real phase started.' })
    assert.equal(title, 'Erased the test data of “Launch prep”, once, for good')
    assert.deepEqual(details, ['12 awards, 30 loot priorities and 80 Log entries about them were erased, and the guild was sealed: this cannot be done again.', 'Reason: The pre-launch test data was erased once, when the first real phase started.'])
  })
  it('reads an erase entry with no numbers as zero erased, and does not break', () => {
    assert.match(text({ targetType: 'ledger', action: 'erase', item: 'Launch prep' }).details[0] ?? '', /^0 awards, 0 loot priorities and 0 Log entries/)
  })
  it('says a receipt was moved, from whom to whom, with the reason', () => {
    const moved = text({ targetType: 'award', changed: ['recipient', 'recipientId'], before: { recipient: 'Aria', recipientId: 'p-1' }, after: { recipient: 'Brock', recipientId: 'p-2' }, reason: 'Recorded to the wrong character' })
    assert.equal(moved.title, 'Moved the award of “Test Sword” from Aria to Brock')
    assert.deepEqual(moved.details, ['Reason: Recorded to the wrong character'])
    // A change of the date alongside it is still listed; a change that is not of the recipient is a plain correction.
    assert.deepEqual(text({ targetType: 'award', changed: ['recipient', 'awardedAt'], before: { recipient: 'Aria', awardedAt: '2026-12-09' }, after: { recipient: 'Brock', awardedAt: '2026-12-10' } }).details, ['Award date: 2026-12-09 → 2026-12-10'])
    assert.equal(text({ targetType: 'award', changed: ['awardNote'], before: { awardNote: '' }, after: { awardNote: 'x' } }).title, 'Corrected the award of “Test Sword”')
  })
  it('names who a removed or restored award was for, when the Log can say', () => {
    const lookups = { awardRecipient: (id: string) => (id === 'a1' ? 'Aria' : undefined) }
    const removed = describeEntry(entry({ targetType: 'award', targetId: 'a1', action: 'remove', changed: ['status', 'removedReason'], before: { status: null }, after: { status: 'removed' }, reason: 'Entered twice' }), phaseName, lookups)
    assert.equal(removed.title, 'Removed the award of “Test Sword” to Aria')
    const restored = describeEntry(entry({ targetType: 'award', targetId: 'a1', changed: ['status', 'removedReason'], before: { status: 'removed', removedReason: 'Entered twice' }, after: { status: 'active', removedReason: null } }), phaseName, lookups)
    assert.equal(restored.title, 'Restored the award of “Test Sword” to Aria')
    assert.deepEqual(restored.details, ['It was removed because: Entered twice'])
    assert.equal(describeEntry(entry({ targetType: 'award', targetId: 'zz', action: 'remove', changed: ['status'], reason: 'x' }), phaseName, lookups).title, 'Removed the award of “Test Sword”')
  })
  it('says how a manual award was decided, and records it as an award with no priority', () => {
    const { title, details } = text({ targetType: 'award', action: 'create', changed: ['item', 'encounter', 'recipient', 'recipientId', 'awardedAt', 'awardNote', 'decision', 'phaseNo'], after: { item: 'Test Sword', encounter: 'Test Hall \u00b7', recipient: 'Aria', recipientId: 'p-1', awardedAt: '2026-12-09', awardNote: 'Both rolled', decision: 'roll', phaseNo: 1 } })
    assert.equal(title, 'Awarded \u201cTest Sword\u201d to Aria')
    assert.deepEqual(details, ['Dungeon and boss: Test Hall', 'Award date: 2026-12-09', 'Award note: Both rolled', 'Decision: Roll', 'Phase: Second'])
    assert.equal(showValue('decision', 'council', phaseName), 'Council')
    assert.equal(showValue('decision', '', phaseName), '(empty)')
  })
  it('reads a dungeon recorded with no boss ("Dungeon \u00b7") as the dungeon, and leaves a dungeon and boss alone', () => {
    assert.equal(showValue('encounter', 'Test Hall \u00b7', phaseName), 'Test Hall')
    assert.equal(showValue('encounter', 'Test Hall \u00b7 ', phaseName), 'Test Hall')
    assert.equal(showValue('encounter', 'Test Hall \u00b7 Hall Warden', phaseName), 'Test Hall \u00b7 Hall Warden')
    assert.equal(showValue('encounter', 'Hall Warden', phaseName), 'Hall Warden')
    assert.equal(showValue('encounter', '', phaseName), '(empty)')
    assert.equal(showValue('encounter', '\u00b7', phaseName), '(empty)')
  })
  it('does not break on an entry it does not know, or an item with no name', () => {
    assert.equal(text({ targetType: 'raid', action: 'cancel', item: '' }).title, 'cancel raid \u201cUntitled\u201d')
    assert.equal(text({ action: 'create', item: '' }).title, 'Added \u201cUntitled\u201d to the list')
  })
})

describe('describeEntry for a drop list', () => {
  const LAIR = 60000001
  const firstZone = new Map([[LAIR, 2]])
  const firstSource = new Map([[`${LAIR}_cabc`, 2]])
  const lookups = {
    zoneName: (id: number) => (id === 900 ? 'Test Hollow' : id === LAIR ? 'Guild Lair' : undefined),
    itemName: (id: number) => (id === 104 ? 'Iron Ring' : undefined),
    firstZonePhase: (id: number) => firstZone.get(id),
    firstSourcePhase: (id: number, key: string) => firstSource.get(`${id}_${key}`),
  }
  const table = (overrides: Partial<AuditEntry>) => describeEntry(entry({ targetType: 'table', targetId: 's900_npc11_2', item: 'First Warden', ...overrides }), phaseName, lookups)
  const warden = '\u201cFirst Warden\u201d in \u201cTest Hollow\u201d (Phase 2)'

  it('a new zone and a new creature are read as additions in the phase they were made', () => {
    const zone = table({ targetId: `z${LAIR}_2`, item: 'Guild Lair', action: 'create', changed: ['type', 'zoneId', 'phaseNo', 'name', 'kind', 'players'], after: { type: 'zone', zoneId: LAIR, phaseNo: 2, name: 'Guild Lair', kind: 'raid', players: 25 } })
    assert.equal(zone.title, 'Added the zone \u201cGuild Lair\u201d (Phase 2)')
    assert.deepEqual(zone.details, ['Kind: raid', 'Players: 25'])
    const creature = table({ targetId: `s${LAIR}_cabc_2`, item: 'Lair Boss', action: 'create', changed: ['name', 'itemIds'], after: { name: 'Lair Boss', itemIds: [601, 602] } })
    assert.equal(creature.title, 'Added \u201cLair Boss\u201d to \u201cGuild Lair\u201d (Phase 2)')
    assert.deepEqual(creature.details, ['Items: 601, 602'])
    const named = table({ targetId: `s${LAIR}_cabc_2`, item: 'Lair Boss', action: 'create', changed: ['type', 'zoneId', 'key', 'phaseNo', 'name', 'kind', 'npcId', 'order', 'itemIds', 'hiddenItemIds'], after: { type: 'source', zoneId: LAIR, key: 'cabc', phaseNo: 2, name: 'Lair Boss', kind: 'boss', npcId: 90001, order: 10, itemIds: [], hiddenItemIds: [] } })
    assert.deepEqual(named.details, ['Kind: boss', 'Creature id: 90001'])
  })

  it('a later phase\'s first document for the same creature is a change to it, not an addition', () => {
    const later = table({ targetId: `s${LAIR}_cabc_4`, item: 'Lair Boss', action: 'create', changed: ['name', 'itemIds', 'hiddenItemIds'], after: { name: 'Lair Boss', itemIds: [700], hiddenItemIds: [] } })
    assert.equal(later.title, 'Added 1 item to \u201cLair Boss\u201d in \u201cGuild Lair\u201d (Phase 4)')
  })

  it('the first change to a creature of a built-in zone creates its document, and reads as the change it is', () => {
    const first = table({ action: 'create', changed: ['type', 'zoneId', 'key', 'phaseNo', 'itemIds', 'hiddenItemIds'], after: { type: 'source', zoneId: 900, key: 'npc11', phaseNo: 2, itemIds: [104], hiddenItemIds: [] } })
    assert.equal(first.title, `Added 1 item to ${warden}`)
    assert.deepEqual(first.details, ['Added: Iron Ring (104)'])
    const off = table({ action: 'create', changed: ['type', 'itemIds', 'hiddenItemIds'], after: { type: 'source', itemIds: [], hiddenItemIds: [102] } })
    assert.equal(off.title, `Took 1 item off ${warden}`)
    assert.deepEqual(off.details, ['Taken off from here on: 102'])
    const wide = table({ targetId: 's900_zonewide_3', item: 'Any creature in the zone', action: 'create', changed: ['itemIds'], after: { itemIds: [905] } })
    assert.equal(wide.title, 'Added 1 item to \u201cAny creature in the zone\u201d in \u201cTest Hollow\u201d (Phase 3)')
  })

  it('items added to a creature are counted, and named where the name is known', () => {
    const added = table({ action: 'edit', changed: ['itemIds'], before: { itemIds: [101] }, after: { itemIds: [101, 104, 105] } })
    assert.equal(added.title, `Added 2 items to ${warden}`)
    assert.deepEqual(added.details, ['Added: Iron Ring (104), 105'])
  })

  it('items taken off (a phase\'s own addition taken back, or an older item taken off from here on) and brought back each say so', () => {
    assert.equal(table({ changed: ['itemIds'], before: { itemIds: [1, 2] }, after: { itemIds: [1] } }).title, `Took 1 item off ${warden}`)
    const off = table({ changed: ['hiddenItemIds'], before: { hiddenItemIds: [] }, after: { hiddenItemIds: [102, 103] } })
    assert.equal(off.title, `Took 2 items off ${warden}`)
    assert.deepEqual(off.details, ['Taken off from here on: 102, 103'])
    const back = table({ changed: ['hiddenItemIds'], before: { hiddenItemIds: [102] }, after: { hiddenItemIds: [] } })
    assert.equal(back.title, `Brought back 1 item of ${warden}`)
  })

  it('one edit that brings an item back and adds another says both, with the other fields after', () => {
    const both = table({ changed: ['itemIds', 'hiddenItemIds', 'order'], before: { itemIds: [], hiddenItemIds: [102], order: 10 }, after: { itemIds: [900], hiddenItemIds: [], order: 20 } })
    assert.equal(both.title, `Added 1 item to ${warden}`)
    assert.deepEqual(both.details, ['Added: 900', 'Brought back: 102', 'Place in the order: 10 \u2192 20'])
  })

  it('a document made only to move a creature lists the place, and one that also takes an item off lists both', () => {
    const moved = table({ action: 'create', changed: ['type', 'zoneId', 'key', 'phaseNo', 'order', 'itemIds', 'hiddenItemIds'], after: { type: 'source', order: 20, itemIds: [], hiddenItemIds: [] } })
    assert.equal(moved.title, `Changed ${warden}`)
    assert.deepEqual(moved.details, ['Place in the order: 20'])
    const both = table({ action: 'create', changed: ['type', 'order', 'itemIds', 'hiddenItemIds'], after: { type: 'source', order: 20, itemIds: [], hiddenItemIds: [102] } })
    assert.equal(both.title, `Took 1 item off ${warden}`)
    assert.deepEqual(both.details, ['Taken off from here on: 102', 'Place in the order: 20'])
  })

  it('a rename is listed with what it was, and a removal also lists what else the document changed', () => {
    const renamed = table({ changed: ['name'], before: { name: 'First Warden' }, after: { name: 'Warden One' } })
    assert.deepEqual(renamed.details, ['Name: First Warden \u2192 Warden One'])
    const gone = table({ targetId: `s${LAIR}_cabc_3`, item: 'Lair Boss', changed: ['removed', 'hiddenItemIds', 'name'], before: { name: 'Lair Boss', hiddenItemIds: [] }, after: { removed: true, hiddenItemIds: [601], name: 'Lair Boss II' } })
    assert.equal(gone.title, 'Took \u201cLair Boss\u201d out of \u201cGuild Lair\u201d from here on (Phase 3)')
    assert.deepEqual(gone.details, ['Taken off from here on: 601', 'Name: Lair Boss \u2192 Lair Boss II'])
  })

  it('a document that sets no name is named from the lists, and a document that takes removed away says the phase follows the earlier one again', () => {
    const named = describeEntry(entry({ targetType: 'table', targetId: 's900_npc11_2', item: '', changed: ['itemIds'], before: { itemIds: [] }, after: { itemIds: [104] } }), phaseName, { ...lookups, sourceName: () => 'First Warden' })
    assert.equal(named.title, `Added 1 item to ${warden}`)
    assert.equal(table({ targetId: `s${LAIR}_cabc_3`, item: '', changed: ['removed'], before: { removed: true }, after: { removed: null } }).title, 'Made \u201ca creature\u201d in \u201cGuild Lair\u201d follow the earlier phase again (Phase 3)')
    assert.equal(table({ targetId: 'z900_3', item: '', changed: ['removed'], before: { removed: true }, after: { removed: null } }).title, 'Made \u201cTest Hollow\u201d follow the earlier phase again (Phase 3)')
  })

  it('taking a creature or a zone out of the lists from a phase, and putting it back', () => {
    assert.equal(table({ targetId: `s${LAIR}_cabc_3`, item: 'Lair Boss', action: 'create', changed: ['removed'], after: { removed: true } }).title, 'Took \u201cLair Boss\u201d out of \u201cGuild Lair\u201d from here on (Phase 3)')
    assert.equal(table({ targetId: `s${LAIR}_cabc_3`, item: 'Lair Boss', changed: ['removed'], before: { removed: true }, after: { removed: false } }).title, 'Put \u201cLair Boss\u201d back in \u201cGuild Lair\u201d (Phase 3)')
    assert.equal(table({ targetId: `z${LAIR}_3`, item: 'Guild Lair', action: 'create', changed: ['removed'], after: { removed: true } }).title, 'Took the zone \u201cGuild Lair\u201d out of the lists (Phase 3)')
    assert.equal(table({ targetId: `z${LAIR}_3`, item: 'Guild Lair', changed: ['name'], before: { name: 'Guild Lair' }, after: { name: 'The Lair' } }).title, 'Changed the zone \u201cGuild Lair\u201d (Phase 3)')
  })

  it('a zone of the built-in lists has no name in its entry, so it is named from the capture', () => {
    const out = table({ targetId: 'z900_2', item: '', action: 'create', changed: ['type', 'zoneId', 'phaseNo', 'removed'], after: { type: 'zone', zoneId: 900, phaseNo: 2, removed: true } })
    assert.equal(out.title, 'Took the zone \u201cTest Hollow\u201d out of the lists (Phase 2)')
    const back = table({ targetId: 'z900_3', item: '', action: 'edit', changed: ['removed'], before: { removed: true }, after: { removed: false } })
    assert.equal(back.title, 'Put the zone \u201cTest Hollow\u201d back in the lists (Phase 3)')
    const ticked = table({ targetId: 'z900_2', item: '', action: 'create', changed: ['type', 'zoneId', 'phaseNo', 'removed'], after: { type: 'zone', zoneId: 900, phaseNo: 2, removed: false } })
    assert.equal(ticked.title, 'Put the zone \u201cTest Hollow\u201d in the lists (Phase 2)') // first time in this phase: not "back"
  })

  it('the document of a phase says which phase it follows, or that it follows nothing', () => {
    const made = table({ targetId: 'p2', item: '', action: 'create', changed: ['type', 'phaseNo', 'follows'], after: { type: 'phase', phaseNo: 2, follows: 1 } })
    assert.equal(made.title, 'Phase 2 now follows Second')
    assert.deepEqual(made.details, [])
    const moved = table({ targetId: 'p3', item: '', changed: ['follows'], before: { follows: 1 }, after: { follows: 2 } })
    assert.equal(moved.title, 'Phase 3 now follows Phase 2')
    assert.deepEqual(moved.details, ['It followed Second'])
    const stopped = table({ targetId: 'p3', item: '', changed: ['follows'], before: { follows: 2 }, after: { follows: null } })
    assert.equal(stopped.title, 'Phase 3 now follows nothing')
    assert.deepEqual(stopped.details, ['It followed Phase 2'])
  })

  it('a zone it cannot name is called "a zone"', () => {
    assert.equal(table({ targetId: 's777_c1_2', changed: ['name'], before: { name: 'Old' }, after: { name: 'First Warden' } }).title, 'Changed \u201cFirst Warden\u201d in \u201ca zone\u201d (Phase 2)')
  })
})
