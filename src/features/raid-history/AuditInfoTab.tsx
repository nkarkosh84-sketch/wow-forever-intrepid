import { useEffect, useState } from 'react'
import { classColorKey } from '../../shared/game/classes'
import { EmptyRow } from '../../shared/ui/EmptyRow'
import type { TabContext } from '../../shared/tabs/types'
import {
  snapshotAccountsNotWrittenText,
  snapshotBanner,
  snapshotEntryNote,
  snapshotEntrySummary,
  snapshotFailureCode,
  snapshotFailureMessage,
  snapshotNotWrittenText,
  snapshotStatusLabels,
  type SnapshotEntry,
  type SnapshotInvitationRow,
  type SnapshotProgress,
  type SnapshotReport,
  type SnapshotReportRoster,
} from './history'
import { useRaidHistory } from './useRaidHistory'

// The responses shown belong to one read of one snapshot: a started capture read again after Refresh may have written more, so it gets a new key (RAID-015).
const responsesKey = (report: SnapshotReport) => `${report.snapshotPath}|${report.progress.status}|${report.progress.written ?? ''}`

export function AuditInfoTab({ ctx }: { ctx: TabContext }) {
  const { entries, errors, loading, refresh, loadReport, loadInvitations } = useRaidHistory(ctx.data.raids, ctx.data.raidPlanningLoaded)
  const [selectedId, setSelectedId] = useState('')
  const selectedEntry = entries.find((entry) => entry.id === selectedId) ?? entries[0] ?? null
  const selectedReport = selectedEntry?.kind === 'team' ? selectedEntry : null
  const [rosterState, setRosterState] = useState<{ reportId: string; roster?: SnapshotReportRoster; error?: string }>({ reportId: '' })
  const [invitationState, setInvitationState] = useState<{
    key: string
    rows: SnapshotInvitationRow[] | null
    error: string
    loading: boolean
  }>({ key: '', rows: null, error: '', loading: false })
  const [expandedKey, setExpandedKey] = useState<string | null>(null)

  useEffect(() => {
    if (!selectedReport) return
    let cancelled = false
    void loadReport(selectedReport).then((result) => {
      if (!cancelled) setRosterState({ reportId: selectedReport.id, roster: result })
    }).catch((error: unknown) => {
      if (!cancelled) setRosterState({ reportId: selectedReport.id, error: errorMessage(error, 'Could not load the published roster details.') })
    })
    return () => { cancelled = true }
  }, [loadReport, selectedReport])

  const roster = selectedReport && rosterState.reportId === selectedReport.id ? rosterState.roster ?? null : null
  const rosterError = selectedReport && rosterState.reportId === selectedReport.id ? rosterState.error ?? '' : ''
  const rosterLoading = Boolean(selectedReport && rosterState.reportId !== selectedReport.id)
  const selectedKey = selectedReport ? responsesKey(selectedReport) : ''
  const showInvitations = Boolean(selectedReport && expandedKey === selectedKey)
  const currentInvitationState = selectedReport && invitationState.key === selectedKey
    ? invitationState
    : { key: selectedKey, rows: null, error: '', loading: false }

  const fetchInvitations = (report: SnapshotReport) => {
    const key = responsesKey(report)
    setExpandedKey(key)
    if (invitationState.key === key && (invitationState.loading || invitationState.rows)) return
    setInvitationState({ key, rows: null, error: '', loading: true })
    void loadInvitations(report).then((rows) => {
      setInvitationState((current) => current.key === key
        ? { key, rows, error: '', loading: false }
        : current)
    }).catch((error: unknown) => {
      setInvitationState((current) => current.key === key
        ? {
          key,
          rows: null,
          error: errorMessage(error, 'Could not load the published invitation and sign-up details.'),
          loading: false,
        }
        : current)
    })
  }

  const toggleInvitations = () => {
    if (!selectedReport) return
    if (showInvitations) {
      setExpandedKey(null)
      return
    }
    fetchInvitations(selectedReport)
  }

  if (ctx.data.dataError) return <p role="alert">Raid history could not be loaded: {ctx.data.dataError}. Reload to retry.</p>
  if (!ctx.data.raidPlanningLoaded) return <p role="status">Loading raid history...</p>
  if (loading && !entries.length && !errors.length) return <p role="status">Loading published raid snapshots...</p>

  return <div className="raid-history-audit">
    <div className="raid-history-actions"><button className="button button-secondary" type="button" onClick={refresh}>Refresh snapshots</button></div>
    {errors.length > 0 && <div className="raid-history-errors" role="alert">
      <strong>Some published raid history could not be loaded.</strong>
      <ul>{errors.map((error, index) => <li key={`${index}:${error}`}>{error}</li>)}</ul>
      <button className="button button-secondary" type="button" onClick={refresh}>Retry snapshot reads</button>
    </div>}
    {entries.length === 0 ? <div className="empty-state raid-history-empty">
      <strong>No published raid snapshots</strong>
      <p>{errors.length ? 'Resolve the read errors above and retry.' : 'Starting snapshots will appear here once their capture begins.'}</p>
    </div> : <div className="raid-history-browser">
      <section className="raid-history-reports" aria-label="Published raid reports">
        <h2>Raid groups</h2>
        <div className="raid-history-report-list">
          {entries.map((entry) => <button
            className={entry.id === selectedEntry?.id ? 'raid-history-report selected' : 'raid-history-report'}
            key={entry.id}
            type="button"
            aria-pressed={entry.id === selectedEntry?.id}
            onClick={() => setSelectedId(entry.id)}
          >
            <strong>{entry.label}</strong>
            <small>{snapshotEntrySummary(entry)}</small>
            <span className={`raid-history-status raid-history-status-${entry.progress.status}`}>{snapshotStatusLabels[entry.progress.status]}</span>
          </button>)}
        </div>
      </section>
      {selectedEntry && <section className="raid-history-report-detail" aria-label={`${selectedEntry.label} snapshot`}>
        <div className="raid-history-detail-heading">
          <div>
            <h2>{selectedEntry.label}</h2>
            <p>{selectedEntry.raidName} · Scheduled {selectedEntry.scheduledStartAt.toDate().toLocaleString()} · {timing(selectedEntry)}</p>
          </div>
          <span className="raid-history-read-only">Read only snapshot</span>
        </div>
        <StatusBanner progress={selectedEntry.progress} />
        {selectedEntry.kind !== 'team' && <p className="raid-history-gap">{snapshotEntryNote(selectedEntry)}</p>}
        {rosterLoading && <p role="status">Loading captured roster...</p>}
        {rosterError && <p role="alert" className="raid-history-inline-error">{rosterError}</p>}
        {selectedReport && roster && <>
          <RosterTable report={selectedReport} roster={roster} />
          <button className="button button-secondary raid-history-responses-button" type="button" aria-expanded={showInvitations} onClick={toggleInvitations}>
            {showInvitations ? 'Invitation & sign-up responses' : 'Show invitation & sign-up responses'}
          </button>
          {showInvitations && <InvitationTable report={selectedReport} rows={currentInvitationState.rows} loading={currentInvitationState.loading} error={currentInvitationState.error} retry={() => fetchInvitations(selectedReport)} />}
        </>}
      </section>}
    </div>}
  </div>
}

