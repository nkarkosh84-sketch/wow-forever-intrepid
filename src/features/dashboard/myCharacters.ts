import type { AfkEntryRecord, AwardRecord, PlayerRecord, PriorityRecord, RaidRecord } from '../../guildApi'
import { makeWho, readLines } from '../../shared/game/candidates.ts'
import { isRemovedAward, listingProgress, type PriorityLookup } from '../../shared/game/completion.ts'
import { phaseNoOf } from '../../shared/game/phases.ts'
import { unavailableOn } from '../../shared/raids/availability.ts'

// The character a Guild Leader linked to this account, plus its main and that main's alts.
export function findMyCharacters(roster: PlayerRecord[], uid: string): { linked: PlayerRecord | null; characters: PlayerRecord[] } {
  const linked = uid ? roster.find((player) => player.linkedUid === uid) ?? null : null
  if (!linked) return { linked: null, characters: [] }
  // A link to a missing character or to another alt is ignored, as on the roster.
  const candidate = linked.mainId ? roster.find((player) => player.id === linked.mainId) : undefined
  const main = candidate && !candidate.mainId ? candidate : linked
  const alts = roster.filter((player) => player.mainId === main.id && player.id !== main.id)
  return { linked, characters: [main, ...alts] }
}

// A line or an award is a character's when it carries that character's id; an older one carries a name only, which matches the character's first name.
const sameName = (name: string, player: PlayerRecord) => name.trim().toLowerCase() === player.name.trim().toLowerCase()

export type MyPriority = { priority: PriorityRecord; phaseNo: number; position: number; character: PlayerRecord; received: boolean }

// The priorities this account's characters are on, in every phase given. `received` says whether that listing has been received (see listingProgress).
// A line that is a note names nobody, so it is on nobody's list. Pass the awards and the lookup of earlier priorities to have `received` filled in;
// without them it is false.
export function myPriorities(priorities: PriorityRecord[], characters: PlayerRecord[], awards: AwardRecord[] = [], lookup?: PriorityLookup): MyPriority[] {
  const who = makeWho(characters)
  const result: MyPriority[] = []
  for (const priority of priorities) {
    const lines = readLines(priority)
    const progress = listingProgress(priority, awards, lookup, who)
    for (const character of characters) {
      const index = lines.findIndex((line) => line.kind === 'character' && (line.id !== undefined ? line.id === character.id : sameName(line.name, character)))
      if (index >= 0) result.push({ priority, phaseNo: phaseNoOf(priority), position: index + 1, character, received: progress.received[index] === true })
    }
  }
  // The latest phase first, then the best place on the list.
  return result.sort((a, b) => b.phaseNo - a.phaseNo || a.position - b.position || a.priority.item.localeCompare(b.priority.item))
}

// The loot this account's characters received. A removed award is not loot anyone received (it stays in the Log).
export function myAwards(awards: AwardRecord[], characters: PlayerRecord[]) {
  return awards.filter((award) => !isRemovedAward(award) && characters.some((character) => (award.recipientId !== undefined ? award.recipientId === character.id : sameName(award.recipient, character))))
}

export type UpcomingRaid = { raid: RaidRecord; unavailable: boolean }

export function upcomingRaids(raids: RaidRecord[], afkEntries: AfkEntryRecord[], uid: string, today: string, limit = 5): UpcomingRaid[] {
  return raids
    .filter((raid) => raid.date >= today)
    .slice(0, limit)
    .map((raid) => ({ raid, unavailable: unavailableOn(afkEntries, uid, raid.date) }))
}

export function myAbsences(afkEntries: AfkEntryRecord[], uid: string, today: string): AfkEntryRecord[] {
  return afkEntries.filter((entry) => entry.userId === uid && entry.endDate >= today).sort((a, b) => a.startDate.localeCompare(b.startDate))
}
