// Structural types, so this file has no imports and Node can run its tests directly. GuildSettings (guildApi.ts) satisfies PhaseSettings.

// Phases of the loot lists. A phase is a number, not a name, so renaming one in Settings can never split its lists.
//
// Settings keep the name of the current phase (`currentPhase`), the name of the next one (`nextPhase`) and the names of the finished
// ones, oldest first (`phaseHistory`). The number of the current phase is the length of that list; a guild that has never closed a
// phase is in phase 0. A priority or an award carries `phaseNo`; none means phase 0, so everything recorded before phases existed
// belongs to the first phase and nothing has to be migrated. Past phases are read-only. The next phase can be prepared ahead of time.
//
// Settings also keep the day each phase started (`phaseStarts`, RAID-019; see "Start dates" below), so a raid can be placed in a phase by its date.

export const PHASE_HISTORY_MAX = 30

export type PhaseSettings = { currentPhase: string; nextPhase: string; phaseHistory?: string[]; phaseStarts?: string[]; phaseRev?: number }
export type PhaseKind = 'past' | 'current' | 'next'
export type PhaseOption = { no: number; name: string; kind: PhaseKind }

// A whole number of 0 or more. Anything else, including a number stored as text, is not a phase.
export const isPhaseNo = (value: unknown): value is number => typeof value === 'number' && Number.isInteger(value) && value >= 0

// The phase a priority or an award belongs to.
export const phaseNoOf = (record: { phaseNo?: unknown }) => (isPhaseNo(record.phaseNo) ? record.phaseNo : 0)

// The finished phases, oldest first, as stored in Settings. Their count is the number of the current phase, so an entry that cannot be read
// keeps its place under a placeholder name instead of being dropped. A history that is missing, empty or not a list gives undefined.
export function readPhaseHistory(value: unknown, readName: (entry: unknown, fallback: string) => string): string[] | undefined {
  if (!Array.isArray(value) || value.length === 0) return undefined
  return value.slice(0, PHASE_HISTORY_MAX).map((entry, index) => readName(entry, `Phase ${index + 1}`))
}

// A copy of a priority or award without a phaseNo or carriedFrom that cannot be trusted (see the normalizers in shared/lib/normalize.ts).
export function withoutBadPhaseFields<T extends object>(record: T): T {
  const clean: T & { phaseNo?: unknown; carriedFrom?: unknown } = { ...record }
  if (clean.phaseNo !== undefined && !isPhaseNo(clean.phaseNo)) delete clean.phaseNo
  if (clean.carriedFrom !== undefined && !(typeof clean.carriedFrom === 'string' && clean.carriedFrom !== '')) delete clean.carriedFrom
  return clean
}

// How many times a phase has been started or reopened. Each one is in the Log under the entry id `phase_settings_{phaseRev}`, written in the
// same batch as the settings (so the number can be used only once), and the rules accept a change of the phase history only with the next number.
export const PHASE_REV_MAX = 1_000_000
export const isPhaseRev = (value: unknown): value is number => typeof value === 'number' && Number.isInteger(value) && value >= 1 && value <= PHASE_REV_MAX
export const nextPhaseRev = (settings: { phaseRev?: unknown }) => (isPhaseRev(settings.phaseRev) ? settings.phaseRev : 0) + 1

export const currentPhaseNo = (settings: Partial<PhaseSettings>) => settings.phaseHistory?.length ?? 0

// Every phase that can be looked at, newest first: the next one (only when asked for), the current one, then the finished ones.
export function phaseOptions(settings: PhaseSettings, includeNext: boolean): PhaseOption[] {
  const current = currentPhaseNo(settings)
  const history = settings.phaseHistory ?? []
  return [
    ...(includeNext ? [{ no: current + 1, name: settings.nextPhase, kind: 'next' as const }] : []),
    { no: current, name: settings.currentPhase, kind: 'current' as const },
    ...history.map((name, no) => ({ no, name, kind: 'past' as const })).reverse(),
  ]
}

// The phase to show: the one asked for, or the current phase when none was asked for or the one asked for is not available.
export function viewedPhase(settings: PhaseSettings, wanted: number | null, includeNext: boolean): PhaseOption {
  const options = phaseOptions(settings, includeNext)
  return options.find((option) => option.no === wanted) ?? options.find((option) => option.kind === 'current')!
}