/** When the capture finished, or that it has not. */
function timing(entry: SnapshotEntry) {
  if (entry.progress.status === 'capturing') return 'Capture not finished'
  if (entry.progress.status === 'failed') return entry.progress.failedAt ? `Failed ${entry.progress.failedAt.toDate().toLocaleString()}` : 'Failed'
  return entry.kind === 'team' && entry.capturedAt ? `Captured ${entry.capturedAt.toDate().toLocaleString()}` : 'Captured'
}

/** The banner over a started or failed starting snapshot (RAID-015): its words come from `snapshotBanner` and `snapshotFailureMessage`, which the unit tests check. */
function StatusBanner({ progress }: { progress: SnapshotProgress }) {
  const banner = snapshotBanner(progress)
  if (!banner) return null
  const code = progress.status === 'failed' ? snapshotFailureCode(progress.failureCode) : null
  return <div className={`raid-history-banner raid-history-banner-${banner.tone}`} role="status">
    <strong>{banner.title}</strong>
    {banner.detail && <span>{banner.detail}</span>}
    {progress.status === 'failed' && <p>
      {snapshotFailureMessage(progress.failureCode)}
      {code && <small className="raid-history-failure-code">Code: {code}</small>}
    </p>}
  </div>
}

function RosterTable({ report, roster }: { report: SnapshotReport; roster: SnapshotReportRoster }) {
  const notWritten = snapshotNotWrittenText(roster.notWritten, report.progress.status)
  // The note sits under the table, not in it: the table scrolls sideways in a narrow panel, and a row would hide the end of the note.
  return <>
    <div className="table-scroll">
      <table className="data-table raid-history-table">
        <thead><tr><th>CHARACTER</th><th>CLASS</th><th>SPECIALIZATION</th><th>ROLE</th><th>PLACEMENT</th></tr></thead>
        <tbody>
          {roster.team.map((character) => <CharacterRow key={`${report.id}:${character.id}`} character={character} placement={report.teamName} />)}
          {roster.bench.map((character) => <CharacterRow key={`${report.id}:bench:${character.id}`} character={character} placement="Assigned bench" />)}
          {!roster.team.length && !roster.bench.length && !notWritten && <EmptyRow colSpan={5} title="No captured characters" detail="This published lineup contains no team or bench assignments." />}
        </tbody>
      </table>
    </div>
    {notWritten && <p className="raid-history-not-written">{notWritten}</p>}
  </>
}

