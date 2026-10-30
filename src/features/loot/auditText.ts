import { readLines } from '../../shared/game/candidates.ts'
import { encounterLabel } from '../../shared/game/encounter.ts'
import type { AuditEntry } from '../../shared/game/lootAudit.ts'
import { phaseDateLabel } from '../../shared/game/phases.ts'

// The Log in words: one line for what happened, then what changed. Pure, so Node tests it; the dialog only lays it out.

const fieldLabels: Record<string, string> = {
  currentPhase: 'Current phase', nextPhase: 'Next phase', phaseHistory: 'Finished phases', phaseStarts: 'Start dates',
  item: 'Item', encounter: 'Dungeon and boss', rankedPlayers: 'Candidates', councilNote: 'Council note', itemId: 'Item id', zoneId: 'Dungeon id',
  npcId: 'Creature id', phaseNo: 'Phase', carriedFrom: 'Carried over from', priorityId: 'Priority', recipient: 'Recipient', recipientId: 'Recipient id',
  rankedIds: 'Candidate lines', prioritySnapshotIds: 'Candidate lines at the time',
  awardedAt: 'Award date', awardNote: 'Award note', prioritySnapshot: 'Candidates at the time', councilNoteSnapshot: 'Council note at the time',
  decision: 'Decision', status: 'Status', removedReason: 'Reason for removal',
  key: 'Creature key', name: 'Name', kind: 'Kind', players: 'Players', order: 'Place in the order', itemIds: 'Items', hiddenItemIds: 'Hidden items', removed: 'Removed',
}

const MAX = 160
const clip = (text: string) => (text.length > MAX ? `${text.slice(0, MAX - 1)}\u2026` : text)

/** A stored value as a person would read it. */
export function showValue(field: string, value: unknown, phaseName: (no: number) => string): string {
  if (value === null || value === undefined) return '(none)'
  if (field === 'phaseNo' && typeof value === 'number') return phaseName(value)
  // How a manual award was decided: roll, council or other, written as a person would.
  if (field === 'decision' && typeof value === 'string' && value) return `${value.charAt(0).toUpperCase()}${value.slice(1)}`
  // A dungeon with no boss is kept as "Dungeon ·" (see encounterOf in manualAward.ts); it reads as the dungeon.
  if (field === 'encounter' && typeof value === 'string') {
    const place = encounterLabel(value)
    return place ? clip(place) : '(empty)'
  }
  if (Array.isArray(value)) return value.length ? clip(value.map(String).join(', ')) : '(nobody)'
  if (typeof value === 'string') return value.trim() ? clip(value) : '(empty)'
  return clip(String(value))
}

const label = (field: string) => fieldLabels[field] ?? field

// The ids behind candidate names and recipients (see shared/game/candidates.ts) are not words: the Log shows the names, with a note marked as one, and says
// in a line of its own when only the ids changed. Pure.
const idFields = new Set(['rankedIds', 'prioritySnapshotIds', 'recipientId'])
const visible = (changed: string[]) => changed.filter((field) => !idFields.has(field))

/** A list of candidates as a person would read it: names in order, a note marked as one (and as finished when it is). */
export function showLines(names: unknown, ids: unknown): string {
  const lines = readLines({ rankedPlayers: Array.isArray(names) ? names.map(String) : [], rankedIds: ids })
  if (!lines.length) return '(nobody)'
  return clip(lines.map((line) => (line.kind === 'note' ? `note: ${line.text}${line.done ? ' (finished)' : ''}` : line.name)).join(', '))
}

/** What a change of the ids alone means, when the names did not change with them. */
function idsOnly(entry: AuditEntry): string | undefined {
  if (!entry.changed.includes('rankedIds') || entry.changed.includes('rankedPlayers')) return undefined
  const before = entry.before.rankedIds
  const after = entry.after.rankedIds
  if (!Array.isArray(before)) return 'Linked the candidates to the roster'
  const done = (value: unknown) => (Array.isArray(value) ? value.filter((id) => id === '!').length : 0)
  if (done(after) > done(before)) return 'Finished a note'
  if (done(after) < done(before)) return 'Reopened a note'
  return 'Changed the candidate lines'
}
const quote = (item: string) => `\u201c${item || 'Untitled'}\u201d`

