import type { Timestamp } from 'firebase/firestore'

const lineupKeys = {
  10: ['blue', 'yellow', 'red', 'white'],
  20: ['green', 'pink'],
  40: ['brown'],
} as const
const signupStatuses = ['accept', 'tentative', 'absent', 'late', 'bench'] as const

/**
 * The statuses of a starting snapshot that Raid History reads and the rules let active members read (RAID-015). The capture writes the manifest as `capturing`,
 * then its create-only records, then `complete`; a terminal failure makes it `failed`, and a failure before the manifest existed leaves a small failed record.
 */
export const visibleSnapshotStatuses = ['capturing', 'complete', 'failed'] as const
export type SnapshotStatus = typeof visibleSnapshotStatuses[number]

type UnknownRecord = Record<string, unknown>

export class SnapshotDataError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'SnapshotDataError'
  }
}

export type SnapshotManifest = {
  raidId: string
  status: SnapshotStatus
  /** The small failed record of a capture that failed before it wrote anything: no lineups, no counts, no child records. */
  notice: boolean
  raid: { name: string; date: string }
  scheduledStartAt: Timestamp
  /** When the capture finished; only a complete snapshot has it. */
  capturedAt: Timestamp | null
  failedAt: Timestamp | null
  failureCode: string | null
  lineupSizes: (10 | 20 | 40)[]
  counts: { lineups: number; characters: number; accounts: number } | null
}

export type SnapshotTeam = { key: string; name: string; characterIds: string[] }
export type SnapshotLineup = { size: 10 | 20 | 40; teams: SnapshotTeam[]; bench: string[] }

/** What a snapshot's manifest says about the capture as a whole, shared by every entry made from it (RAID-015). */
export type SnapshotProgress = {
  status: SnapshotStatus
  /** The records the capture planned (lineups, characters and accounts), or null for a failure notice, which planned none. */
  expected: number | null
  /** The records that existed when Raid History read them, or null for a complete snapshot (all of them) and a failure notice. */
  written: number | null
  failureCode: string | null
  failedAt: Timestamp | null
}

type SnapshotEntryBase = {
  id: string
  snapshotPath: string
  raidId: string
  raidName: string
  scheduledStartAt: Timestamp
  label: string
  progress: SnapshotProgress
}

/** One team of one lineup size: the entries Raid History has always listed. */
export type SnapshotReport = SnapshotEntryBase & {
  kind: 'team'
  capturedAt: Timestamp | null
  size: 10 | 20 | 40
  expectedAccountCount: number
  teamKey: string
  teamName: string
  characterIds: string[]
  benchIds: string[]
}

/** A lineup the manifest lists that a started or failed capture had not written. It has no teams, and is never shown as an empty one. */
export type SnapshotMissingLineup = SnapshotEntryBase & { kind: 'missing-lineup'; size: 10 | 20 | 40 }

/** A capture that failed before it wrote anything. */
export type SnapshotFailureNotice = SnapshotEntryBase & { kind: 'failure-notice' }

export type SnapshotEntry = SnapshotReport | SnapshotMissingLineup | SnapshotFailureNotice

export type SnapshotPlacement = {
  size: 10 | 20 | 40
  teamKey: string | null
  teamName: string | null
  bench: boolean
}

export type SnapshotCharacter = {
  id: string
  name: string | null
  surname: string | null
  className: string | null
  specialization: string | null
  role: string | null
  accountUid: string | null
  placements: SnapshotPlacement[]
}

export type SnapshotAccount = {
  uid: string
  displayName: string | null
  invited: boolean
  invitationOrder: number | null
  invitationMainId: string | null
  signup: { characterId: string; status: typeof signupStatuses[number]; benchKind?: 'self' } | null
}

/** `notWritten` counts the team and bench characters a started or failed capture had not written; a complete snapshot has none. */
export type SnapshotReportRoster = { team: SnapshotCharacter[]; bench: SnapshotCharacter[]; notWritten: { team: number; bench: number } }
export type SnapshotInvitationRow = {
  account: SnapshotAccount
  invitationCharacter: SnapshotCharacter | null
  signupCharacter: SnapshotCharacter | null
}

