// Every raid has exactly one category (RAID-019): Scheduled, In Progress, Complete or Cancelled. The 5-hour half of Complete is derived from the raid's start and the viewer's
// clock, as Scheduled Raids' window is (RAID-016); the only stored part is `status: 'complete'`, which a Guild or Raid Leader sets with Mark Complete. Scheduled Raids and
// Raid History both read it. Pure, with no imports, so Node tests it, and it takes only what it reads of a raid. Not to be confused with a start snapshot's `status`
// (`complete` there means the capture finished), which is why this is a raid's "category".

/** How long a raid is in progress after its start: from then on it is complete, and Scheduled Raids stops listing it. */
export const STAYS_AFTER_START_MS = 5 * 3_600_000

export type RaidCategory = 'scheduled' | 'in-progress' | 'complete' | 'cancelled'

/** The categories in the order a raid moves through them (a cancelled raid can be cancelled at any point). */
export const RAID_CATEGORIES: readonly RaidCategory[] = ['scheduled', 'in-progress', 'complete', 'cancelled']

export const raidCategoryLabel: Readonly<Record<RaidCategory, string>> = {
  scheduled: 'Scheduled',
  'in-progress': 'In Progress',
  complete: 'Complete',
  cancelled: 'Cancelled',
}

type RaidTiming = { status?: string; startsAt?: { toMillis(): number }; date?: string }

const easternDay = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit' })

/**
 * The raid's category at `now`:
 * - Cancelled: cancelled, whenever that was.
 * - Scheduled: not cancelled, and the start is still to come.
 * - Complete: not cancelled, started, and either marked complete or 5 hours past the start, whichever comes first.
 * - In Progress: not cancelled, started, not marked complete, and less than 5 hours past the start.
 * The start itself is the first moment of In Progress and the 5-hour mark the first of Complete, the same edges as Scheduled Raids' read-only test and its list.
 *
 * A raid with no saved start time (one from before start times were saved) has no moment to count 5 hours from, so it is never In Progress: it is timed by its date
 * alone, the day in Eastern Time (as the server's absence sync does for such a raid). It is Scheduled up to and including that day and Complete from the next day on.
 */
export function raidCategory(raid: RaidTiming, now: number): RaidCategory {
  if (raid.status === 'cancelled') return 'cancelled'
  if (!raid.startsAt) return raid.date !== undefined && raid.date < easternDay.format(now) ? 'complete' : 'scheduled'
  const start = raid.startsAt.toMillis()
  if (now < start) return 'scheduled'
  if (raid.status === 'complete' || now >= start + STAYS_AFTER_START_MS) return 'complete'
  return 'in-progress'
}

/** Whether a Guild or Raid Leader pressed Mark Complete (the stored half of Complete). */
export const isMarkedComplete = (raid: Pick<RaidTiming, 'status'>) => raid.status === 'complete'

/**
 * What the Mark Complete control offers for a raid, mirroring the rules: `mark` while it is in progress (started, not cancelled, not marked, under 5 hours), `undo` while it is
 * marked complete, else nothing (still to come, cancelled, or complete by the 5 hours alone, which marking would not change).
 */
export function markCompleteAction(raid: RaidTiming, now: number): 'mark' | 'undo' | null {
  if (isMarkedComplete(raid)) return 'undo'
  return raidCategory(raid, now) === 'in-progress' ? 'mark' : null
}
