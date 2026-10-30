import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { easternDateOf, hasPhaseStarts, isCalendarDate, isPhaseDate, phaseDateLabel, phaseOfDate, phaseStartOf, phaseStartProblem, readPhaseStarts, reopenPhase, startNextPhase, startTodayProblem, withPhaseStart } from '../../src/shared/game/phases.ts'
import { resolveGuildSettings } from '../../src/shared/game/settings.ts'

// RAID-019: the start date of each loot phase. Invented phase names: Launch is phase 0, Second phase 1, Third phase 2 (current), Fourth the next one.
const status = { currentStatusLabel: 'Active', currentStatusTone: 'active', nextStatusLabel: 'Soon', nextStatusTone: 'preparing' }
const guild = (phaseStarts?: string[]) => ({ currentPhase: 'Third', nextPhase: 'Fourth', phaseHistory: ['Launch', 'Second'], ...status, ...(phaseStarts ? { phaseStarts } : {}) })

describe('phaseOfDate', () => {
  const dated = guild(['', '2026-08-30', '2026-10-09'])
  it('places a date in the latest phase that started on or before it: the start day is the new phase, the day before the one before', () => {
    assert.equal(phaseOfDate(dated, '2026-10-09'), 2)
    assert.equal(phaseOfDate(dated, '2026-10-08'), 1)
    assert.equal(phaseOfDate(dated, '2026-08-30'), 1)
    assert.equal(phaseOfDate(dated, '2027-01-15'), 2)
  })
  it('puts a date before the second phase started in the first phase, which has no date', () => {
    assert.equal(phaseOfDate(dated, '2026-08-29'), 0)
    assert.equal(phaseOfDate(dated, '2020-01-01'), 0)
  })
  it('passes over a phase with no date: its days count for the nearest earlier phase that has one', () => {
    const gap = guild(['2026-06-01', '', '2026-10-09'])
    assert.equal(phaseOfDate(gap, '2026-09-01'), 0)
    assert.equal(phaseOfDate(gap, '2026-10-08'), 0)
    assert.equal(phaseOfDate(gap, '2026-10-09'), 2)
  })
  it('cannot place a date before every start when a phase with no date other than the first could hold it', () => {
    const late = guild(['', '', '2026-10-09'])
    assert.equal(phaseOfDate(late, '2026-10-08'), undefined)
    assert.equal(phaseOfDate(late, '2026-10-09'), 2)
  })
  it('cannot place anything when no phase has a date', () => {
    assert.equal(phaseOfDate(guild(), '2026-10-09'), undefined)
    assert.equal(phaseOfDate(guild([]), '2026-10-09'), undefined)
  })
  it('places every date in the only phase of a guild that never closed one, once that phase has a date', () => {
    const single = { currentPhase: 'Launch', nextPhase: 'Second', phaseStarts: ['2026-06-01'] }
    assert.equal(phaseOfDate(single, '2026-06-01'), 0)
    assert.equal(phaseOfDate(single, '2026-05-31'), 0)
    assert.equal(phaseOfDate(single, '2027-01-01'), 0)
    assert.equal(phaseOfDate({ phaseHistory: [] }, '2026-06-01'), undefined)
  })
  it('gives a day two phases start on to the later one', () => {
    const same = guild(['', '2026-10-09', '2026-10-09'])
    assert.equal(phaseOfDate(same, '2026-10-09'), 2)
    assert.equal(phaseOfDate(same, '2026-10-08'), 0)
  })
  it('never gives the next phase, even from a list longer than the phases', () => {
    assert.equal(phaseOfDate(guild(['', '2026-08-30', '2026-10-09', '2026-10-20']), '2026-10-25'), 2)
  })
})

describe('reading the start dates', () => {
  it('reads what the rules accept back unchanged', () => {
    for (const list of [['2026-08-30'], ['', '2026-08-30'], ['2026-06-01', '', '2026-10-09']]) assert.deepEqual(readPhaseStarts(list, 3), list)
  })
  it('reads an entry that is not a date as no date, cuts the list to the phases there are and leaves blanks off the end', () => {
    assert.deepEqual(readPhaseStarts(['x', 5, '2026-08-30'], 3), ['', '', '2026-08-30'])
    assert.deepEqual(readPhaseStarts(['2026-06-01', '2026-08-30', '2026-10-09', '2026-10-20'], 2), ['2026-06-01', '2026-08-30'])
    assert.deepEqual(readPhaseStarts(['2026-06-01', 'bad', ''], 3), ['2026-06-01'])
  })
  it('gives nothing for a missing, empty or unreadable list', () => {
    for (const value of [undefined, null, '2026-08-30', {}, [], ['', ''], ['bad']]) assert.equal(readPhaseStarts(value, 3), undefined, JSON.stringify(value))
  })
  it('is part of the settings as the app reads them', () => {
    assert.deepEqual(resolveGuildSettings({ currentPhase: 'Third', phaseHistory: ['Launch', 'Second'], phaseStarts: ['', '2026-08-30'] }).phaseStarts, ['', '2026-08-30'])
    assert.equal('phaseStarts' in resolveGuildSettings({ currentPhase: 'Third' }), false)
    assert.deepEqual(resolveGuildSettings({ phaseStarts: ['2026-06-01', '2026-08-30'] }).phaseStarts, ['2026-06-01'])
  })
})