// The start dates of a phase entry (RAID-019), one line per phase whose date changed, named by its number as the guild names it now:
// "Start of \u201cSecond\u201d: Aug 30, 2026 \u2192 Aug 31, 2026". A list holds one date per phase, '' for a phase with none.
function startDateLines(entry: AuditEntry, phaseName: (no: number) => string): { no: number; was: string; is: string; line: string }[] {
  if (!entry.changed.includes('phaseStarts')) return []
  const dates = (values: Record<string, unknown>) => (Array.isArray(values.phaseStarts) ? values.phaseStarts.map((value) => (typeof value === 'string' ? value : '')) : [])
  const before = dates(entry.before)
  const after = dates(entry.after)
  const words = (date: string) => (date ? phaseDateLabel(date) : '(none)')
  const lines: { no: number; was: string; is: string; line: string }[] = []
  for (let no = 0; no < Math.max(before.length, after.length); no += 1) {
    const was = before[no] ?? ''
    const is = after[no] ?? ''
    if (was !== is) lines.push({ no, was, is, line: `Start of ${quote(phaseName(no))}: ${words(was)} \u2192 ${words(is)}` })
  }
  return lines
}

export type EntryText = { title: string; details: string[] }
// What the Log can look up for a drop list entry: the name of a zone by its number, of a creature by its zone and key (an entry about a document that
// sets no name has none), of an item by its number (when it is known by now), and the phase a custom zone or a creature was first written in (its
// first document is "added", the ones after it are changes to it).
export type TableLookups = {
  zoneName?: (zoneId: number) => string | undefined
  sourceName?: (zoneId: number, key: string) => string | undefined
  itemName?: (itemId: number) => string | undefined
  firstZonePhase?: (zoneId: number) => number | undefined
  firstSourcePhase?: (zoneId: number, key: string) => number | undefined
  // Who an award is for as it stands now: an entry about a removal or a restore lists no recipient, so the Log asks for it.
  awardRecipient?: (awardId: string) => string | undefined
}

const numbers = (value: unknown) => (Array.isArray(value) ? value.filter((entry): entry is number => typeof entry === 'number') : [])
const count = (n: number) => `${n} ${n === 1 ? 'item' : 'items'}`
const CUSTOM_ZONE_MIN = 50_000_000 // the same number as shared/game/guildTables.ts (no imports here, so Node runs this file's tests directly)

