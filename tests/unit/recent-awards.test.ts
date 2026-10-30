import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { awardState, enteredTime, howDecided, moreLabel, newestFirst, placeOf, RECENT_STEP, recentAwards, recentPage } from '../../src/features/loot/recentAwards.ts'

// Every name here is invented: this repository is public.
type Award = { id: string; item: string; awardedAt: string; createdAt?: unknown; phaseNo?: number; priorityId?: string; decision?: string; status?: string; rev?: number; createdBy?: string }
const stamp = (ms: number) => ({ toMillis: () => ms })
const award = (id: string, awardedAt: string, overrides: Partial<Award> = {}): Award => ({ id, item: 'Gravewatch Pauldrons', awardedAt, createdAt: stamp(1_000), phaseNo: 1, rev: 1, createdBy: 'uid-leader', ...overrides })
const ids = (list: readonly { id: string }[]) => list.map((entry) => entry.id)

describe('when an award was entered', () => {
  it('reads a Firestore timestamp, a number and a Date', () => {
    assert.equal(enteredTime(stamp(1234)), 1234)
    assert.equal(enteredTime(5678), 5678)
    assert.equal(enteredTime(new Date(9_000)), 9_000)
  })
  it('puts a write that is not confirmed yet (no server time) after every time, so it sorts as the newest', () => {
    assert.equal(enteredTime(null), Number.POSITIVE_INFINITY)
  })
  it('puts an award from before the Log, or anything it cannot read, before every time, so it sorts as the oldest', () => {
    for (const value of [undefined, 'yesterday', {}, { toMillis: 'no' }, { toMillis: () => Number.NaN }, Number.NaN, new Date('not a date')]) assert.equal(enteredTime(value), Number.NEGATIVE_INFINITY)
  })
})

describe('the order of the list', () => {
  it('is the newest raid night first', () => {
    const list = recentAwards([award('a', '2026-12-09'), award('b', '2026-12-16'), award('c', '2026-12-10')], 1)
    assert.deepEqual(ids(list), ['b', 'c', 'a'])
  })
  it('is, on one night, the latest entered first, whatever order the awards arrive in', () => {
    const night = [award('early', '2026-12-09', { createdAt: stamp(100) }), award('late', '2026-12-09', { createdAt: stamp(300) }), award('middle', '2026-12-09', { createdAt: stamp(200) })]
    assert.deepEqual(ids(recentAwards(night, 1)), ['late', 'middle', 'early'])
    assert.deepEqual(ids(recentAwards([...night].reverse(), 1)), ['late', 'middle', 'early'])
  })
  it('puts an unconfirmed write first on its night, and an award from before the Log last', () => {
    const night = [award('legacy', '2026-12-09', { createdAt: undefined, rev: undefined, createdBy: undefined }), award('saved', '2026-12-09', { createdAt: stamp(500) }), award('pending', '2026-12-09', { createdAt: null })]
    assert.deepEqual(ids(recentAwards(night, 1)), ['pending', 'saved', 'legacy'])
  })
  it('still puts a later raid night first when an earlier night has an unconfirmed write (an award entered the next morning belongs to its night)', () => {
    assert.deepEqual(ids(recentAwards([award('pending-old-night', '2026-12-09', { createdAt: null }), award('next-night', '2026-12-10', { createdAt: stamp(1) })], 1)), ['next-night', 'pending-old-night'])
  })
  it('breaks a full tie by id, so two unconfirmed writes keep one order', () => {
    assert.deepEqual(ids(recentAwards([award('b', '2026-12-09', { createdAt: null }), award('a', '2026-12-09', { createdAt: null })], 1)), ['a', 'b'])
    assert.equal(newestFirst(award('a', '2026-12-09', { createdAt: null }), award('a', '2026-12-09', { createdAt: null })), 0)
  })
  it('does not change the list it was given', () => {
    const given = [award('a', '2026-12-09'), award('b', '2026-12-10')]
    recentAwards(given, 1)
    assert.deepEqual(ids(given), ['a', 'b'])
  })
})

