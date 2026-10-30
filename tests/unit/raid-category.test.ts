// A raid's category (shared/raids/raidCategory.ts, RAID-019): Scheduled, In Progress, Complete or Cancelled, at its boundaries.
import assert from 'node:assert/strict'
import { describe, test } from 'node:test'
import { isMarkedComplete, markCompleteAction, RAID_CATEGORIES, raidCategory, raidCategoryLabel, STAYS_AFTER_START_MS } from '../../src/shared/raids/raidCategory.ts'
import { STAYS_AFTER_START_MS as SCHEDULED_RAIDS_WINDOW } from '../../src/features/scheduled-raids/groupRaids.ts'

const NOW = Date.parse('2026-12-10T12:00:00Z')
const HOUR = 3_600_000
const at = (offsetHours: number) => ({ toMillis: () => NOW + offsetHours * HOUR })
const raid = (offsetHours: number | null, status?: string, date?: string) => ({
  ...(offsetHours === null ? {} : { startsAt: at(offsetHours) }), ...(status ? { status } : {}), ...(date ? { date } : {}),
})

describe('the 5 hours', () => {
  test('are 5 hours, and the same constant Scheduled Raids lists a raid by', () => {
    assert.equal(STAYS_AFTER_START_MS, 5 * HOUR)
    assert.equal(SCHEDULED_RAIDS_WINDOW, STAYS_AFTER_START_MS)
  })
})

describe('a raid that is not cancelled', () => {
  test('is Scheduled while its start is still to come', () => {
    assert.equal(raidCategory(raid(30), NOW), 'scheduled')
    assert.equal(raidCategory(raid(0.0001), NOW), 'scheduled', 'a moment before the start')
    assert.equal(raidCategory(raid(2, 'scheduled'), NOW), 'scheduled')
  })

  test('is In Progress from the very moment it starts', () => {
    assert.equal(raidCategory(raid(0), NOW), 'in-progress')
    assert.equal(raidCategory(raid(-2), NOW), 'in-progress')
    assert.equal(raidCategory(raid(-2, 'scheduled'), NOW), 'in-progress', 'a raid restored or unmarked is scheduled in its record')
  })

  test('stays In Progress until just before 5 hours have passed', () => {
    assert.equal(raidCategory(raid(-4.99), NOW), 'in-progress')
    assert.equal(raidCategory({ startsAt: { toMillis: () => NOW - STAYS_AFTER_START_MS + 1 } }, NOW), 'in-progress', 'one millisecond short')
  })

  test('is Complete at the moment 5 hours have passed, and after', () => {
    assert.equal(raidCategory({ startsAt: { toMillis: () => NOW - STAYS_AFTER_START_MS } }, NOW), 'complete')
    assert.equal(raidCategory(raid(-6), NOW), 'complete')
    assert.equal(raidCategory(raid(-24 * 90), NOW), 'complete')
  })

  test('is Complete as soon as a leader marks it, before the 5 hours', () => {
    assert.equal(raidCategory(raid(-1, 'complete'), NOW), 'complete')
    assert.equal(raidCategory(raid(0, 'complete'), NOW), 'complete', 'marked at the start itself')
    assert.equal(raidCategory(raid(-4.99, 'complete'), NOW), 'complete')
    assert.equal(raidCategory(raid(-7, 'complete'), NOW), 'complete', 'whichever comes first: both have')
  })

  test('is Scheduled while its start is to come, even if its record says complete (the rules refuse that, so it is only a stray record)', () => {
    assert.equal(raidCategory(raid(3, 'complete'), NOW), 'scheduled')
  })
})

describe('a cancelled raid', () => {
  test('is Cancelled before its start', () => {
    assert.equal(raidCategory(raid(20, 'cancelled'), NOW), 'cancelled')
  })

  test('is Cancelled at and after its start, and long after', () => {
    assert.equal(raidCategory(raid(0, 'cancelled'), NOW), 'cancelled')
    assert.equal(raidCategory(raid(-2, 'cancelled'), NOW), 'cancelled')
    assert.equal(raidCategory(raid(-6, 'cancelled'), NOW), 'cancelled')
  })

  test('is Cancelled with no saved start time too', () => {
    assert.equal(raidCategory(raid(null, 'cancelled', '2026-01-01'), NOW), 'cancelled')
  })
})

describe('a raid with no saved start time', () => {
  // NOW is 7:00 AM Eastern on December 10 (Eastern is UTC-5 then).
  test('is timed by its date in Eastern Time: Scheduled up to and including its day', () => {
    assert.equal(raidCategory(raid(null, undefined, '2026-12-10'), NOW), 'scheduled')
    assert.equal(raidCategory(raid(null, undefined, '2027-01-04'), NOW), 'scheduled')
  })

  test('and Complete from the next day on', () => {
    assert.equal(raidCategory(raid(null, undefined, '2026-12-09'), NOW), 'complete')
    assert.equal(raidCategory(raid(null, 'scheduled', '2025-06-01'), NOW), 'complete')
  })

  test('uses the Eastern day, not the UTC one', () => {
    const lateEvening = Date.parse('2026-12-11T03:30:00Z') // 10:30 PM Eastern on December 10, already December 11 in UTC
    assert.equal(raidCategory(raid(null, undefined, '2026-12-10'), lateEvening), 'scheduled')
    const afterMidnight = Date.parse('2026-12-11T05:00:00Z') // midnight Eastern
    assert.equal(raidCategory(raid(null, undefined, '2026-12-10'), afterMidnight), 'complete')
  })

  test('is never In Progress, and a record with no date at all is Scheduled', () => {
    assert.equal(raidCategory({}, NOW), 'scheduled')
  })
})

describe('the Mark Complete control', () => {
  test('offers Mark complete only while a raid is in progress', () => {
    assert.equal(markCompleteAction(raid(0), NOW), 'mark')
    assert.equal(markCompleteAction(raid(-4.99), NOW), 'mark')
    assert.equal(markCompleteAction(raid(-1, 'scheduled'), NOW), 'mark')
  })

  test('offers nothing before the start, on a cancelled raid, after 5 hours, or with no saved start time', () => {
    assert.equal(markCompleteAction(raid(1), NOW), null)
    assert.equal(markCompleteAction(raid(-1, 'cancelled'), NOW), null)
    assert.equal(markCompleteAction(raid(5, 'cancelled'), NOW), null)
    assert.equal(markCompleteAction(raid(-5), NOW), null)
    assert.equal(markCompleteAction(raid(null, undefined, '2026-12-10'), NOW), null)
  })

  test('offers Undo complete while a raid is marked complete', () => {
    assert.equal(markCompleteAction(raid(-1, 'complete'), NOW), 'undo')
    assert.equal(markCompleteAction(raid(-6, 'complete'), NOW), 'undo')
    assert.equal(isMarkedComplete(raid(-1, 'complete')), true)
    assert.equal(isMarkedComplete(raid(-6)), false, 'complete by the 5 hours alone is not marked')
  })
})

describe('the labels', () => {
  test('name every category once', () => {
    assert.deepEqual(RAID_CATEGORIES.map((category) => raidCategoryLabel[category]), ['Scheduled', 'In Progress', 'Complete', 'Cancelled'])
    assert.deepEqual(Object.keys(raidCategoryLabel).sort(), [...RAID_CATEGORIES].sort())
  })
})
