import { makeWho, nameKey, readLines, type Who } from './candidates.ts'
import { phaseNoOf } from './phases.ts'

export { nameKey }

// Structural types, so this file can be tested directly by Node. PriorityRecord and AwardRecord (guildApi.ts) satisfy them.
type LootPriority = { id: string; item: string; rankedPlayers: string[]; rankedIds?: string[]; phaseNo?: number; carriedFrom?: string }
type Award = { id?: string; priorityId?: string; item: string; recipient: string; recipientId?: string; awardedAt?: string; createdAt?: unknown; phaseNo?: number; status?: unknown }

// Who a line and an award are about, when the roster is not at hand: the id if there is one, else the name. The app passes the roster's, which also
// recognizes a name that is a roster character's as that character (so an award with only a name still counts for the character's line).
const noRoster = makeWho([])

// Positional completion: a player listed twice for an item is satisfied once per receipt. Only the number of
// receipts counts, not their dates. The first N listings of a player (in list order) are received, where N is the
// number of that player's active awards of the item; the rest stay open. Awards of other items or to other players
// never count, and a removed award stops counting.

// Finds a priority by id, for following where an item was carried over from.
export type PriorityLookup = (id: string) => LootPriority | undefined
export const priorityLookup = <T extends LootPriority>(priorities: T[]): PriorityLookup => {
  const byId = new Map(priorities.map((priority) => [priority.id, priority]))
  return (id) => byId.get(id)
}

// A priority carried over from an earlier phase keeps what that phase's awards said: the priorities it came from, the one before that, and so on
// (at most MAX_CARRY steps, and never twice the same one). Their ids and phases are what awards are matched against.
const MAX_CARRY = 20
function carriedFrom(priority: LootPriority, lookup?: PriorityLookup) {
  const ids = new Set([priority.id])
  const phases = new Set([phaseNoOf(priority)])
  let current = priority
  for (let step = 0; step < MAX_CARRY; step++) {
    const from = current.carriedFrom
    if (!from || ids.has(from)) break
    ids.add(from)
    const source = lookup?.(from)
    if (!source) break
    phases.add(phaseNoOf(source))
    current = source
  }
  return { ids, phases }
}

// An award counts toward a priority when it was recorded from that priority (or from one it was carried over from), or, when it has no priority
// at all (a later manual entry or import), when it is for an item of the same name in the same phase (or in a phase it was carried over from).
// Without a lookup, only the priority itself counts.
export function awardsForPriority<A extends Award>(priority: LootPriority, awards: A[], lookup?: PriorityLookup): A[] {
  const itemKey = nameKey(priority.item)
  const from = carriedFrom(priority, lookup)
  return awards.filter((award) => award.priorityId ? from.ids.has(award.priorityId) : nameKey(award.item) === itemKey && from.phases.has(phaseNoOf(award)))
}

// A leader removes an award by marking it `status: 'removed'` with a reason (never by deleting it: see guildApi.removeAward). It stays in the Log, and
// stops counting everywhere: in the completion of a list, on a dashboard and in the header.
export function isRemovedAward(award: { status?: unknown }) {
  return award.status === 'removed'
}

export type ListingProgress<A extends Award = Award> = {
  // Same order as the lines of the priority (see readLines): a note is never received, it is open or finished.
  received: boolean[]
  // The award each received line stands on, in the same order (none for a line that is not received). Where a person is listed twice, the oldest award
  // is the first listing's, so a leader who fixes a receipt is fixing the award the mark shows.
  receipts: (A | undefined)[]
  // Index of the first line still open (a character not yet received, or an open note), or -1 when none is.
  next: number
  // At least one line, and none open: every character received, every note finished.
  complete: boolean
}

// When an award was entered, in milliseconds: a Firestore timestamp, a number, or none (an award from before the Log, or one whose server time has not arrived yet).
const enteredAt = (award: Award) => { const at = award.createdAt as { toMillis?: () => number } | number | null | undefined; return typeof at === 'number' ? at : typeof at?.toMillis === 'function' ? at.toMillis() : 0 }

// The oldest award first (the raid night, then when it was entered, then the id: the order docs/design/audit-first-loot.md gives for one night), so which award a
// line stands on never depends on the order the awards arrive in, and two receipts of one item on one night stay in the order they were entered.
const oldestFirst = (a: Award, b: Award) => (a.awardedAt ?? '').localeCompare(b.awardedAt ?? '') || enteredAt(a) - enteredAt(b) || (a.id ?? '').localeCompare(b.id ?? '')

export function listingProgress<A extends Award>(priority: LootPriority, awards: A[], lookup?: PriorityLookup, who: Who = noRoster): ListingProgress<A> {
  const lines = readLines(priority)
  const credits = new Map<string, A[]>()
  for (const award of awardsForPriority(priority, awards, lookup)) {
    if (isRemovedAward(award)) continue
    const key = who.awardKey(award)
    credits.set(key, [...(credits.get(key) ?? []), award])
  }
  for (const list of credits.values()) list.sort(oldestFirst)
  const receipts = lines.map((line) => {
    const key = who.lineKey(line)
    return key === undefined ? undefined : credits.get(key)?.shift()
  })
  const received = receipts.map((award) => award !== undefined)
  const open = lines.map((line, index) => (line.kind === 'note' ? !line.done : !received[index]))
  return { received, receipts, next: open.indexOf(true), complete: lines.length > 0 && !open.includes(true) }
}

export type RecipientChoice = { key: string; name: string; id?: string; listed: number; received: number }

// One choice per distinct person on the character lines (a person listed twice appears once), with how many of that person's listings are received.
// The name is the roster's current one. Used by the award dialog.
export function recipientChoices(priority: LootPriority, progress: ListingProgress, who: Who = noRoster): RecipientChoice[] {
  const choices = new Map<string, RecipientChoice>()
  readLines(priority).forEach((line, index) => {
    const key = who.lineKey(line)
    if (key === undefined || line.kind !== 'character') return
    const choice = choices.get(key) ?? { key, name: who.nameOf(line), ...(line.id !== undefined ? { id: line.id } : {}), listed: 0, received: 0 }
    choice.listed += 1
    if (progress.received[index]) choice.received += 1
    choices.set(key, choice)
  })
  return [...choices.values()]
}
