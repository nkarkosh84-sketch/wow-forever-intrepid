import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { entryPhase, phasesFromEntries, tableDocPhase, type PhaseLookups } from '../../src/features/loot/entryPhase.ts'
import { logFilterActive, matchesLogFilter, noLogFilter, type LogFacts } from '../../src/features/loot/logFilters.ts'

// Invented names.
const entry = (overrides: Record<string, unknown>) => ({ targetType: 'priority', targetId: 'p1', rev: 1, action: 'edit', changed: [], before: {}, after: {}, ...overrides }) as Parameters<typeof entryPhase>[0]
const none: PhaseLookups = { awardPhase: () => undefined, priorityPhase: () => undefined, fromEntries: () => undefined }
const lookups = (overrides: Partial<PhaseLookups>): PhaseLookups => ({ ...none, ...overrides })

describe('tableDocPhase', () => {
  it('reads the phase from the id of a drop list document', () => {
    assert.equal(tableDocPhase('p3'), 3)
    assert.equal(tableDocPhase('z50000001_2'), 2)
    assert.equal(tableDocPhase('s36_npc4421_1'), 1)
    assert.equal(tableDocPhase('s36_cabc_def_4'), 4)
  })
  it('is none for an id that has no phase', () => {
    assert.equal(tableDocPhase('settings'), undefined)
    assert.equal(tableDocPhase('z50000001'), undefined)
  })
})

describe('entryPhase for a phase started or reopened', () => {
  it('is the phase the guild is in afterwards: the number of finished phases it lists', () => {
    assert.equal(entryPhase(entry({ targetType: 'phase', action: 'start', changed: ['phaseHistory'], after: { phaseHistory: ['Launch prep'] } }), none), 1)
    assert.equal(entryPhase(entry({ targetType: 'phase', action: 'start', changed: ['phaseHistory'], after: { phaseHistory: ['Launch prep', 'Second'] } }), none), 2)
  })
  it('is the first phase when a reopen takes the history away', () => {
    assert.equal(entryPhase(entry({ targetType: 'phase', action: 'reopen', changed: ['phaseHistory'], before: { phaseHistory: ['Launch prep'] }, after: { phaseHistory: null } }), none), 0)
  })
  it('is none for an entry that does not say', () => {
    assert.equal(entryPhase(entry({ targetType: 'phase', action: 'start' }), none), undefined)
  })
  it('is the phase whose start date a change of the dates set, changed or took away, and none when it moved several (RAID-019)', () => {
    const dates = (before: unknown, after: unknown) => entry({ targetType: 'phase', targetId: 'settings', action: 'edit', changed: ['phaseStarts'], before: { phaseStarts: before }, after: { phaseStarts: after } })
    assert.equal(entryPhase(dates(null, ['', '2026-08-30']), none), 1)
    assert.equal(entryPhase(dates(['', '2026-08-30'], ['', '2026-08-31']), none), 1)
    assert.equal(entryPhase(dates(['2026-06-01', '2026-08-30'], ['2026-06-01']), none), 1)
    assert.equal(entryPhase(dates(null, ['2026-06-01', '2026-08-30']), none), undefined)
  })
  it('is still the phase the guild is in for a start that records a date', () => {
    assert.equal(entryPhase(entry({ targetType: 'phase', action: 'start', changed: ['phaseHistory', 'phaseStarts'], after: { phaseHistory: ['Launch prep'], phaseStarts: ['', '2026-10-29'] } }), none), 1)
  })
})

describe('entryPhase for a drop list change', () => {
  it('is the phase in the document id', () => {
    assert.equal(entryPhase(entry({ targetType: 'table', targetId: 'z50000001_2' }), none), 2)
    assert.equal(entryPhase(entry({ targetType: 'table', targetId: 'p3' }), none), 3)
  })
})

describe('entryPhase for an award', () => {
  it('is the phase the award has now, even when the entry lists no phase', () => {
    assert.equal(entryPhase(entry({ targetType: 'award', targetId: 'a1', changed: ['recipient'] }), lookups({ awardPhase: (id) => (id === 'a1' ? 2 : undefined) })), 2)
  })
  it('falls back to what the entries about it say', () => {
    assert.equal(entryPhase(entry({ targetType: 'award', targetId: 'a1' }), lookups({ fromEntries: (key) => (key === 'award:a1' ? 1 : undefined) })), 1)
  })
  it('is the first phase for an award from before the Log began that has none, and none for another that is unknown', () => {
    assert.equal(entryPhase(entry({ targetType: 'award', targetId: 'a1', rev: 0 }), none), 0)
    assert.equal(entryPhase(entry({ targetType: 'award', targetId: 'a1', rev: 2 }), none), undefined)
  })
})