function isRecord(value: unknown): value is UnknownRecord {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function isTimestamp(value: unknown): value is Timestamp {
  return isRecord(value) && 'toMillis' in value && typeof value.toMillis === 'function'
}

function requiredString(value: unknown, field: string) {
  if (typeof value !== 'string' || !value) throw new SnapshotDataError(`Snapshot ${field} is missing or invalid.`)
  return value
}

function nullableString(value: unknown, field: string) {
  if (value === null) return null
  if (typeof value !== 'string') throw new SnapshotDataError(`Snapshot ${field} is invalid.`)
  return value
}

function characterIds(value: unknown, field: string) {
  if (!Array.isArray(value) || value.some((id) => typeof id !== 'string' || !id)) {
    throw new SnapshotDataError(`Snapshot ${field} is missing or invalid.`)
  }
  if (new Set(value).size !== value.length) throw new SnapshotDataError(`Snapshot ${field} contains duplicate characters.`)
  return [...value]
}

const isIsoDate = (date: string) => /^\d{4}-\d{2}-\d{2}$/.test(date) && !Number.isNaN(Date.parse(`${date}T12:00:00Z`))
const easternDay = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit' })

/** The Eastern date of an instant, as a raid stores its date. */
function easternDate(at: Timestamp) {
  const parts = Object.fromEntries(easternDay.formatToParts(at.toDate()).map(({ type, value }) => [type, value]))
  return `${parts.year}-${parts.month}-${parts.day}`
}

export function readSnapshotManifest(raidId: string, value: unknown): SnapshotManifest {
  if (!isRecord(value) || value.schemaVersion !== 1 || value.raidId !== raidId || !isTimestamp(value.scheduledStartAt)
    || !visibleSnapshotStatuses.includes(value.status as SnapshotStatus)) {
    throw new SnapshotDataError('Snapshot manifest is missing required data.')
  }
  const status = value.status as SnapshotStatus
  const scheduledStartAt = value.scheduledStartAt
  const failureCode = status === 'failed' ? requiredString(value.failureCode, 'failure code') : null
  const failedAt = status === 'failed' && isTimestamp(value.failedAt) ? value.failedAt : null
  if (status === 'failed' && value.failureNotice === true) {
    // The capture copies the raid's name and date as they were at the start, but it may have failed because they were invalid: show what it can.
    const raid = isRecord(value.raid) ? value.raid : {}
    return {
      raidId,
      status,
      notice: true,
      raid: {
        name: typeof raid.name === 'string' && raid.name ? raid.name : 'Unnamed raid',
        date: typeof raid.date === 'string' && isIsoDate(raid.date) ? raid.date : easternDate(scheduledStartAt),
      },
      scheduledStartAt,
      capturedAt: null,
      failedAt,
      failureCode,
      lineupSizes: [],
      counts: null,
    }
  }
  if (!isRecord(value.raid) || !Array.isArray(value.lineupSizes) || !isRecord(value.counts)
    || (status === 'complete' && !isTimestamp(value.capturedAt))) {
    throw new SnapshotDataError('Snapshot manifest is missing required data.')
  }
  const date = requiredString(value.raid.date, 'raid date')
  if (!isIsoDate(date)) {
    throw new SnapshotDataError('Snapshot raid date is invalid.')
  }
  const lineupSizes = value.lineupSizes
  if (lineupSizes.some((size) => size !== 10 && size !== 20 && size !== 40)
    || new Set(lineupSizes).size !== lineupSizes.length || !lineupSizes.length) {
    throw new SnapshotDataError('Snapshot lineup sizes are missing or invalid.')
  }
  const counts = value.counts
  const lineupsCount = counts.lineups
  const characterCount = counts.characters
  const accountCount = counts.accounts
  if (lineupsCount !== lineupSizes.length
    || typeof characterCount !== 'number' || !Number.isSafeInteger(characterCount) || characterCount < 0
    || typeof accountCount !== 'number' || !Number.isSafeInteger(accountCount) || accountCount < 0) {
    throw new SnapshotDataError('Snapshot record counts are missing or invalid.')
  }
  return {
    raidId,
    status,
    notice: false,
    raid: { name: requiredString(value.raid.name, 'raid name'), date },
    scheduledStartAt,
    capturedAt: status === 'complete' ? value.capturedAt as Timestamp : null,
    failedAt,
    failureCode,
    lineupSizes: [...lineupSizes] as (10 | 20 | 40)[],
    counts: { lineups: lineupSizes.length, characters: characterCount, accounts: accountCount },
  }
}

export function readSnapshotLineup(size: 10 | 20 | 40, value: unknown): SnapshotLineup {
  if (!isRecord(value) || value.size !== size || !Array.isArray(value.teams)) {
    throw new SnapshotDataError(`Published ${size}M lineup is incomplete.`)
  }
  const expectedKeys = lineupKeys[size]
  const teams: SnapshotTeam[] = value.teams.map((team) => {
    if (!isRecord(team) || typeof team.key !== 'string' || typeof team.name !== 'string') {
      throw new SnapshotDataError(`Published ${size}M team data is incomplete.`)
    }
    if (!new Set<string>(expectedKeys).has(team.key)) throw new SnapshotDataError(`Published ${size}M lineup has an unknown team.`)
    return { key: team.key, name: team.name, characterIds: characterIds(team.characterIds, `${size}M team`) }
  })
  if (teams.length !== expectedKeys.length || expectedKeys.some((key) => teams.filter((team) => team.key === key).length !== 1)) {
    throw new SnapshotDataError(`Published ${size}M lineup has missing or duplicate teams.`)
  }
  const bench = characterIds(value.bench, `${size}M bench`)
  const teamCharacterIds = teams.flatMap((team) => team.characterIds)
  const placed = new Set(teamCharacterIds)
  if (placed.size !== teamCharacterIds.length || bench.some((id) => placed.has(id))) {
    throw new SnapshotDataError(`Published ${size}M lineup has duplicate team/bench placements.`)
  }
  return { size, teams, bench }
}

function formattedDate(date: string) {
  const [, year, month, day] = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date) ?? []
  if (!year || !month || !day) throw new SnapshotDataError('Snapshot raid date cannot be formatted.')
  return `${month}-${day}-${year.slice(-2)}`
}

