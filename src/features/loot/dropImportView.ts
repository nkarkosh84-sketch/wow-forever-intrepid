// What the drop list import panel (DropImportPanel.tsx, LOOT-008) shows and does with the leader's clicks, as pure functions so Node tests them.
// dropImport.ts does the matching and builds the writes; this holds only the panel's own choices. Only types and pure functions are imported.
import { looksLikeCapture, mergeDrops, readCapturePaste, readDropsPaste, type CandidateZone } from '../../shared/game/dropsString.ts'
import { zoneDocId } from '../../shared/game/guildTables.ts'
import {
  buildPreview, importZoneKey, madeZoneColors, zoneIdFor, type CreatureAnswer, type CreatureRow, type ImportAnswers, type ImportCounts, type ImportPreview, type ImportSetup, type ItemRow,
  type ZoneAnswer, type ZoneRow,
} from './dropImport.ts'

export const plural = (count: number, one: string, many: string) => `${count} ${count === 1 ? one : many}`

export function countsText(counts: ImportCounts): string {
  const parts = [
    counts.newZones ? `${plural(counts.zones, 'zone', 'zones')} (${counts.newZones} new)` : plural(counts.zones, 'zone', 'zones'),
    counts.newCreatures ? `${plural(counts.creatures, 'creature', 'creatures')} (${counts.newCreatures} new)` : plural(counts.creatures, 'creature', 'creatures'),
    plural(counts.items, 'item', 'items'),
    ...(counts.journalItems ? [`${counts.journalItems} from DungeonJournal`] : []),
  ]
  return parts.join(', ')
}

/** Nothing would be written: no zone, creature or item is saved. Both Save buttons are off then. */
export const nothingToSave = (counts: ImportCounts | undefined) => !counts || (counts.items + counts.journalItems === 0 && counts.creatures === 0 && counts.zones === 0)

/** The confirm button: the phase the writes go into, and the counts. */
export const confirmLabel = (phase: string, counts: ImportCounts) => `Save to ${phase}: ${countsText(counts)}`

/** What a confirm step was opened for. It holds only while the phase picked in the editor and the pasted text are the same. */
export type ConfirmFor = { phaseNo: number; text: string }
export const confirmHolds = (open: ConfirmFor | null, phaseNo: number, text: string) => open !== null && open.phaseNo === phaseNo && open.text === text

/**
 * Whether a zone's block is open: when there is something to save or decide. A zone a leader took out of the phase is open, so its "Put it back"
 * shows, and so is one with a question the leader answered (a pick, "same as …" or "new"), so answering never closes the block they are in. A zone
 * whose rows are all already listed starts closed.
 */
export function zoneOpen(zone: ZoneRow): boolean {
  const anything = zone.creatures.some((creature) => creature.saved || creature.creatureTickable || creature.status === 'unmatched' || creature.differs || creature.items.some((item) => item.tickable))
  const answered = zone.picks.length > 0 || zone.creatures.some((creature) => creature.answerKeys !== undefined)
  return zone.status !== 'matched' || zone.takenOut || answered || anything
}

/** The chip on a zone's summary line, if any. */
export function zoneChip(zone: ZoneRow, phase: string): { text: string; added: boolean } | undefined {
  if (zone.status === 'new') return { text: 'new zone', added: true }
  if (zone.takenOut) return { text: `taken out of ${phase}`, added: false }
  if (zone.status === 'matched' && zone.tickIn) return { text: `not in ${phase} yet`, added: false }
  return undefined
}

/** The counts line under the preview: what the save holds, and what is left out (unanswered questions, zones a leader took out and nobody put back). */
export function countsLine(counts: ImportCounts, zones: ZoneRow[], phase: string): string {
  const out = zones.filter((zone) => zone.takenOut && !zone.zoneTicked).length
  const left = [
    ...(counts.unanswered ? [`${plural(counts.unanswered, 'question', 'questions')} unanswered: left out.`] : []),
    ...(out ? [`${plural(out, 'zone', 'zones')} taken out of ${phase}: left out.`] : []),
  ]
  return left.length ? `${countsText(counts)}. ${left.join(' ')}` : countsText(counts)
}

/**
 * The Zone selects of a zone's block: which answer each one sets, and its label. An unmatched zone, or one a Guild Leader makes, has its own. A zone
 * that pasted zones were picked into has one per pick, named for the pasted zone, so each pick can be changed or taken back (Choose), also when the
 * zone matched by itself too.
 */
