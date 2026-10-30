import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { describe, it } from 'node:test'
import { Timestamp } from 'firebase/firestore'
import {
  buildSnapshotEntries,
  buildSnapshotInvitationRows,
  buildSnapshotReportRoster,
  readSnapshotAccount,
  readSnapshotCharacter,
  readSnapshotLineup,
  readSnapshotManifest,
  snapshotAccountsNotWrittenText,
  snapshotBanner,
  SnapshotDataError,
  snapshotEntryNote,
  snapshotEntrySummary,
  snapshotFailureCode,
  snapshotFailureMessage,
  snapshotFailureMessages,
  snapshotNotWrittenText,
  snapshotStatusLabels,
  sortSnapshotEntries,
  type SnapshotEntry,
  type SnapshotReport,
} from '../../src/features/raid-history/history.ts'

const scheduledStartAt = Timestamp.fromDate(new Date('2026-10-20T01:00:00.000Z'))
const capturedAt = Timestamp.fromDate(new Date('2026-10-20T01:01:00.000Z'))
const failedAt = Timestamp.fromDate(new Date('2026-10-20T01:02:00.000Z'))
const groupKeys = {
  10: ['blue', 'yellow', 'red', 'white'],
  20: ['green', 'pink'],
  40: ['brown'],
} as const

function manifest(raidId = 'raid-a', lineupSizes: (10 | 20 | 40)[] = [10, 20, 40], extra: Record<string, unknown> = {}) {
  return readSnapshotManifest(raidId, {
    schemaVersion: 1,
    status: 'complete',
    raidId,
    raid: { name: 'Test raid night', date: '2026-10-19' },
    scheduledStartAt,
    capturedAt,
    lineupSizes,
    counts: { lineups: lineupSizes.length, characters: 2, accounts: 1 },
    ...extra,
  })
}

/** A manifest as the capture leaves it while it is still writing records: no capturedAt yet. */
function capturingManifest(lineupSizes: (10 | 20 | 40)[] = [10, 20, 40]) {
  return manifest('raid-a', lineupSizes, { status: 'capturing', capturedAt: undefined })
}

/** A manifest the capture marked failed after it had started writing. */
function failedManifest(lineupSizes: (10 | 20 | 40)[] = [10, 20, 40]) {
  return manifest('raid-a', lineupSizes, { status: 'failed', capturedAt: undefined, failureCode: 'snapshot-record-conflict', failedAt })
}

/** The small failed record the capture writes when it fails before writing anything (functions/raidStartSnapshot.js, failureNotice). */
function noticeRaw(raid: Record<string, unknown> = { id: 'raid-a', name: 'Test raid night', date: '2026-10-19' }) {
  return {
    schemaVersion: 1, status: 'failed', failureNotice: true, raidId: 'raid-a',
    raid, scheduledStartAt, failureCode: 'missing-working-roster', failedAt,
  }
}

function lineup(size: 10 | 20 | 40, teamCharacters: Record<string, string[]> = {}, bench: string[] = []) {
  return readSnapshotLineup(size, {
    size,
    teams: groupKeys[size].map((key) => ({ key, name: key[0].toUpperCase() + key.slice(1), characterIds: teamCharacters[key] ?? [] })),
    bench,
  })
}

const teams = (entries: SnapshotEntry[]) => entries.filter((entry): entry is SnapshotReport => entry.kind === 'team')