/**
 * The list entries of one snapshot. A complete snapshot gives a report per team of every lineup and must have every lineup. A started or failed one (RAID-015)
 * gives reports for the lineups written so far and a missing-lineup entry for each one not written, never an empty team. A failure notice gives one entry.
 * `written` is how many of its records a started or failed capture had written when they were read.
 */
export function buildSnapshotEntries(snapshotPath: string, manifest: SnapshotManifest, lineups: SnapshotLineup[], written: number | null = null): SnapshotEntry[] {
  const partial = manifest.status !== 'complete'
  const counts = manifest.counts
  const progress: SnapshotProgress = {
    status: manifest.status,
    expected: counts ? counts.lineups + counts.characters + counts.accounts : null,
    written: partial && counts ? written : null,
    failureCode: manifest.failureCode,
    failedAt: manifest.failedAt,
  }
  const base = { snapshotPath, raidId: manifest.raidId, raidName: manifest.raid.name, scheduledStartAt: manifest.scheduledStartAt, progress }
  const date = formattedDate(manifest.raid.date)
  if (manifest.notice || !counts) {
    if (lineups.length) throw new SnapshotDataError('A failed snapshot with no records has lineup records.')
    return [{ ...base, kind: 'failure-notice', id: `${manifest.raidId}:failed`, label: `${date} Starting snapshot` }]
  }
  const bySize = new Map(lineups.map((lineup) => [lineup.size, lineup]))
  if (bySize.size !== lineups.length || lineups.some((lineup) => !manifest.lineupSizes.includes(lineup.size))
    || (!partial && manifest.lineupSizes.some((size) => !bySize.has(size)))) {
    throw new SnapshotDataError('Published snapshot is missing one or more lineup records.')
  }
  const entries = manifest.lineupSizes.flatMap((size): SnapshotEntry[] => {
    const lineup = bySize.get(size)
    if (!lineup) {
      if (!partial) throw new SnapshotDataError(`Published ${size}M lineup is missing.`)
      return [{ ...base, kind: 'missing-lineup', id: `${manifest.raidId}:${size}:missing`, label: `${date} ${size}M`, size }]
    }
    return lineup.teams.map((team) => ({
      ...base,
      kind: 'team' as const,
      id: `${manifest.raidId}:${size}:${team.key}`,
      capturedAt: manifest.capturedAt,
      label: `${date} ${team.name} ${size}M`,
      size,
      expectedAccountCount: counts.accounts,
      teamKey: team.key,
      teamName: team.name,
      characterIds: [...team.characterIds],
      benchIds: [...lineup.bench],
    }))
  })
  return sortSnapshotEntries(entries)
}

