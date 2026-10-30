// Scheduled Raids lists a raid from the moment it is scheduled until 5 hours after it starts (RAID-016); Raid History keeps it from then on. Pure, so Node tests it, and it
// takes only what it reads of a raid so it needs nothing from the app's data layer.
import { STAYS_AFTER_START_MS } from '../../shared/raids/raidCategory.ts'

/** How long a raid stays on Scheduled Raids after its start: the 5 hours after which a raid is complete (RAID-019), one constant for both. */
export { STAYS_AFTER_START_MS }

/** The element id of a raid's row, which is where the tab scrolls to when the navigation names the raid. */
export const raidRowId = (raidId: string) => `raid-row-${raidId}`

type RaidTiming = { status?: string; startsAt?: { toMillis(): number } }

/**
 * A raid is closed, and its row read-only, when it is cancelled, has no saved start time, or has started. This is the test the tab has always used for read-only, and the one
 * the server applies to sign-ups and planning (`open` in functions/raidPlanning.js).
 */
export function isClosedRaid(raid: RaidTiming, now: number): boolean {
  return raid.status === 'cancelled' || !raid.startsAt || raid.startsAt.toMillis() <= now
}

/**
 * A raid is listed while it is still to come and for 5 hours after it starts, cancelled or not. A raid with no saved start time has no moment to count from, so it is not
 * listed (a leader saving it once in Edit raid gives it one).
 */
export function isListedRaid(raid: RaidTiming, now: number): boolean {
  return raid.startsAt !== undefined && now < raid.startsAt.toMillis() + STAYS_AFTER_START_MS
}

/** The raids to list, in the order given (the caller sorts oldest first, so a raid that has started sits above the ones still to come). */
export function listedRaids<T extends RaidTiming>(sorted: readonly T[], now: number): T[] {
  return sorted.filter((raid) => isListedRaid(raid, now))
}

/** The next moment the list changes: a raid starting (its row then says In Progress and goes read-only) or leaving, so the tab can wait for it instead of polling every second. */
export function nextChangeAfter(raids: readonly RaidTiming[], now: number): number | undefined {
  let next: number | undefined
  for (const raid of raids) {
    if (!raid.startsAt) continue
    const start = raid.startsAt.toMillis()
    for (const moment of [start, start + STAYS_AFTER_START_MS]) if (moment > now && (next === undefined || moment < next)) next = moment
  }
  return next
}