export function zoneSelects(zone: ZoneRow): { answerKey: string; label: string }[] {
  if (zone.status !== 'matched') return [{ answerKey: zone.id, label: 'Zone' }]
  return zone.picks.map((pick) => ({ answerKey: pick.answerKey, label: `Zone for ${pick.name}` }))
}

/**
 * The pasted zone an answer key belongs to (its instance, else its name's key, as dropImport.ts keys a candidate's answers), so "Make a new zone" from a
 * pick gets the id fixed from that zone's own instance.
 */
export const answerSubject = (answerKey: string, candidates: CandidateZone[]): Partial<CandidateZone> =>
  candidates.find((candidate) => `u${candidate.instanceId ?? importZoneKey(candidate.name)}` === answerKey) ?? {}

/**
 * A Zone select's value as an answer: Choose clears it, "new" makes a zone, else a pick. The zone to make gets `made`, the id this pasted zone was given
 * before, else one now (zoneIdFor), so its id doesn't change while the preview is open.
 */
export function zoneAnswer(value: string, subject: { instanceId?: number }, taken: Set<number>, made?: number): ZoneAnswer | undefined {
  if (value === '') return undefined
  return value === 'new' ? { make: true, zoneId: made ?? zoneIdFor(subject, taken) } : { pick: Number(value) }
}

/**
 * The answers after a Zone select is changed. The id "Make a new zone" gives the pasted zone is kept with the answers, so choosing it again after a pick
 * or Choose gives the same id back, and the answers under that zone come back with it.
 */
export function chooseZone(answers: ImportAnswers, answerKey: string, value: string, subject: { instanceId?: number }, taken: Set<number>): ImportAnswers {
  const answer = zoneAnswer(value, subject, taken, answers.made?.[answerKey])
  const made = answer && 'make' in answer && answer.zoneId !== undefined ? { made: { ...answers.made, [answerKey]: answer.zoneId } } : {}
  return { ...answers, zones: { ...answers.zones, [answerKey]: answer }, ...made }
}

/**
 * A creature block's React key. A row's id is the key of the creature it writes to, so answering "same as …" moves it to that creature: a row with a
 * question is keyed by the question's first answer key instead, so answering keeps its block, and the select in it, mounted.
 */
export const creatureBlockKey = (row: CreatureRow): string => row.answerKeys?.[0] ?? row.id

/** A creature's "Same as" select: the creature its answer names, "new" for a new creature, or "" (Choose) when it has no answer that applies here. */
export const sameAsValue = (row: CreatureRow): string => (row.answer ? ('same' in row.answer ? row.answer.same : 'new') : '')

/**
 * The answers after a creature's "Same as" select is changed: the answer is written under every pasted creature the row has (each pasted zone of the
 * block that lists it), so taking back one of those picks keeps it. Choose ("") clears it under each.
 */
export function answerSameAs(answers: ImportAnswers, row: CreatureRow, value: string): ImportAnswers {
  const answer: CreatureAnswer | undefined = value === '' ? undefined : value === 'new' ? { make: true } : { same: value }
  return { ...answers, creatures: { ...answers.creatures, ...Object.fromEntries((row.answerKeys ?? []).map((key) => [key, answer])) } }
}

/**
 * The items "Tick DungeonJournal's items" ticks under a creature: its new DungeonJournal items, never one a leader took off (that stays a tick of its
 * own). None under a creature a leader took out: the leader ticks Bring back first.
 */
export const journalToTick = (row: CreatureRow): ItemRow[] => (row.status === 'takenOut' ? [] : row.items.filter((item) => item.journalOnly && item.tickable && item.status === 'new'))

/** The answers after "Tick DungeonJournal's items": those items ticked, and a new creature with them, so a guessed or unticked one is saved too. */
export function tickJournal(answers: ImportAnswers, row: CreatureRow): ImportAnswers {
  const ticks = { ...answers.ticks }
  for (const item of journalToTick(row)) ticks[item.id] = true
  if (row.status === 'new') ticks[row.id] = true
  return { ...answers, ticks }
}

/**
 * The answers after an item's checkbox is clicked. Ticking an item under a creature that isn't saved (a guessed boss, a new one the leader unticked,
 * one a leader took out) ticks the creature too, so the click never vanishes, and only that item: every other item of it the leader hasn't answered is
 * unticked, also one that can't be ticked now (no room before the click frees some), so none comes in ticked by default with it. A new creature whose items alone decide it (no item ticked by default) is left to the
 * model, so unticking its last item leaves it as the model decides. Unticking never changes the creature.
 */