describe('which awards are listed', () => {
  it('is the awards of the phase asked for only', () => {
    const list = recentAwards([award('now', '2026-12-09', { phaseNo: 1 }), award('before', '2026-11-30', { phaseNo: 0 }), award('next', '2027-01-06', { phaseNo: 2 })], 1)
    assert.deepEqual(ids(list), ['now'])
  })
  it('counts an award with no phase as the first phase', () => {
    assert.deepEqual(ids(recentAwards([award('old', '2026-11-30', { phaseNo: undefined }), award('now', '2026-12-09', { phaseNo: 1 })], 0)), ['old'])
  })
  it('lists awards with and without a priority list, and removed ones too', () => {
    const list = recentAwards([award('from-list', '2026-12-09', { priorityId: 'prio-1' }), award('roll', '2026-12-09', { decision: 'roll' }), award('removed', '2026-12-09', { decision: 'roll', status: 'removed', rev: 2 })], 1)
    assert.deepEqual(ids(list).sort(), ['from-list', 'removed', 'roll'])
  })
})

describe('paging', () => {
  const many = Array.from({ length: 65 }, (_, at) => award(`a${String(at).padStart(2, '0')}`, '2026-12-09', { createdAt: stamp(at) }))
  const list = recentAwards(many, 1)
  it('shows 30 at first, the newest', () => {
    const page = recentPage(list, RECENT_STEP)
    assert.equal(RECENT_STEP, 30)
    assert.equal(page.rows.length, 30)
    assert.equal(page.rows[0].id, 'a64')
    assert.equal(page.rows[29].id, 'a35')
    assert.equal(page.total, 65)
    assert.equal(page.more, 35)
    assert.equal(moreLabel(page.more), 'Show 30 more')
  })
  it('shows 30 more each time, then says how few are left, then none', () => {
    const second = recentPage(list, RECENT_STEP * 2)
    assert.equal(second.rows.length, 60)
    assert.equal(second.rows[30].id, 'a34')
    assert.equal(second.more, 5)
    assert.equal(moreLabel(second.more), 'Show 5 more')
    const third = recentPage(list, RECENT_STEP * 3)
    assert.equal(third.rows.length, 65)
    assert.equal(third.more, 0)
  })
  it('handles a short list, an empty one and an odd count', () => {
    assert.deepEqual(recentPage([1, 2, 3], RECENT_STEP), { rows: [1, 2, 3], total: 3, more: 0 })
    assert.deepEqual(recentPage([], RECENT_STEP), { rows: [], total: 0, more: 0 })
    assert.deepEqual(recentPage([1, 2, 3], -4), { rows: [], total: 3, more: 3 })
    assert.deepEqual(recentPage([1, 2, 3], 1.7), { rows: [1], total: 3, more: 2 })
  })
})

describe('the state of a row', () => {
  it('is removed for a removed award, whatever else it has, so the row is struck through and has no Fix', () => {
    assert.equal(awardState({ status: 'removed', rev: 2, createdBy: 'uid-leader' }), 'removed')
    assert.equal(awardState({ status: 'removed' }), 'removed')
  })
  it('is recorded for an award as it was recorded: revision 1, or an award from before the Log that was never changed', () => {
    assert.equal(awardState({ rev: 1, createdBy: 'uid-leader' }), 'recorded')
    assert.equal(awardState({ status: 'active', rev: 1, createdBy: 'uid-leader' }), 'recorded')
    assert.equal(awardState({}), 'recorded')
  })
  it('is corrected for an award changed since: a later revision, or an award from before the Log that has a revision now', () => {
    assert.equal(awardState({ rev: 2, createdBy: 'uid-leader' }), 'corrected')
    assert.equal(awardState({ rev: 1 }), 'corrected')
  })
})

describe('what a row says', () => {
  it('says how the drop was given', () => {
    assert.equal(howDecided({ priorityId: 'prio-1' }), 'Priority list')
    assert.equal(howDecided({ priorityId: '', decision: 'roll' }), 'Roll')
    assert.equal(howDecided({ decision: 'council' }), 'Council')
    assert.equal(howDecided({ decision: 'other' }), 'Other')
    assert.equal(howDecided({ priorityId: '' }), 'Not noted')
    assert.equal(howDecided({ decision: 'coin flip' }), 'Not noted')
  })
  it('says where it dropped, as the dungeon and the boss', () => {
    assert.equal(placeOf('Barrow Deeps · Gravewarden Ulm'), 'Barrow Deeps, Gravewarden Ulm')
    assert.equal(placeOf('Barrow Deeps ·'), 'Barrow Deeps')
    assert.equal(placeOf('Gravewarden Ulm'), 'Gravewarden Ulm')
    assert.equal(placeOf('  '), '')
  })
})