// The name of a phase by number: a finished phase's name from the history, the current and next phase's from the settings. A number nothing
// names (an entry from before the history was edited, say) reads as "Phase <n>".
export function phaseName(settings: PhaseSettings, no: number): string {
  const options = phaseOptions(settings, true)
  return options.find((option) => option.no === no)?.name ?? `Phase ${no}`
}

export const phaseLabel = (option: PhaseOption) => (option.kind === 'past' ? `${option.name} (finished)` : `${option.name} (${option.kind})`)

// Starting and reopening a phase. Both are one save of the settings document, so nothing about a priority or an award changes: the lists of
// the next phase are already filed under the number that becomes the current one. The rules (validPhaseHistory) accept exactly these two moves.

export const NEXT_PHASE_PLACEHOLDER = 'To be announced'
export const PHASE_NAME_MAX = 40

type PhaseStatus = { currentStatusLabel: string; currentStatusTone: string; nextStatusLabel: string; nextStatusTone: string }
export type RollableSettings = PhaseSettings & PhaseStatus

const sameName = (a: string, b: string) => a.trim().replace(/\s+/g, ' ').toLowerCase() === b.trim().replace(/\s+/g, ' ').toLowerCase()

// The words a Guild Leader types to start a phase ("Start Phase 2"), and whether what was typed matches them: case and extra spaces do not matter,
// nothing else may differ.
export const startPhrase = (name: string) => `Start ${name.trim()}`
export const matchesPhrase = (typed: string, phrase: string) => typed.trim() !== '' && sameName(typed, phrase)

// Why a name cannot be the next phase's, or undefined when it can. A name already used is refused so two phases never look alike in the list.
export function startPhaseProblem(settings: PhaseSettings, name: string): string | undefined {
  const trimmed = name.trim()
  if (!trimmed) return 'Enter a name for the new phase.'
  if (trimmed.length > PHASE_NAME_MAX) return `A phase name can be up to ${PHASE_NAME_MAX} characters.`
  if (sameName(trimmed, NEXT_PHASE_PLACEHOLDER)) return `Give the phase a real name, not "${NEXT_PHASE_PLACEHOLDER}".`
  if ([settings.currentPhase, ...(settings.phaseHistory ?? [])].some((used) => sameName(used, trimmed))) return 'A phase with this name already exists.'
  if ((settings.phaseHistory?.length ?? 0) >= PHASE_HISTORY_MAX) return `A guild can have up to ${PHASE_HISTORY_MAX} finished phases.`
  return undefined
}

// The settings after the current phase closes: its name goes on the end of the history, the new name becomes current and Active, and the
// next phase is blank again. A leader can change the status label and color in Settings. `startedOn` is the new phase's start date (the app
// passes today in Eastern Time, easternDateOf), recorded in the same save; the phases between the last dated one and the new one stay without a
// date. Without it the dates are left as they are and the new phase has none.
export function startNextPhase<T extends RollableSettings>(settings: T, name: string, startedOn?: string): T {
  return {
    ...settings,
    phaseHistory: [...(settings.phaseHistory ?? []), settings.currentPhase],
    ...(startedOn ? { phaseStarts: withDateAt(settings.phaseStarts, currentPhaseNo(settings) + 1, startedOn) } : {}),
    currentPhase: name.trim(),
    nextPhase: NEXT_PHASE_PLACEHOLDER,
    currentStatusLabel: 'Active',
    currentStatusTone: 'active',
    nextStatusLabel: 'Not started',
    nextStatusTone: 'paused',
  }
}

// The settings after the last finished phase is reopened: its name is current again and the phase being left is the next one. The current
// status stays as it is (the reopened phase is live) and the next phase's status is blank. A history that becomes empty is left out, and so
// is the start date of the phase being left (the next phase has none); a list of dates that becomes empty is left out too.
export function reopenPhase<T extends RollableSettings>(settings: T): T {
  const history = settings.phaseHistory ?? []
  const { phaseHistory: _dropped, phaseStarts: _droppedStarts, ...rest } = settings
  const starts = trimmedStarts((settings.phaseStarts ?? []).slice(0, history.length))
  return {
    ...rest,
    ...(history.length > 1 ? { phaseHistory: history.slice(0, -1) } : {}),
    ...(starts.length ? { phaseStarts: starts } : {}),
    currentPhase: history[history.length - 1],
    nextPhase: settings.currentPhase,
    nextStatusLabel: 'Not started',
    nextStatusTone: 'paused',
  } as T
}