export function sortSnapshotEntries(entries: SnapshotEntry[]) {
  const teamOrder = new Map<string, number>(Object.values(lineupKeys).flatMap((keys) => keys.map((key, index) => [key, index] as const)))
  const sizeOf = (entry: SnapshotEntry) => entry.kind === 'failure-notice' ? 0 : entry.size
  const orderOf = (entry: SnapshotEntry) => entry.kind === 'team' ? teamOrder.get(entry.teamKey) ?? 0 : 0
  return [...entries].sort((left, right) =>
    right.scheduledStartAt.toMillis() - left.scheduledStartAt.toMillis()
    || sizeOf(left) - sizeOf(right)
    || orderOf(left) - orderOf(right)
    || left.raidId.localeCompare(right.raidId))
}

export function readSnapshotCharacter(id: string, value: unknown): SnapshotCharacter {
  if (!isRecord(value) || value.id !== id || !Array.isArray(value.placements)) {
    throw new SnapshotDataError(`Snapshot character ${id} is missing or incomplete.`)
  }
  const placements = value.placements.map((placement) => {
    if (!isRecord(placement) || (placement.size !== 10 && placement.size !== 20 && placement.size !== 40)
      || typeof placement.bench !== 'boolean'
      || (placement.teamKey !== null && typeof placement.teamKey !== 'string')
      || (placement.teamName !== null && typeof placement.teamName !== 'string')) {
      throw new SnapshotDataError(`Snapshot placement for ${id} is incomplete.`)
    }
    return {
      size: placement.size,
      teamKey: placement.teamKey,
      teamName: placement.teamName,
      bench: placement.bench,
    } as SnapshotPlacement
  })
  if (new Set(placements.map(({ size }) => size)).size !== placements.length
    || placements.some(({ bench, teamKey, teamName }) => bench ? teamKey !== null || teamName !== null : teamKey === null || teamName === null)) {
    throw new SnapshotDataError(`Snapshot placements for ${id} are duplicated or inconsistent.`)
  }
  return {
    id,
    name: nullableString(value.name, `${id} name`),
    surname: nullableString(value.surname, `${id} surname`),
    className: nullableString(value.className, `${id} class`),
    specialization: nullableString(value.specialization, `${id} specialization`),
    role: nullableString(value.role, `${id} role`),
    accountUid: nullableString(value.accountUid, `${id} account link`),
    placements,
  }
}

/** A complete report must have every character. In a started or failed one, a character not written yet is counted in `notWritten` instead. */
export function buildSnapshotReportRoster(report: SnapshotReport, characters: Map<string, SnapshotCharacter>): SnapshotReportRoster {
  const allIds = [...report.characterIds, ...report.benchIds]
  if (new Set(allIds).size !== allIds.length) throw new SnapshotDataError('Snapshot report contains duplicate team/bench assignments.')
  const partial = report.progress.status !== 'complete'
  const notWritten = { team: 0, bench: 0 }
  const getCharacter = (id: string, bench: boolean): SnapshotCharacter[] => {
    const character = characters.get(id)
    if (!character) {
      if (!partial) throw new SnapshotDataError(`Snapshot character ${id} is missing from the published report.`)
      notWritten[bench ? 'bench' : 'team'] += 1
      return []
    }
    const placed = character.placements.some((entry) => entry.size === report.size
      && entry.bench === bench
      && (bench
        ? entry.teamKey === null && entry.teamName === null
        : entry.teamKey === report.teamKey && entry.teamName === report.teamName))
    if (!placed) throw new SnapshotDataError(`Snapshot placement for ${character.name ?? id} does not match the published lineup.`)
    return [character]
  }
  return {
    team: report.characterIds.flatMap((id) => getCharacter(id, false)),
    bench: report.benchIds.flatMap((id) => getCharacter(id, true)),
    notWritten,
  }
}