describe('published raid history helpers', () => {
  it('expands a single snapshot into separate reports for every captured team and size', () => {
    const sizes = [10, 20, 40] as const
    const reports = buildSnapshotEntries(
      'guilds/guild-a/raids/raid-a/snapshots/start',
      manifest('raid-a', [...sizes]),
      sizes.map((size) => lineup(size)),
    )
    assert.equal(reports.length, 7)
    assert.ok(reports.every((report) => report.kind === 'team' && report.progress.status === 'complete'))
    assert.deepEqual(reports.map((report) => report.label), [
      '10-19-26 Blue 10M',
      '10-19-26 Yellow 10M',
      '10-19-26 Red 10M',
      '10-19-26 White 10M',
      '10-19-26 Green 20M',
      '10-19-26 Pink 20M',
      '10-19-26 Brown 40M',
    ])
    assert.equal(new Set(reports.map((report) => report.snapshotPath)).size, 1)
    assert.equal(reports[0].scheduledStartAt.toMillis(), scheduledStartAt.toMillis())
    assert.equal(teams(reports)[0].capturedAt?.toMillis(), capturedAt.toMillis())
  })

  it('sorts reports newest first and deterministically orders sizes and teams within a raid', () => {
    const earlier = buildSnapshotEntries('snapshot-a', manifest('raid-a', [10]), [lineup(10)])
    const laterManifest = manifest('raid-b', [10])
    laterManifest.scheduledStartAt = Timestamp.fromMillis(scheduledStartAt.toMillis() + 60_000)
    const later = buildSnapshotEntries('snapshot-b', laterManifest, [lineup(10)])
    assert.deepEqual(sortSnapshotEntries([...earlier, ...later]).map((report) => report.raidId), [
      'raid-b', 'raid-b', 'raid-b', 'raid-b', 'raid-a', 'raid-a', 'raid-a', 'raid-a',
    ])
    assert.deepEqual(teams(earlier).map((report) => report.teamKey), ['blue', 'yellow', 'red', 'white'])
  })

  it('maps only captured team and bench character records into a read-only report roster', () => {
    const [report] = teams(buildSnapshotEntries('snapshot-a', manifest('raid-a', [10]), [
      lineup(10, { blue: ['char-blue'] }, ['char-bench']),
    ]))
    const team = readSnapshotCharacter('char-blue', {
      id: 'char-blue', name: 'Briar', surname: 'Thorn', className: 'Druid', specialization: 'Balance', role: 'Ranged',
      accountUid: 'account-a', placements: [{ size: 10, teamKey: 'blue', teamName: 'Blue', bench: false }],
    })
    const bench = readSnapshotCharacter('char-bench', {
      id: 'char-bench', name: 'Elara', surname: null, className: 'Priest', specialization: 'Holy', role: 'Healer',
      accountUid: null, placements: [{ size: 10, teamKey: null, teamName: null, bench: true }],
    })
    assert.deepEqual(buildSnapshotReportRoster(report, new Map([[team.id, team], [bench.id, bench]])), {
      team: [team],
      bench: [bench],
      notWritten: { team: 0, bench: 0 },
    })
    assert.throws(() => buildSnapshotReportRoster(report, new Map([[team.id, team]])), SnapshotDataError)
  })

  it('preserves invitation identity and signup response independently', () => {
    const account = readSnapshotAccount('account-a', {
      uid: 'account-a', displayName: 'Aster Vale', invited: true, invitationOrder: 0,
      invitationMainId: 'char-main', signup: { characterId: 'char-alt', status: 'bench', benchKind: 'self' },
    })
    const main = readSnapshotCharacter('char-main', {
      id: 'char-main', name: 'Aster', surname: 'Vale', className: 'Warrior', specialization: 'Arms', role: 'Melee',
      accountUid: 'account-a', placements: [],
    })
    const alt = readSnapshotCharacter('char-alt', {
      id: 'char-alt', name: 'Lark', surname: null, className: 'Druid', specialization: 'Restoration', role: 'Healer',
      accountUid: 'account-a', placements: [],
    })
    const [row] = buildSnapshotInvitationRows([account], new Map([[main.id, main], [alt.id, alt]]))
    assert.equal(row.account.displayName, 'Aster Vale')
    assert.equal(row.invitationCharacter?.id, 'char-main')
    assert.equal(row.signupCharacter?.id, 'char-alt')
    assert.equal(row.account.signup?.status, 'bench')
    assert.equal(row.account.signup?.benchKind, 'self')
  })

  it('rejects incomplete manifests, lineups, characters, and account records', () => {
    assert.throws(() => readSnapshotManifest('raid-a', { ...manifestRaw(), capturedAt: undefined }), SnapshotDataError)
    assert.throws(() => readSnapshotLineup(10, { ...lineupRaw(10), teams: [] }), SnapshotDataError)
    assert.throws(() => readSnapshotCharacter('char-a', { id: 'char-a', placements: [] }), SnapshotDataError)
    assert.throws(() => readSnapshotAccount('account-a', { uid: 'account-a', invited: true }), SnapshotDataError)
  })
})