// Why the last phase cannot be reopened, or undefined when it can. Awards recorded in the current phase would end up in the next one, and a
// list prepared for the phase after the next would end up two phases ahead, where nothing can reach it.
export function reopenProblem(settings: PhaseSettings, awards: { phaseNo?: unknown }[], priorities: { phaseNo?: unknown }[]): string | undefined {
  const current = currentPhaseNo(settings)
  if (current === 0) return 'There is no finished phase to reopen.'
  if (awards.some((award) => phaseNoOf(award) === current)) return `Loot has been awarded in ${settings.currentPhase}, so it cannot be undone.`
  if (priorities.some((priority) => phaseNoOf(priority) > current)) return `A list has been prepared for the phase after ${settings.currentPhase}. Remove it first.`
  return undefined
}

// Start dates (RAID-019). `phaseStarts` holds one Eastern calendar date "YYYY-MM-DD" per phase, in the order of their numbers (the finished
// phases, oldest first, then the current one; the next phase has none), or '' for a phase whose start is not known (one from before dates were
// kept, or one nobody has dated yet). The list is never longer than the phases there are and never ends with a blank, so a guild with no dates has
// none at all, and the dates never go backwards: a later phase cannot start before an earlier one (two can start on the same day). The rules
// (validPhaseStarts, and the phase entry, which checks the order) hold the same, and every change is a step of `phaseRev` with its entry in the
// Log, like a start or a reopen. Starting a phase records today as its start (startNextPhase) and reopening one takes its date away (reopenPhase).

/** A date as the rules accept it: "YYYY-MM-DD", month 01 to 12, day 01 to 31. */
const PHASE_DATE = /^\d{4}-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])$/
export const isPhaseDate = (value: unknown): value is string => typeof value === 'string' && PHASE_DATE.test(value)

/** A day that is on the calendar (not 2026-02-30), for what a leader types. */
export function isCalendarDate(value: string): boolean {
  if (!isPhaseDate(value)) return false
  const day = new Date(`${value}T12:00:00Z`)
  return !Number.isNaN(day.getTime()) && day.toISOString().slice(0, 10) === value
}

const easternDay = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit' })
/** The Eastern calendar date of an instant, "YYYY-MM-DD" (raids are dated the same way). */
export const easternDateOf = (ms: number) => easternDay.format(ms)

/** "2026-10-29" as "Oct 29, 2026" (a plain date, so it never shifts with the viewer's time zone). */
export function phaseDateLabel(date: string): string {
  const day = new Date(`${date}T12:00:00Z`)
  return Number.isNaN(day.getTime()) ? date : day.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric', timeZone: 'UTC' })
}

// The list without blanks at the end (the rules refuse a list that ends with one).
function trimmedStarts(starts: string[]): string[] {
  let end = starts.length
  while (end > 0 && !starts[end - 1]) end -= 1
  return starts.slice(0, end)
}

// A copy of the list with `date` at phase `no` (blanks for the phases before it that have none), or with that phase's date taken away (null).
function withDateAt(starts: string[] | undefined, no: number, date: string | null): string[] {
  const next = [...(starts ?? [])]
  while (next.length <= no) next.push('')
  next[no] = date ?? ''
  return trimmedStarts(next)
}

/**
 * The start dates as stored, read tolerantly: a list, cut to the phases there are (`phaseCount`, the finished ones and the current one), with any
 * entry that is not a date read as no date, and the blanks at the end left off. A missing, empty or unreadable list gives undefined. What the rules
 * accept is read back unchanged, so saving the other settings never changes the dates.
 */
export function readPhaseStarts(value: unknown, phaseCount: number): string[] | undefined {
  if (!Array.isArray(value)) return undefined
  const starts = trimmedStarts(value.slice(0, Math.max(0, phaseCount)).map((entry) => (isPhaseDate(entry) ? entry : '')))
  return starts.length ? starts : undefined
}