export function readSnapshotAccount(uid: string, value: unknown): SnapshotAccount {
  if (!isRecord(value) || value.uid !== uid || typeof value.invited !== 'boolean') {
    throw new SnapshotDataError(`Snapshot account ${uid} is missing or incomplete.`)
  }
  const invitationOrder = value.invitationOrder
  if (invitationOrder !== null && (typeof invitationOrder !== 'number'
    || !Number.isSafeInteger(invitationOrder) || invitationOrder < 0)) {
    throw new SnapshotDataError(`Snapshot invitation order for ${uid} is invalid.`)
  }
  const invitationMainId = value.invitationMainId === null ? null : requiredString(value.invitationMainId, `${uid} invitation character`)
  let signup: SnapshotAccount['signup'] = null
  if (value.signup !== null) {
    if (!isRecord(value.signup) || !signupStatuses.includes(value.signup.status as typeof signupStatuses[number])) {
      throw new SnapshotDataError(`Snapshot signup for ${uid} is missing or invalid.`)
    }
    signup = {
      characterId: requiredString(value.signup.characterId, `${uid} signup character`),
      status: value.signup.status as typeof signupStatuses[number],
      ...(value.signup.benchKind === 'self' ? { benchKind: 'self' as const } : {}),
    }
    if (value.signup.benchKind !== undefined && value.signup.benchKind !== 'self') {
      throw new SnapshotDataError(`Snapshot signup for ${uid} has an invalid bench type.`)
    }
  }
  if (value.invited && (invitationMainId === null || typeof invitationOrder !== 'number')) {
    throw new SnapshotDataError(`Snapshot invitation for ${uid} is incomplete.`)
  }
  return {
    uid,
    displayName: nullableString(value.displayName, `${uid} display name`),
    invited: value.invited,
    invitationOrder,
    invitationMainId,
    signup,
  }
}

/** In a started or failed snapshot (`partial`), a character not written yet is left null; the table says so rather than showing a dash. */
export function buildSnapshotInvitationRows(accounts: SnapshotAccount[], characters: Map<string, SnapshotCharacter>, partial = false) {
  const rows = accounts.map((account): SnapshotInvitationRow => {
    const invitationCharacter = account.invitationMainId ? characters.get(account.invitationMainId) : null
    const signupCharacter = account.signup ? characters.get(account.signup.characterId) : null
    if (account.invitationMainId && !invitationCharacter && !partial) {
      throw new SnapshotDataError(`Invited character ${account.invitationMainId} is missing from the published snapshot.`)
    }
    if (account.signup && !signupCharacter && !partial) {
      throw new SnapshotDataError(`Signup character ${account.signup.characterId} is missing from the published snapshot.`)
    }
    return { account, invitationCharacter: invitationCharacter ?? null, signupCharacter: signupCharacter ?? null }
  })
  return rows.sort((left, right) =>
    Number(right.account.invited) - Number(left.account.invited)
    || (left.account.invitationOrder ?? Number.MAX_SAFE_INTEGER) - (right.account.invitationOrder ?? Number.MAX_SAFE_INTEGER)
    || (left.account.displayName ?? left.account.uid).localeCompare(right.account.displayName ?? right.account.uid))
}

// ---- What Raid History says about a started or failed snapshot (RAID-015). The component shows these strings as they are, so the tests check the words.

export const snapshotStatusLabels: Record<SnapshotStatus, string> = { capturing: 'In progress', complete: 'Complete', failed: 'Failed' }

/**
 * Plain words for every failure code functions/raidStartSnapshot.js can write (a unit test checks the list against that file). The server's own message is never
 * shown: it can contain ids. Nothing here says leaders were told, because no alert exists yet (OPS-001).
 */
export const snapshotFailureMessages: Record<string, string> = {
  'missing-working-roster': 'This raid had no scheduled roster when it started, so there was nothing to record.',
  'invalid-working-roster': "The raid's scheduled roster was damaged or incomplete, so it could not be recorded.",
  'working-roster-changed-after-start': 'The scheduled roster was changed after the raid started, so the roster as it stood at the start could not be recorded.',
  'signup-changed-after-start': 'A sign-up was changed after the raid started, so the sign-ups as they stood at the start could not be recorded.',
  'invalid-signup-data': 'A sign-up for this raid was damaged, so the sign-ups could not be recorded.',
  'invalid-raid-details': "The raid's details, such as its name, date or time, were not valid, so it could not be recorded.",
  'invalid-raid-sizes': "The raid's team sizes were not valid, so it could not be recorded.",
  'invalid-raid-audit-history': "The raid's change history is incomplete, so its details at the start could not be worked out.",
  'missing-character': 'A character on the roster or a sign-up no longer existed, so the roster could not be recorded.',
  'invalid-character-id': 'A character on the roster had a damaged record, so the roster could not be recorded.',
  'snapshot-record-too-large': 'Part of the snapshot was too large to store, so it could not be finished.',
  'snapshot-record-conflict': 'Records from an earlier attempt did not match this one, so the capture stopped rather than mix them.',
  'snapshot-source-changed': 'The roster or sign-ups changed while the snapshot was being taken, so the capture stopped rather than mix them.',
  'snapshot-manifest-conflict': 'The snapshot record changed while it was being finished, so the capture stopped.',
  'snapshot-capture-failed': 'The starting snapshot could not be taken.',
}