export function tickItem(answers: ImportAnswers, row: CreatureRow, item: ItemRow, value: boolean): ImportAnswers {
  const ticks = { ...answers.ticks, [item.id]: value }
  const itemDecides = row.status === 'new' && !row.guessed && answers.ticks[row.id] === undefined
  if (value && !row.saved && row.creatureTickable && !itemDecides) {
    ticks[row.id] = true
    for (const other of row.items) if (other !== item && answers.ticks[other.id] === undefined) ticks[other.id] = false
  }
  return { ...answers, ticks }
}

/** The zones a save made whose zone document a batch of the first call wrote (writeLootTables' onWritten ids): they get their color even when a later batch fails. */
export const madeZonesWritten = (made: number[], ids: string[], phaseNo: number) => made.filter((zoneId) => ids.includes(zoneDocId(zoneId, phaseNo)))

/**
 * Saves the suggested colors of zones the import made (madeZoneColors), as Settings gives a zone it makes: `save` is saveZoneColors. A zone with a color
 * chosen keeps it. Never throws: it gives how many zones keep the automatic color because their colors couldn't be saved.
 */
export async function colorMadeZones(zoneIds: number[], setup: Pick<ImportSetup, 'captures' | 'docs' | 'catalog' | 'currentPhase'>, chosen: Readonly<Record<string, string>>, save: (colors: Record<string, string>) => Promise<void>): Promise<number> {
  const colors = madeZoneColors(zoneIds, setup, chosen)
  const count = Object.keys(colors).length
  if (!count) return 0
  try { await save(colors); return 0 } catch { return count }
}

/** What the save's message adds when a zone it made keeps the automatic color. */
export const keptColorText = (count: number) => `${plural(count, 'new zone keeps its', 'new zones keep their')} automatic color.`

/** A chosen file's text, or a message when the browser can't read it (moved, or no permission): never a rejection nobody sees. */
export const readFileText = (file: { text(): Promise<string> }): Promise<{ text: string } | { error: string }> =>
  file.text().then((text) => ({ text }), () => ({ error: "The file couldn't be read." }))

/** What the pasted text is: the addon's drops strings or a capture file, read into candidate zones, or why it can't be read. */
export type Paste = { from: 'addon' | 'capture'; zones: CandidateZone[]; ids: string[]; skipped: number } | { errors: string[] } | null

/** The readers readPaste uses (shared/game/dropsString.ts); a test can pass its own. */
export const pasteReaders = { looksLikeCapture, readCapturePaste, readDropsPaste, mergeDrops }

/** The pasted text, read. It never throws: the panel reads it on every keystroke, so an exception from reading or merging is shown as a paste error. */
export function readPaste(text: string, readers = pasteReaders): Paste {
  if (!text.trim()) return null
  try {
    if (readers.looksLikeCapture(text)) {
      const read = readers.readCapturePaste(text)
      return read.ok ? { from: 'capture', zones: read.zones, ids: [], skipped: 0 } : { errors: read.errors }
    }
    const read = readers.readDropsPaste(text)
    if (!read.ok) return { errors: [read.message] }
    return { from: 'addon', zones: readers.mergeDrops(read.strings.map((one) => one.model)), ids: read.strings.map((one) => one.model.id), skipped: read.strings.reduce((count, one) => count + one.rowErrors.length, 0) }
  } catch (error) {
    return { errors: [error instanceof Error && error.message ? `The text couldn't be read: ${error.message}` : "The text couldn't be read."] }
  }
}

/** The preview of the pasted zones, or the error to show with the paste's. It never throws: the panel builds it on every answer. `build` is for a test. */
export function previewOf(zones: CandidateZone[], setup: ImportSetup, answers: ImportAnswers, build = buildPreview): { preview: ImportPreview } | { errors: string[] } {
  try {
    return { preview: build(zones, setup, answers) }
  } catch (error) {
    return { errors: [error instanceof Error && error.message ? `The preview couldn't be made: ${error.message}` : "The preview couldn't be made."] }
  }
}

/** An import this large into the live phase is pointed at the next phase (design section 7). */
export const LARGE_IMPORT = 20

/**
 * The line the confirm step shows when the import is large and the phase picked is the live one: `nextPhase` is the next phase's name, given only
 * then (TablesEditor.tsx knows which phase is current).
 */
export function nextPhaseHint(counts: ImportCounts, phase: string, nextPhase: string | undefined): string | undefined {
  if (nextPhase === undefined || counts.items + counts.journalItems < LARGE_IMPORT) return undefined
  return `${phase} is live: everyone sees this import at once. To prepare it for later, pick ${nextPhase} below.`
}