describe('entryPhase for a priority', () => {
  it('is the phase the priority has now', () => {
    assert.equal(entryPhase(entry({ changed: ['councilNote'] }), lookups({ priorityPhase: (id) => (id === 'p1' ? 1 : undefined) })), 1)
  })
  it('is told from its other entries when the priority is gone', () => {
    const all = [
      entry({ targetId: 'gone', action: 'create', rev: 1, after: { item: 'Hat', phaseNo: 2 } }),
      entry({ targetId: 'gone', action: 'edit', rev: 2, changed: ['councilNote'] }),
      entry({ targetId: 'gone', action: 'delete', rev: 3, before: { item: 'Hat', phaseNo: 2 } }),
    ]
    const known = phasesFromEntries(all)
    assert.deepEqual(all.map((one) => entryPhase(one, lookups({ fromEntries: (key) => known.get(key) }))), [2, 2, 2])
  })
  it('is none when nothing says', () => {
    assert.equal(entryPhase(entry({ targetId: 'gone', changed: ['councilNote'] }), none), undefined)
  })
})

describe('phasesFromEntries', () => {
  it('reads a create entry with no phase as the first phase, as an award or a priority with none is', () => {
    const known = phasesFromEntries([entry({ targetId: 'old', action: 'create', after: { item: 'Hat' } }), entry({ targetType: 'award', targetId: 'a9', action: 'create', after: { item: 'Hat' } })])
    assert.equal(known.get('priority:old'), 0)
    assert.equal(known.get('award:a9'), 0)
  })
  it('keeps a listed phase over the first-phase default, whatever the order', () => {
    const create = entry({ targetId: 'x', action: 'create', after: { item: 'Hat' } })
    const edit = entry({ targetId: 'x', action: 'edit', rev: 2, changed: ['phaseNo'], before: { phaseNo: 3 }, after: { phaseNo: 3 } })
    assert.equal(phasesFromEntries([create, edit]).get('priority:x'), 3)
    assert.equal(phasesFromEntries([edit, create]).get('priority:x'), 3)
  })
  it('says nothing about a drop list or phase entry, or a priority it only has an edit of', () => {
    const known = phasesFromEntries([entry({ targetType: 'table', targetId: 'p3' }), entry({ targetType: 'phase', targetId: 'settings' }), entry({ targetId: 'y', changed: ['councilNote'] })])
    assert.equal(known.size, 0)
  })
})

describe('the phase filter', () => {
  const slotOf = () => undefined
  const facts = (overrides: Partial<LogFacts>): LogFacts => ({ about: 'item', item: 'Iron Ring', encounter: '', players: [], ...overrides })
  it('is active when a phase is chosen', () => {
    assert.equal(logFilterActive(noLogFilter), false)
    assert.ok(logFilterActive({ ...noLogFilter, phase: '0' }))
  })
  it('shows only the entries of that phase, whatever they are about', () => {
    const filter = { ...noLogFilter, phase: '1' }
    assert.ok(matchesLogFilter(facts({ phase: 1 }), filter, slotOf))
    assert.ok(matchesLogFilter(facts({ about: 'phase', phase: 1 }), filter, slotOf))
    assert.ok(matchesLogFilter(facts({ about: 'table', phase: 1 }), filter, slotOf))
    assert.equal(matchesLogFilter(facts({ phase: 0 }), filter, slotOf), false)
  })
  it('chooses the first phase by its number, 0, and leaves out an entry whose phase is not known', () => {
    const filter = { ...noLogFilter, phase: '0' }
    assert.ok(matchesLogFilter(facts({ phase: 0 }), filter, slotOf))
    assert.equal(matchesLogFilter(facts({}), filter, slotOf), false)
  })
  it('combines with the item filters, which a phase or drop list entry still does not pass', () => {
    const filter = { ...noLogFilter, phase: '1', player: 'name:aria' }
    assert.ok(matchesLogFilter(facts({ phase: 1, players: [{ key: 'name:aria', name: 'Aria' }] }), filter, slotOf))
    assert.equal(matchesLogFilter(facts({ phase: 1, players: [] }), filter, slotOf), false)
    assert.equal(matchesLogFilter(facts({ about: 'phase', phase: 1 }), filter, slotOf), false)
  })
})

describe('the launch reset record in the Log (OPS-005)', () => {
  const record = entry({ targetType: 'ledger', targetId: 'launch-reset', action: 'erase', item: 'Launch prep', before: { phaseNo: 0, awards: 12 }, after: { awards: 0 } })
  it('is for no phase, so it shows a dash and matches no phase, and it is found only with no phase chosen', () => {
    assert.equal(entryPhase(record, none), undefined)
    const facts: LogFacts = { about: 'phase', item: '', encounter: '', players: [] }
    assert.ok(matchesLogFilter(facts, noLogFilter, () => undefined))
    assert.equal(matchesLogFilter(facts, { ...noLogFilter, phase: '0' }, () => undefined), false)
  })
})