// An entry about the guild's own drop lists (a zone, or a creature of any zone) in one phase. The target id says which, and which phase: z{zone}_{phase}
// or s{zone}_{key}_{phase}. A document means "from this phase on", so the title says the phase. A document says only what its phase changes, so
// every name, kind, place, number or size it carries is a deliberate change and is always listed.
function describeTableEntry(entry: AuditEntry, lookups: TableLookups, phaseName: (no: number) => string, change: (field: string) => string): EntryText {
  // The document of a phase (p{phase}): which earlier phase it follows, or nothing.
  if (/^p\d+$/.test(entry.targetId)) {
    const phase = phaseName(Number(entry.targetId.slice(1)))
    const now = entry.after.follows
    const was = entry.before.follows
    return {
      title: typeof now === 'number' ? `${phase} now follows ${phaseName(now)}` : `${phase} now follows nothing`,
      details: typeof was === 'number' ? [`It followed ${phaseName(was)}`] : [],
    }
  }
  const parts = entry.targetId.split('_')
  const isZone = entry.targetId.startsWith('z')
  const zoneNo = Number(parts[0].slice(1))
  const key = isZone ? '' : parts.slice(1, -1).join('_')
  const phaseNo = Number(parts[parts.length - 1])
  const when = Number.isInteger(phaseNo) ? ` (${phaseName(phaseNo)})` : ''
  const zone = quote(lookups.zoneName?.(zoneNo) ?? 'a zone')
  const called = entry.item || (isZone ? lookups.zoneName?.(zoneNo) : lookups.sourceName?.(zoneNo, key)) || ''
  const item = quote(called || (isZone ? 'a zone' : 'a creature'))
  const itemLabel = (id: number) => { const name = lookups.itemName?.(id); return name ? `${name} (${id})` : String(id) }
  const ids = (list: number[]) => clip(list.map(itemLabel).join(', '))
  const result = (title: string, details: string[]): EntryText => ({ title: `${title}${when}`, details })
  const shown = (field: string) => `${label(field)}: ${showValue(field, entry.after[field], (no) => String(no))}`
  const removedNow = typeof entry.after.removed === 'boolean' ? entry.after.removed : undefined
  // The attributes this document sets: shown as they are on a new document, as before and after on a change.
  const attributes = (fields: string[]) => fields.filter((field) => entry.changed.includes(field)).map((field) => (entry.action === 'create' ? shown(field) : change(field)))

  if (isZone) {
    const introduced = zoneNo >= CUSTOM_ZONE_MIN && entry.action === 'create' && lookups.firstZonePhase?.(zoneNo) === phaseNo
    const details = attributes(['name', 'kind', 'players'])
    if (introduced) return result(`Added the zone ${item}`, attributes(['kind', 'players']))
    if (removedNow === true) return result(`Took the zone ${item} out of the lists`, details)
    if (removedNow === false) return result(entry.before.removed === true ? `Put the zone ${item} back in the lists` : `Put the zone ${item} in the lists`, details)
    if (entry.changed.includes('removed')) return result(`Made ${item} follow the earlier phase again`, details) // `removed` was taken away
    return result(`Changed the zone ${item}`, details)
  }

  // A creature or the zone-wide list. Its first document is the creature being added; a later one is a change from that phase on.
  const introduced = entry.action === 'create' && !key.startsWith('npc') && key !== 'zonewide' && lookups.firstSourcePhase?.(zoneNo, key) === phaseNo
  if (introduced) {
    const lines = attributes(['kind', 'npcId'])
    const given = numbers(entry.after.itemIds)
    if (given.length) lines.push(`Items: ${ids(given)}`)
    return result(`Added ${item} to ${zone}`, lines)
  }
  const before = numbers(entry.before.itemIds)
  const after = numbers(entry.after.itemIds)
  const hiddenBefore = numbers(entry.before.hiddenItemIds)
  const hiddenAfter = numbers(entry.after.hiddenItemIds)
  const added = after.filter((id) => !before.includes(id))
  const taken = [...before.filter((id) => !after.includes(id)), ...hiddenAfter.filter((id) => !hiddenBefore.includes(id))]
  const back = hiddenBefore.filter((id) => !hiddenAfter.includes(id))
  const details = [
    ...(added.length ? [`Added: ${ids(added)}`] : []),
    ...(taken.length ? [`Taken off from here on: ${ids(taken)}`] : []),
    ...(back.length ? [`Brought back: ${ids(back)}`] : []),
    ...attributes(['name', 'kind', 'order', 'npcId']),
  ]
  if (removedNow === true) return result(`Took ${item} out of ${zone} from here on`, details)
  if (removedNow === false) return result(`Put ${item} back in ${zone}`, details)
  if (entry.changed.includes('removed')) return result(`Made ${item} in ${zone} follow the earlier phase again`, details) // `removed` was taken away
  const title = added.length ? `Added ${count(added.length)} to ${item} in ${zone}`
    : taken.length ? `Took ${count(taken.length)} off ${item} in ${zone}`
      : back.length ? `Brought back ${count(back.length)} of ${item} in ${zone}`
        : `Changed ${item} in ${zone}`
  return result(title, details)
}