describe('dates', () => {
  it('accepts the dates the rules accept, and only days on the calendar from a leader', () => {
    assert.ok(isPhaseDate('2026-10-29'))
    for (const bad of ['2026-1-01', '2026-13-01', '2026-10-32', '2026-10-00', '20261029', ' 2026-10-29', '2026-10-29T00:00', 5, null]) assert.equal(isPhaseDate(bad), false, String(bad))
    assert.equal(isPhaseDate('2026-02-30'), true)
    assert.equal(isCalendarDate('2026-02-30'), false)
    assert.equal(isCalendarDate('2026-02-29'), false)
    assert.equal(isCalendarDate('2028-02-29'), true)
    assert.equal(isCalendarDate('2026-10-29'), true)
  })
  it('takes the day in Eastern Time, on both sides of midnight and of the change of clocks', () => {
    assert.equal(easternDateOf(Date.UTC(2026, 9, 30, 3, 59)), '2026-10-29')
    assert.equal(easternDateOf(Date.UTC(2026, 9, 30, 4, 0)), '2026-10-30')
    assert.equal(easternDateOf(Date.UTC(2026, 11, 1, 4, 59)), '2026-11-30')
    assert.equal(easternDateOf(Date.UTC(2026, 11, 1, 5, 0)), '2026-12-01')
  })
  it('writes a date in words', () => {
    assert.equal(phaseDateLabel('2026-10-29'), 'Oct 29, 2026')
    assert.equal(phaseDateLabel('2027-01-01'), 'Jan 1, 2027')
  })
})

describe('setting a start date', () => {
  it('sets, corrects and takes away the date of a finished or current phase', () => {
    assert.deepEqual(withPhaseStart(guild(), 1, '2026-08-30').phaseStarts, ['', '2026-08-30'])
    assert.deepEqual(withPhaseStart(guild(['', '2026-08-30']), 2, '2026-10-09').phaseStarts, ['', '2026-08-30', '2026-10-09'])
    assert.deepEqual(withPhaseStart(guild(['', '2026-08-30', '2026-10-09']), 1, '2026-08-31').phaseStarts, ['', '2026-08-31', '2026-10-09'])
    assert.deepEqual(withPhaseStart(guild(['', '2026-08-30', '2026-10-09']), 2, null).phaseStarts, ['', '2026-08-30'])
    assert.deepEqual(withPhaseStart(guild(['', '2026-08-30', '2026-10-09']), 1, null).phaseStarts, ['', '', '2026-10-09'])
    assert.equal('phaseStarts' in withPhaseStart(guild(['', '2026-08-30']), 1, null), false)
  })
  it('leaves the other settings, and what it was given, as they are', () => {
    const before = guild(['', '2026-08-30'])
    const after = withPhaseStart(before, 2, '2026-10-09')
    assert.deepEqual(before.phaseStarts, ['', '2026-08-30'])
    assert.equal(after.currentPhase, 'Third')
    assert.deepEqual(after.phaseHistory, ['Launch', 'Second'])
    assert.equal(after.currentStatusLabel, 'Active')
  })
  it('reads the date of a phase, none for a phase without one, and none for the next phase', () => {
    const dated = guild(['', '2026-08-30', '2026-10-09'])
    assert.equal(phaseStartOf(dated, 0), undefined)
    assert.equal(phaseStartOf(dated, 1), '2026-08-30')
    assert.equal(phaseStartOf(dated, 3), undefined)
    assert.equal(hasPhaseStarts(dated), true)
    assert.equal(hasPhaseStarts(guild()), false)
    const onlyNext = { currentPhase: 'Launch', nextPhase: 'Second', phaseStarts: ['', '2026-10-20'] }
    assert.equal(hasPhaseStarts(onlyNext), false)
  })
})