describe('started and failed starting snapshots (RAID-015)', () => {
  it('reads a capturing manifest, which has no capture time yet, and a failed one with its code', () => {
    const capturing = capturingManifest()
    assert.equal(capturing.status, 'capturing')
    assert.equal(capturing.capturedAt, null)
    assert.equal(capturing.failureCode, null)
    const failed = failedManifest()
    assert.equal(failed.status, 'failed')
    assert.equal(failed.notice, false)
    assert.equal(failed.failureCode, 'snapshot-record-conflict')
    assert.equal(failed.failedAt?.toMillis(), failedAt.toMillis())
    assert.equal(manifest().failureCode, null)
  })

  it('rejects an unknown status, a failed record with no code, and a capturing manifest with no counts', () => {
    assert.throws(() => readSnapshotManifest('raid-a', { ...manifestRaw(), status: 'draft' }), SnapshotDataError)
    assert.throws(() => readSnapshotManifest('raid-a', { ...manifestRaw(), status: 'failed' }), SnapshotDataError)
    assert.throws(() => readSnapshotManifest('raid-a', { ...noticeRaw(), failureCode: '' }), SnapshotDataError)
    assert.throws(() => readSnapshotManifest('raid-a', { ...manifestRaw(), status: 'capturing', counts: undefined }), SnapshotDataError)
    assert.throws(() => readSnapshotManifest('raid-b', noticeRaw()), SnapshotDataError)
  })

  it('never presents a lineup a started capture has not written as an empty team', () => {
    const entries = buildSnapshotEntries('snapshot-a', capturingManifest(), [lineup(10, { blue: ['char-blue'] })], 1)
    assert.deepEqual(entries.map((entry) => [entry.kind, entry.label]), [
      ['team', '10-19-26 Blue 10M'],
      ['team', '10-19-26 Yellow 10M'],
      ['team', '10-19-26 Red 10M'],
      ['team', '10-19-26 White 10M'],
      ['missing-lineup', '10-19-26 20M'],
      ['missing-lineup', '10-19-26 40M'],
    ])
    assert.ok(!teams(entries).some((entry) => entry.size !== 10), 'no team report for a lineup that is not written')
    const [missing] = entries.filter((entry) => entry.kind === 'missing-lineup')
    assert.equal(snapshotEntrySummary(missing), 'Test raid night · lineup not written yet')
    assert.equal(missing.kind === 'missing-lineup' && snapshotEntryNote(missing), 'The 20M lineup has not been written yet, so its teams are not shown.')

    const none = buildSnapshotEntries('snapshot-a', capturingManifest(), [], 0)
    assert.deepEqual(none.map((entry) => entry.kind), ['missing-lineup', 'missing-lineup', 'missing-lineup'])
  })

  it('still refuses a complete snapshot with a missing lineup, and a lineup the manifest does not list', () => {
    assert.throws(() => buildSnapshotEntries('snapshot-a', manifest(), [lineup(10)]), SnapshotDataError)
    assert.throws(() => buildSnapshotEntries('snapshot-a', capturingManifest([10]), [lineup(10), lineup(20)], 2), SnapshotDataError)
  })

  it('a failed capture that wrote some lineups lists them and says the others were not written', () => {
    const entries = buildSnapshotEntries('snapshot-a', failedManifest([10, 20]), [lineup(20)], 1)
    assert.deepEqual(entries.map((entry) => entry.kind), ['missing-lineup', 'team', 'team'])
    const [missing] = entries
    assert.equal(snapshotEntrySummary(missing), 'Test raid night · lineup not written')
    assert.equal(missing.kind === 'missing-lineup' && snapshotEntryNote(missing), 'The 10M lineup was not written before the capture failed, so its teams are not shown.')
    assert.ok(entries.every((entry) => entry.progress.status === 'failed' && entry.progress.failureCode === 'snapshot-record-conflict'))
  })

  it('shows a capture that failed before writing anything as one entry with its date', () => {
    const notice = readSnapshotManifest('raid-a', noticeRaw())
    assert.equal(notice.notice, true)
    assert.deepEqual(notice.lineupSizes, [])
    assert.equal(notice.counts, null)
    const entries = buildSnapshotEntries('snapshot-a', notice, [])
    assert.equal(entries.length, 1)
    const [entry] = entries
    assert.equal(entry.kind, 'failure-notice')
    assert.equal(entry.label, '10-19-26 Starting snapshot')
    assert.equal(snapshotEntrySummary(entry), 'Test raid night · nothing was recorded')
    assert.equal(entry.kind === 'failure-notice' && snapshotEntryNote(entry), 'No lineup, roster or sign-up was recorded for this raid.')
    assert.throws(() => buildSnapshotEntries('snapshot-a', notice, [lineup(10)]), SnapshotDataError)
  })

  it('a failed record with an invalid name or date still shows, by the Eastern date of its start', () => {
    const notice = readSnapshotManifest('raid-a', noticeRaw({ id: 'raid-a', name: null, date: 'soon' }))
    assert.equal(notice.raid.name, 'Unnamed raid')
    assert.equal(notice.raid.date, '2026-10-19') // 01:00 UTC on Oct 20 is 9:00 PM Eastern on Oct 19
    assert.equal(buildSnapshotEntries('snapshot-a', notice, [])[0].label, '10-19-26 Starting snapshot')
  })

  it('shows the banner while capturing and when failed, with how many records are written, and never when complete', () => {
    const [complete] = buildSnapshotEntries('snapshot-a', manifest('raid-a', [10]), [lineup(10)])
    assert.equal(snapshotBanner(complete.progress), null)
    assert.equal(complete.progress.written, null)

    const [capturing] = buildSnapshotEntries('snapshot-a', capturingManifest(), [], 0)
    assert.deepEqual(snapshotBanner(capturing.progress), {
      tone: 'capturing',
      title: 'Starting snapshot in progress: this list may be incomplete',
      detail: '0 of 6 records written. Refresh snapshots to check again.',
    })
    const [partlyWritten] = buildSnapshotEntries('snapshot-a', capturingManifest(), [lineup(10)], 3)
    assert.equal(snapshotBanner(partlyWritten.progress)?.detail, '3 of 6 records written. Refresh snapshots to check again.')

    const [failed] = buildSnapshotEntries('snapshot-a', failedManifest(), [], 2)
    assert.deepEqual(snapshotBanner(failed.progress), {
      tone: 'failed', title: 'Starting snapshot failed: this list may be incomplete', detail: '2 of 6 records written.',
    })
    const [notice] = buildSnapshotEntries('snapshot-a', readSnapshotManifest('raid-a', noticeRaw()), [])
    assert.deepEqual(snapshotBanner(notice.progress), { tone: 'failed', title: 'Starting snapshot failed: nothing was recorded', detail: null })

    assert.deepEqual(snapshotStatusLabels, { capturing: 'In progress', complete: 'Complete', failed: 'Failed' })
  })

  it('has plain words for every failure code the capture can write, and never shows the server message', () => {
    const source = readFileSync(new URL('../../functions/raidStartSnapshot.js', import.meta.url), 'utf8')
    const written = new Set([
      ...[...source.matchAll(/PermanentCaptureError\('([a-z-]+)'/g)].map((match) => match[1]),
      ...[...source.matchAll(/this\.code = '([a-z-]+)'/g)].map((match) => match[1]),
      ...[...source.matchAll(/error\.code \?\? '([a-z-]+)'/g)].map((match) => match[1]),
    ])
    assert.ok(written.has('invalid-raid-audit-history') && written.has('snapshot-capture-failed') && written.size >= 15, [...written].join(', '))
    assert.deepEqual([...written].filter((code) => !Object.hasOwn(snapshotFailureMessages, code)), [])
    assert.deepEqual(Object.keys(snapshotFailureMessages).filter((code) => !written.has(code)), [])
    for (const [code, message] of Object.entries(snapshotFailureMessages)) {
      assert.equal(snapshotFailureMessage(code), message)
      assert.doesNotMatch(message, /[a-z]+-[a-z]+-/, `${code} reads as words, not a code`)
      assert.doesNotMatch(message, /leader|told|notified|RAID-/i, `${code} promises nothing that does not exist`)
    }
    assert.equal(snapshotFailureMessage('some-new-code'), 'The starting snapshot could not be taken.')
    assert.equal(snapshotFailureMessage(null), 'The starting snapshot could not be taken.')
    assert.equal(snapshotFailureMessage('constructor'), 'The starting snapshot could not be taken.')
    assert.equal(snapshotFailureCode('missing-working-roster'), 'missing-working-roster')
    assert.equal(snapshotFailureCode('Character abc/def is missing'), null)
    assert.equal(snapshotFailureCode(null), null)
  })

  it('counts the characters a started capture has not written instead of failing or hiding them', () => {
    const [report] = teams(buildSnapshotEntries('snapshot-a', capturingManifest([10]), [lineup(10, { blue: ['char-blue', 'char-late'] }, ['char-bench'])], 2))
    const team = readSnapshotCharacter('char-blue', {
      id: 'char-blue', name: 'Briar', surname: null, className: 'Druid', specialization: 'Balance', role: 'Ranged',
      accountUid: null, placements: [{ size: 10, teamKey: 'blue', teamName: 'Blue', bench: false }],
    })
    const roster = buildSnapshotReportRoster(report, new Map([[team.id, team]]))
    assert.deepEqual(roster, { team: [team], bench: [], notWritten: { team: 1, bench: 1 } })
    assert.equal(snapshotNotWrittenText(roster.notWritten, 'capturing'), '1 team character and 1 bench character are not written yet.')
    assert.equal(snapshotNotWrittenText({ team: 2, bench: 0 }, 'failed'), '2 team characters are missing: the capture failed before writing them.')
    assert.equal(snapshotNotWrittenText({ team: 0, bench: 0 }, 'capturing'), null)
    // A character that is written must still match its lineup.
    const wrong = readSnapshotCharacter('char-blue', { ...team, placements: [{ size: 10, teamKey: 'red', teamName: 'Red', bench: false }] })
    assert.throws(() => buildSnapshotReportRoster(report, new Map([[wrong.id, wrong]])), SnapshotDataError)
  })

  it('lists the responses a started capture has written, with characters not written yet left empty', () => {
    const account = readSnapshotAccount('account-a', {
      uid: 'account-a', displayName: 'Aster Vale', invited: true, invitationOrder: 0, invitationMainId: 'char-main', signup: null,
    })
    assert.throws(() => buildSnapshotInvitationRows([account], new Map()), SnapshotDataError)
    const [row] = buildSnapshotInvitationRows([account], new Map(), true)
    assert.equal(row.invitationCharacter, null)
    assert.equal(snapshotAccountsNotWrittenText(2, 'capturing'), '2 invitation and sign-up records are not written yet.')
    assert.equal(snapshotAccountsNotWrittenText(1, 'failed'), '1 invitation and sign-up record is missing: the capture failed before writing them.')
    assert.equal(snapshotAccountsNotWrittenText(0, 'capturing'), null)
  })

  it('puts a failure notice before the lineups of the same start, newest raid first', () => {
    const notice = buildSnapshotEntries('snapshot-b', readSnapshotManifest('raid-b', { ...noticeRaw(), raidId: 'raid-b' }), [])
    const complete = buildSnapshotEntries('snapshot-a', manifest('raid-a', [10]), [lineup(10)])
    const older = manifest('raid-c', [10])
    older.scheduledStartAt = Timestamp.fromMillis(scheduledStartAt.toMillis() - 60_000)
    const sorted = sortSnapshotEntries([...buildSnapshotEntries('snapshot-c', older, [lineup(10)]), ...complete, ...notice])
    assert.deepEqual(sorted.map((entry) => `${entry.raidId}:${entry.kind}`).slice(0, 2), ['raid-b:failure-notice', 'raid-a:team'])
    assert.equal(sorted.at(-1)?.raidId, 'raid-c')
  })
})

function manifestRaw() {
  return {
    schemaVersion: 1,
    status: 'complete',
    raidId: 'raid-a',
    raid: { name: 'Test raid night', date: '2026-10-19' },
    scheduledStartAt,
    capturedAt,
    lineupSizes: [10],
    counts: { lineups: 1, characters: 0, accounts: 0 },
  }
}

function lineupRaw(size: 10 | 20 | 40) {
  return {
    size,
    teams: groupKeys[size].map((key) => ({ key, name: key, characterIds: [] })),
    bench: [],
  }
}