/** The failure code to show in small text, or null when the record holds something that is not a code. */
export function snapshotFailureCode(code: string | null) {
  return code && /^[a-z0-9-]{1,64}$/.test(code) ? code : null
}

export function snapshotFailureMessage(code: string | null) {
  return (code && Object.hasOwn(snapshotFailureMessages, code) ? snapshotFailureMessages[code] : undefined)
    ?? snapshotFailureMessages['snapshot-capture-failed']
}

export type SnapshotBanner = { tone: 'capturing' | 'failed'; title: string; detail: string | null }

/** The banner over a started or failed snapshot; none for a complete one. */
export function snapshotBanner(progress: SnapshotProgress): SnapshotBanner | null {
  if (progress.status === 'complete') return null
  const records = progress.expected === null || progress.written === null
    ? null
    : `${progress.written} of ${progress.expected} ${progress.expected === 1 ? 'record' : 'records'} written.`
  if (progress.status === 'capturing') {
    return {
      tone: 'capturing',
      title: 'Starting snapshot in progress: this list may be incomplete',
      detail: [records, 'Refresh snapshots to check again.'].filter(Boolean).join(' '),
    }
  }
  if (progress.expected === null) return { tone: 'failed', title: 'Starting snapshot failed: nothing was recorded', detail: null }
  return { tone: 'failed', title: 'Starting snapshot failed: this list may be incomplete', detail: records }
}

/** The second line of an entry in the list. */
export function snapshotEntrySummary(entry: SnapshotEntry) {
  if (entry.kind === 'team') return `${entry.raidName} · ${entry.characterIds.length} scheduled · ${entry.benchIds.length} benched`
  if (entry.kind === 'missing-lineup') return `${entry.raidName} · ${entry.progress.status === 'capturing' ? 'lineup not written yet' : 'lineup not written'}`
  return `${entry.raidName} · nothing was recorded`
}

/** What the detail of an entry with no team says instead of a roster. */
export function snapshotEntryNote(entry: SnapshotMissingLineup | SnapshotFailureNotice) {
  if (entry.kind === 'failure-notice') return 'No lineup, roster or sign-up was recorded for this raid.'
  return entry.progress.status === 'capturing'
    ? `The ${entry.size}M lineup has not been written yet, so its teams are not shown.`
    : `The ${entry.size}M lineup was not written before the capture failed, so its teams are not shown.`
}

const countCharacters = (count: number, where: string) => `${count} ${where} ${count === 1 ? 'character' : 'characters'}`

/** The row under a started or failed report's roster for the characters not written, or null when there are none. */
export function snapshotNotWrittenText(notWritten: SnapshotReportRoster['notWritten'], status: SnapshotStatus) {
  const parts = [notWritten.team ? countCharacters(notWritten.team, 'team') : '', notWritten.bench ? countCharacters(notWritten.bench, 'bench') : ''].filter(Boolean)
  if (!parts.length) return null
  const verb = notWritten.team + notWritten.bench === 1 ? 'is' : 'are'
  return `${parts.join(' and ')} ${verb} ${status === 'capturing' ? 'not written yet' : 'missing: the capture failed before writing them'}.`
}

/** The row under a started or failed report's responses for the accounts not written, or null when there are none. */
export function snapshotAccountsNotWrittenText(missing: number, status: SnapshotStatus) {
  if (missing <= 0) return null
  const records = `${missing} invitation and sign-up ${missing === 1 ? 'record' : 'records'}`
  return `${records} ${status === 'capturing' ? `${missing === 1 ? 'is' : 'are'} not written yet` : `${missing === 1 ? 'is' : 'are'} missing: the capture failed before writing them`}.`
}