describe('why a start date is refused', () => {
  const today = '2026-10-29'
  const dated = guild(['', '2026-08-30', '2026-10-09'])
  it('accepts a date between the neighbors, on either neighbor, and today', () => {
    assert.equal(phaseStartProblem(dated, 1, '2026-09-15', today), undefined)
    assert.equal(phaseStartProblem(dated, 1, '2026-10-09', today), undefined)
    assert.equal(phaseStartProblem(dated, 2, '2026-08-30', today), undefined)
    assert.equal(phaseStartProblem(dated, 2, today, today), undefined)
    assert.equal(phaseStartProblem(dated, 0, '2026-01-01', today), undefined)
  })
  it('refuses a date after today', () => {
    assert.equal(phaseStartProblem(dated, 2, '2026-10-30', today), 'A phase cannot start after today (Oct 29, 2026).')
  })
  it('refuses a date before an earlier phase, in plain words that say what to do', () => {
    assert.equal(phaseStartProblem(dated, 2, '2026-08-29', today), 'Second started on Aug 30, 2026, so Third cannot start before that. Choose Aug 30, 2026 or later, or correct Second first.')
  })
  it('refuses a date after a later phase', () => {
    assert.equal(phaseStartProblem(dated, 0, '2026-09-01', today), 'Second started on Aug 30, 2026, so Launch cannot start after that. Choose Aug 30, 2026 or earlier, or correct Second first.')
  })
  it('looks past a phase with no date to the nearest one that has one', () => {
    const gap = guild(['2026-06-01', '', '2026-10-09'])
    assert.match(phaseStartProblem(gap, 1, '2026-05-31', today)!, /^Launch started on Jun 1, 2026, so Second cannot start before that/)
    assert.match(phaseStartProblem(gap, 1, '2026-10-10', today)!, /^Third started on Oct 9, 2026, so Second cannot start after that/)
    assert.equal(phaseStartProblem(gap, 1, '2026-08-30', today), undefined)
  })
  it('refuses a day that is not on the calendar, and the next phase', () => {
    assert.match(phaseStartProblem(dated, 1, '2026-02-30', today)!, /real date/)
    assert.match(phaseStartProblem(dated, 1, '', today)!, /real date/)
    assert.match(phaseStartProblem(dated, 3, '2026-10-20', today)!, /finished phase or the current one/)
  })
})

describe('starting and reopening a phase keep the dates', () => {
  it('records the day a phase starts, with no date for the phases before it that have none', () => {
    assert.deepEqual(startNextPhase(guild(), 'Fourth', '2026-10-29').phaseStarts, ['', '', '', '2026-10-29'])
    assert.deepEqual(startNextPhase(guild(['', '2026-08-30', '2026-10-09']), 'Fourth', '2026-10-29').phaseStarts, ['', '2026-08-30', '2026-10-09', '2026-10-29'])
  })
  it('leaves the dates alone when no day is given', () => {
    assert.equal('phaseStarts' in startNextPhase(guild(), 'Fourth'), false)
    assert.deepEqual(startNextPhase(guild(['', '2026-08-30']), 'Fourth').phaseStarts, ['', '2026-08-30'])
  })
  it('takes the date of the phase being left away when the phase before it is reopened', () => {
    assert.deepEqual(reopenPhase(guild(['', '2026-08-30', '2026-10-09'])).phaseStarts, ['', '2026-08-30'])
    assert.deepEqual(reopenPhase(guild(['2026-06-01', '', '2026-10-09'])).phaseStarts, ['2026-06-01'])
    assert.equal('phaseStarts' in reopenPhase({ ...guild(['', '2026-10-09']), currentPhase: 'Second', phaseHistory: ['Launch'] }), false)
  })
  it('gives back the dates there were when a start is undone', () => {
    const before = guild(['', '2026-08-30', '2026-10-09'])
    assert.deepEqual(reopenPhase(startNextPhase(before, 'Fourth', '2026-10-29')).phaseStarts, before.phaseStarts)
  })
  it('refuses to start a phase today while a phase has a start date after today', () => {
    assert.equal(startTodayProblem(guild(['', '2026-08-30', '2026-10-09']), '2026-10-29'), undefined)
    assert.equal(startTodayProblem(guild(['', '2026-08-30', '2026-10-09']), '2026-10-09'), undefined)
    assert.match(startTodayProblem(guild(['', '2026-08-30', '2026-10-30']), '2026-10-29')!, /^Third starts on Oct 30, 2026, after today/)
    assert.equal(startTodayProblem(guild(), '2026-10-29'), undefined)
  })
})