/** The start date of a phase, or undefined when it has none (the next phase never has one). */
export function phaseStartOf(settings: Pick<PhaseSettings, 'phaseHistory' | 'phaseStarts'>, no: number): string | undefined {
  if (!isPhaseNo(no) || no > currentPhaseNo(settings)) return undefined
  const date = settings.phaseStarts?.[no]
  return date ? date : undefined
}

/** Whether any finished or current phase has a start date. */
export const hasPhaseStarts = (settings: Pick<PhaseSettings, 'phaseHistory' | 'phaseStarts'>) => (settings.phaseStarts ?? []).slice(0, currentPhaseNo(settings) + 1).some(Boolean)

/**
 * The settings with the start date of phase `no` (a finished phase or the current one) set to `date`, or taken away with null. Check it first with
 * phaseStartProblem. A list that ends up with no dates is left out.
 */
export function withPhaseStart<T extends PhaseSettings>(settings: T, no: number, date: string | null): T {
  const { phaseStarts: _dropped, ...rest } = settings
  const starts = withDateAt(settings.phaseStarts?.slice(0, currentPhaseNo(settings) + 1), no, date)
  return { ...rest, ...(starts.length ? { phaseStarts: starts } : {}) } as T
}

/**
 * Why `date` cannot be the start of phase `no`, in words a leader can act on, or undefined when it can: it has to be a real day, not after today
 * (Eastern Time, `today` from easternDateOf), not before the start of the nearest earlier phase that has one, and not after the start of the
 * nearest later one (the list is in order, so the nearest ones are enough).
 */
export function phaseStartProblem(settings: PhaseSettings, no: number, date: string, today: string): string | undefined {
  if (!isPhaseNo(no) || no > currentPhaseNo(settings)) return 'Only a finished phase or the current one has a start date.'
  if (!isCalendarDate(date)) return 'Enter a real date, for example 2026-10-29.'
  if (date > today) return `A phase cannot start after today (${phaseDateLabel(today)}).`
  const name = phaseName(settings, no)
  const starts = settings.phaseStarts ?? []
  for (let earlier = no - 1; earlier >= 0; earlier -= 1) {
    const start = starts[earlier]
    if (!start) continue
    if (start > date) return `${phaseName(settings, earlier)} started on ${phaseDateLabel(start)}, so ${name} cannot start before that. Choose ${phaseDateLabel(start)} or later, or correct ${phaseName(settings, earlier)} first.`
    break
  }
  for (let later = no + 1; later <= currentPhaseNo(settings); later += 1) {
    const start = starts[later]
    if (!start) continue
    if (start < date) return `${phaseName(settings, later)} started on ${phaseDateLabel(start)}, so ${name} cannot start after that. Choose ${phaseDateLabel(start)} or earlier, or correct ${phaseName(settings, later)} first.`
    break
  }
  return undefined
}

/**
 * Why a phase cannot be started today, or undefined when it can: the new phase starts today, so no phase may have a start date after today (one
 * typed by another leader's clock, say). The list is in order, so its last date is the latest.
 */
export function startTodayProblem(settings: PhaseSettings, today: string): string | undefined {
  for (let no = currentPhaseNo(settings); no >= 0; no -= 1) {
    const start = phaseStartOf(settings, no)
    if (!start) continue
    return start > today ? `${phaseName(settings, no)} starts on ${phaseDateLabel(start)}, after today, so a phase started today would start before it. Correct that date under Start dates first.` : undefined
  }
  return undefined
}

/**
 * The phase a date ("YYYY-MM-DD", Eastern, as a raid's date is) belongs to: the latest phase whose start date is on or before it. A phase with no
 * start date is passed over, so its days count for the nearest earlier phase that has one. A date before every start date belongs to the first
 * phase when nothing else could have come before it (the earliest dated phase is the first or the second); otherwise it cannot be placed. With
 * no start dates at all nothing can be placed: undefined. Only the finished phases and the current one have dates, so the next one is never given.
 */
export function phaseOfDate(settings: Pick<PhaseSettings, 'phaseHistory' | 'phaseStarts'>, date: string): number | undefined {
  let earliest: number | undefined
  for (let no = currentPhaseNo(settings); no >= 0; no -= 1) {
    const start = phaseStartOf(settings, no)
    if (start === undefined) continue
    if (start <= date) return no
    earliest = no
  }
  return earliest !== undefined && earliest <= 1 ? 0 : undefined
}
