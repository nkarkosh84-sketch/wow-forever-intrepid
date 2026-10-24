import { readLines, type Who } from '../../shared/game/candidates.ts'
import { matchesEncounterScope } from './groupPriorities.ts'

// What the Log's dropdowns look at. An entry only lists the fields that changed, so the dungeon and boss, the players and the item (for its slot)
// of an entry are worked out from the entry and, where it does not say, from the priority it is about as it stands now. Pure; Node tests it.
type EntryLike = { targetType: string; targetId: string; item: string; before: Record<string, unknown>; after: Record<string, unknown> }
type PriorityLike = { id: string; item: string; encounter: string; rankedPlayers: string[]; rankedIds?: string[]; itemId?: number }

// A person an entry is about: the key says who (an id, or a name for someone the roster does not know), the name is what the dropdown shows.
export type Person = { key: string; name: string }

export type LogFacts = {
  // False for entries that are about no item (a phase started or reopened, a drop list changed): they match none of the item filters.
  about: 'item' | 'phase' | 'table'
  item: string
  itemId?: number
  encounter: string
  players: Person[]
  // The loot phase the entry is for (see entryPhase.ts); none when it cannot be told. Set by the Log, not by logFacts.
  phase?: number
}

const text = (value: unknown) => (typeof value === 'string' ? value : '')

// Each person once, in the order first seen.
const unique = (people: Person[]) => [...new Map(people.map((person) => [person.key, person])).values()]

// The people on the character lines of a priority or a snapshot (a note is nobody), by their current name.
const linePeople = (names: unknown, ids: unknown, who: Who): Person[] =>
  readLines({ rankedPlayers: namesOf(names), rankedIds: ids }).flatMap((line) => { const key = who.lineKey(line); return key !== undefined && who.nameOf(line).trim() !== '' ? [{ key, name: who.nameOf(line).trim() }] : [] })
const namesOf = (value: unknown) => (Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === 'string') : [])

export function logFacts(entry: EntryLike, priorityById: (id: string) => PriorityLike | undefined, who: Who): LogFacts {
  if (entry.targetType === 'phase') return { about: 'phase', item: '', encounter: '', players: [] }
  if (entry.targetType === 'table') return { about: 'table', item: '', encounter: '', players: [] }
  const field = (name: string) => entry.after[name] ?? entry.before[name]
  const priority = priorityById(entry.targetType === 'award' ? text(field('priorityId')) : entry.targetId)
  const itemId = typeof field('itemId') === 'number' ? (field('itemId') as number) : priority?.itemId
  const recipientId = text(field('recipientId'))
  const players = entry.targetType === 'award'
    ? [...(text(field('recipient')) ? [{ key: who.awardKey({ recipient: text(field('recipient')), ...(recipientId ? { recipientId } : {}) }), name: (recipientId ? who.player(recipientId)?.name : undefined) ?? text(field('recipient')) }] : []), ...linePeople(field('prioritySnapshot'), field('prioritySnapshotIds'), who)]
    : [...linePeople(entry.before.rankedPlayers, entry.before.rankedIds, who), ...linePeople(entry.after.rankedPlayers, entry.after.rankedIds, who), ...(priority ? linePeople(priority.rankedPlayers, priority.rankedIds, who) : [])]
  return { about: 'item', item: entry.item || priority?.item || '', ...(itemId !== undefined ? { itemId } : {}), encounter: text(field('encounter')) || priority?.encounter || '', players: unique(players) }
}

// `phase` is a phase number as text, or '' for every phase.
export type LogFilter = { player: string; slot: string; encounter: string; phase: string }
export const noLogFilter: LogFilter = { player: '', slot: '', encounter: '', phase: '' }
export const logFilterActive = (filter: LogFilter) => !!(filter.player || filter.slot || filter.encounter || filter.phase)

// Whether an entry passes the dropdowns. `slotOf` gives the slot choice of an item, or undefined while its lookup has not finished (it matches
// no slot until it has). The phase applies to every kind of entry; the others are about an item, so a phase or drop list entry matches none of them.
export function matchesLogFilter(facts: LogFacts, filter: LogFilter, slotOf: (item: { item: string; itemId?: number }) => string | undefined): boolean {
  if (!logFilterActive(filter)) return true
  if (filter.phase !== '' && facts.phase !== Number(filter.phase)) return false
  if (!filter.player && !filter.slot && !filter.encounter) return true
  if (facts.about !== 'item') return false
  return (!filter.encounter || (facts.encounter !== '' && matchesEncounterScope(facts.encounter, filter.encounter)))
    && (!filter.player || facts.players.some((person) => person.key === filter.player))
    && (!filter.slot || slotOf({ item: facts.item, itemId: facts.itemId }) === filter.slot)
}

// The people the dropdown offers: everyone any entry is about, once each, in alphabetical order by name. The current choice is always included.
export function logPlayers(all: LogFacts[], current: string): Person[] {
  const seen = new Map<string, string>()
  for (const facts of all) for (const person of facts.players) if (!seen.has(person.key)) seen.set(person.key, person.name)
  if (current && !seen.has(current)) seen.set(current, current.replace(/^(id|name):/, ''))
  return [...seen].map(([key, name]) => ({ key, name })).sort((a, b) => a.name.localeCompare(b.name))
}
