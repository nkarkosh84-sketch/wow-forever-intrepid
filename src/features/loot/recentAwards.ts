import { isLegacyAward } from '../../shared/game/lootAudit.ts'
import { phaseNoOf } from '../../shared/game/phases.ts'
import { isRemovedAward } from './completion.ts'
import { splitEncounter } from './groupPriorities.ts'
import { DECISIONS } from './manualAward.ts'

// Recently recorded (LOOT-014): the awards of the current phase, newest first, so a leader can find one that went wrong and fix it with the same dialog as
// the x on a priority line (ReceiptFixModal), including an award that has no priority list (a Record loot award), which never gets that x. Pure, so Node
// tests it; RecentAwardsModal only lays it out. Nothing here writes: the fix is guildApi.correctAward or removeAward, checked by the rules as before.

/** How many rows the dialog shows at first, and how many more each "Show more" adds. */
export const RECENT_STEP = 30

type RecentAward = { id: string; awardedAt: string; createdAt?: unknown; phaseNo?: number }

/**
 * When an award was entered, in milliseconds, to order the awards of one raid night. A write that is not confirmed yet has no server time (null): it is the
 * newest there is, so it comes first. An award from before the Log began has none at all: it comes after every award that has one. A Firestore timestamp is read
 * through its toMillis; a number or a Date is taken as it is.
 */
export function enteredTime(createdAt: unknown): number {
  if (createdAt === null) return Number.POSITIVE_INFINITY
  if (typeof createdAt === 'number') return Number.isFinite(createdAt) ? createdAt : Number.NEGATIVE_INFINITY
  if (createdAt instanceof Date) return Number.isNaN(createdAt.getTime()) ? Number.NEGATIVE_INFINITY : createdAt.getTime()
  if (typeof createdAt === 'object' && createdAt !== undefined) {
    const toMillis = (createdAt as { toMillis?: unknown }).toMillis
    if (typeof toMillis === 'function') {
      const at = toMillis.call(createdAt)
      if (typeof at === 'number' && Number.isFinite(at)) return at
    }
  }
  return Number.NEGATIVE_INFINITY
}

// Larger first, without subtracting (two unconfirmed writes are both infinite).
const descending = (a: number, b: number) => (a === b ? 0 : a > b ? -1 : 1)

/** The newest first: the latest raid night, then on one night the latest entered (an unconfirmed write first), then by id so the order never depends on arrival. */
export function newestFirst(a: RecentAward, b: RecentAward): number {
  return b.awardedAt.localeCompare(a.awardedAt) || descending(enteredTime(a.createdAt), enteredTime(b.createdAt)) || a.id.localeCompare(b.id)
}

/** Every award of this phase, removed ones included (they are shown, struck through), newest first. An award with no phase is in the first phase. */
export function recentAwards<A extends RecentAward>(awards: readonly A[], phaseNo: number): A[] {
  return awards.filter((award) => phaseNoOf(award) === phaseNo).sort(newestFirst)
}

/** The rows on screen when `shown` are asked for, how many there are in all, and how many are left for "Show more". */
export function recentPage<A>(list: readonly A[], shown: number): { rows: A[]; total: number; more: number } {
  const rows = list.slice(0, Math.max(0, Math.floor(shown)))
  return { rows, total: list.length, more: list.length - rows.length }
}

/** The label of the button that shows the next rows: 30 more, or fewer when fewer are left. */
export const moreLabel = (more: number) => `Show ${Math.min(more, RECENT_STEP)} more`

export type AwardState = 'removed' | 'corrected' | 'recorded'

/**
 * Whether an award was removed, changed since it was recorded, or is as it was recorded. An award made since the Log began starts at revision 1, so a higher
 * revision means it was changed. One from before the Log began has no revision until its first change, which gives it revision 1 (see guildApi.writeAwardChange).
 */
export function awardState(award: { status?: unknown; rev?: number; createdBy?: string }): AwardState {
  if (isRemovedAward(award)) return 'removed'
  if (isLegacyAward(award) ? award.rev !== undefined : (award.rev ?? 0) > 1) return 'corrected'
  return 'recorded'
}

/** How the drop was given: from a priority list, or how a manual award says it was decided (Roll, Council, Other). An older award that says neither is "Not noted". */
export function howDecided(award: { priorityId?: string; decision?: unknown }): string {
  if (award.priorityId) return 'Priority list'
  return DECISIONS.find((option) => option.value === award.decision)?.label ?? 'Not noted'
}

/** Where it dropped, for the row: "dungeon, boss", the dungeon alone, the boss alone, or nothing when neither was noted. */
export function placeOf(encounter: string): string {
  const { dungeon, boss } = splitEncounter(encounter)
  return [dungeon, boss].filter(Boolean).join(', ')
}