export function describeEntry(entry: AuditEntry, phaseName: (no: number) => string, lookups: TableLookups = {}): EntryText {
  const item = quote(entry.item)
  const shown = (field: string, values: Record<string, unknown>) => (field === 'rankedPlayers' ? showLines(values.rankedPlayers, values.rankedIds) : field === 'prioritySnapshot' ? showLines(values.prioritySnapshot, values.prioritySnapshotIds) : showValue(field, values[field], phaseName))
  const change = (field: string) => `${label(field)}: ${shown(field, entry.before)} \u2192 ${shown(field, entry.after)}`
  const listed = (values: Record<string, unknown>) => visible(entry.changed).map((field) => `${label(field)}: ${shown(field, values)}`)
  const idsLine = idsOnly(entry)
  const reason = entry.reason ? [`Reason: ${clip(entry.reason)}`] : []

  if (entry.targetType === 'table') return describeTableEntry(entry, lookups, phaseName, change)
  // The one-time launch reset (docs/design/launch-reset.md): written by the maintainer's script, not by the app, when the pre-launch phase's test data was
  // erased. The numbers are what was erased; nothing else about it can be read from the Log, which is the point of the entry.
  if (entry.targetType === 'ledger') {
    const erased = (field: string) => (typeof entry.before[field] === 'number' ? entry.before[field] as number : 0)
    return {
      title: `Erased the test data of ${item}, once, for good`,
      details: [`${erased('awards')} awards, ${erased('priorities')} loot priorities and ${erased('auditEntries')} Log entries about them were erased, and the guild was sealed: this cannot be done again.`, ...(entry.reason ? [`Reason: ${clip(entry.reason)}`] : [])],
    }
  }
  if (entry.targetType === 'phase') {
    // A phase was started or reopened: the history gained or lost its last name, and the current phase changed. Or (an edit, RAID-019) the start
    // dates were set or corrected. The dates read as one line per phase, after the other fields.
    const history = (values: Record<string, unknown>) => (Array.isArray(values.phaseHistory) ? values.phaseHistory.map(String) : [])
    const now = typeof entry.after.currentPhase === 'string' ? entry.after.currentPhase : entry.item
    const closed = history(entry.after).at(-1)
    const left = typeof entry.before.currentPhase === 'string' ? entry.before.currentPhase : ''
    const dates = startDateLines(entry, phaseName)
    const others = entry.changed.filter((field) => field !== 'phaseStarts').map(change)
    if (entry.action === 'edit') {
      const only = dates.length === 1 ? dates[0] : undefined
      const title = !only ? 'Changed the start dates of the loot phases'
        : `${!only.was ? 'Set' : !only.is ? 'Removed' : 'Changed'} the start date of ${quote(phaseName(only.no))}`
      return { title, details: [...dates.map((date) => date.line), ...others] }
    }
    if (entry.action === 'reopen') return { title: `Reopened ${quote(now)}`, details: [left ? `${quote(left)} is the next phase again` : 'The phase being left is the next phase again', ...others, ...dates.map((date) => date.line)] }
    return { title: `Started ${quote(now)}`, details: [closed ? `${quote(closed)} is closed and read-only` : 'The previous phase is closed and read-only', ...others, ...dates.map((date) => date.line)] }
  }
  if (entry.targetType === 'priority') {
    switch (entry.action) {
      case 'create': return { title: `Added ${item} to the list`, details: listed(entry.after) }
      case 'delete': return { title: `Removed ${item} from the list`, details: listed(entry.before) }
      case 'reorder': return { title: `Reordered the candidates for ${item}`, details: [`Before: ${shown('rankedPlayers', entry.before)}`, `After: ${shown('rankedPlayers', entry.after)}`, ...reason] }
      default: {
        // A priority taken off the list is kept (hidden), and put back by taking the field away: say so, not "hidden: (none) to true".
        if (entry.changed.includes('hidden')) {
          const off = entry.after.hidden === true
          return { title: off ? `Took ${item} off the list (its priorities are kept)` : `Put ${item} back on the list`, details: [...visible(entry.changed).filter((field) => field !== 'hidden').map(change), ...reason] }
        }
        return { title: `Changed ${item}`, details: [...(idsLine ? [idsLine] : []), ...visible(entry.changed).map(change), ...reason] }
      }
    }
  }
  if (entry.targetType === 'award') {
    switch (entry.action) {
      case 'create': {
        const who = typeof entry.after.recipient === 'string' ? entry.after.recipient : 'someone'
        return { title: `Awarded ${item} to ${who}`, details: listed(entry.after).filter((line) => !/^(Item|Recipient|Priority):/.test(line)) }
      }
      case 'remove': {
        const to = lookups.awardRecipient?.(entry.targetId)
        return { title: `Removed the award of ${item}${to ? ` to ${to}` : ''}`, details: [...visible(entry.changed).filter((field) => field !== 'status' && field !== 'removedReason').map(change), ...reason] }
      }
      default: {
        // A removed award put back is an edit that makes it active again (and takes the reason away).
        if (entry.changed.includes('status') && entry.after.status === 'active') {
          const to = lookups.awardRecipient?.(entry.targetId)
          const was = typeof entry.before.removedReason === 'string' && entry.before.removedReason.trim() ? [`It was removed because: ${clip(entry.before.removedReason)}`] : []
          return { title: `Restored the award of ${item}${to ? ` to ${to}` : ''}`, details: [...was, ...visible(entry.changed).filter((field) => field !== 'status' && field !== 'removedReason').map(change), ...reason] }
        }
        // A receipt moved to someone else: one entry that says who had it and who has it now.
        if (entry.changed.includes('recipient') && typeof entry.before.recipient === 'string' && typeof entry.after.recipient === 'string') {
          return { title: `Moved the award of ${item} from ${entry.before.recipient} to ${entry.after.recipient}`, details: [...visible(entry.changed).filter((field) => field !== 'recipient').map(change), ...reason] }
        }
        return { title: `Corrected the award of ${item}`, details: [...visible(entry.changed).map(change), ...reason] }
      }
    }
  }
  return { title: `${entry.action} ${entry.targetType} ${item}`, details: [...entry.changed.map(change), ...reason] }
}