function CharacterRow({ character, placement }: { character: SnapshotReportRoster['team'][number]; placement: string }) {
  const className = character.className
  const fullName = [character.name, character.surname].filter(Boolean).join(' ') || 'Unknown character'
  return <tr className={`raid-history-character class-accent-row${className ? ` class-color-${classColorKey(className)}` : ''}`}>
    <td><strong>{fullName}</strong></td>
    <td>{className ?? 'Not recorded'}</td>
    <td>{character.specialization ?? 'Not recorded'}</td>
    <td>{character.role ?? 'Not recorded'}</td>
    <td>{placement}</td>
  </tr>
}

function InvitationTable({ report, rows, loading, error, retry }: { report: SnapshotReport; rows: SnapshotInvitationRow[] | null; loading: boolean; error: string; retry: () => void }) {
  if (loading) return <p role="status">Loading captured invitations and responses...</p>
  if (error) return <p role="alert" className="raid-history-inline-error">{error} <button type="button" className="button button-secondary" onClick={retry}>Retry</button></p>
  if (!rows) return null
  const partial = report.progress.status !== 'complete'
  const notWritten = partial ? snapshotAccountsNotWrittenText(report.expectedAccountCount - rows.length, report.progress.status) : null
  // In a started or failed snapshot a character record may not be written yet; say so rather than show the dash that means "none".
  const characterName = (character: SnapshotInvitationRow['invitationCharacter'], expected: boolean) => character
    ? [character.name, character.surname].filter(Boolean).join(' ')
    : expected && partial ? 'Not written yet' : '—'
  return <>
    <div className="table-scroll">
      <table className="data-table raid-history-table raid-history-response-table">
        <thead><tr><th>ACCOUNT DISPLAY NAME</th><th>INVITED CHARACTER</th><th>INVITATION</th><th>SIGN-UP CHARACTER</th><th>RESPONSE</th></tr></thead>
        <tbody>
          {rows.map(({ account, invitationCharacter, signupCharacter }) => <tr key={account.uid}>
            <td>{account.displayName ?? 'Not recorded'}</td>
            <td>{characterName(invitationCharacter, Boolean(account.invitationMainId))}</td>
            <td>{account.invited ? `Invited${account.invitationOrder === null ? '' : ` · #${account.invitationOrder + 1}`}` : 'Not invited'}</td>
            <td>{characterName(signupCharacter, Boolean(account.signup))}</td>
            <td>{account.signup ? `${account.signup.status}${account.signup.benchKind === 'self' ? ' · voluntary bench' : ''}` : 'No response'}</td>
          </tr>)}
          {!rows.length && !notWritten && <EmptyRow colSpan={5} title="No captured invitations or sign-ups" detail="No account response records were present in this snapshot." />}
        </tbody>
      </table>
    </div>
    {notWritten && <p className="raid-history-not-written">{notWritten}</p>}
  </>
}

function errorMessage(error: unknown, fallback: string) {
  if (error && typeof error === 'object' && 'code' in error && error.code === 'permission-denied') {
    return 'You do not have permission to read this published raid history.'
  }
  return error instanceof Error ? error.message : fallback
}
