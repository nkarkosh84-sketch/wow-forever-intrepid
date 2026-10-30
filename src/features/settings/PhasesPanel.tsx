import { useState } from 'react'
import { changePhase } from '../../guildApi'
import {
  currentPhaseNo, easternDateOf, matchesPhrase, phaseDateLabel, phaseName, phaseNoOf, phaseOptions, phaseStartOf, phaseStartProblem, reopenPhase, reopenProblem, startNextPhase,
  startPhaseProblem, startPhrase, startTodayProblem, withPhaseStart,
} from '../../shared/game/phases'
import { describePreparedTables } from '../../shared/game/guildTables'
import type { TabContext } from '../../shared/tabs/types'
import { Modal } from '../../shared/ui/Modal'
import './Phases.css'

// Starting a loot phase, and taking it back. Guild Leaders only (this tab is, and the rules let nobody else write the settings). Starting
// closes the current phase: its loot priorities become a read-only record, and the lists already prepared for the next phase become the
// current ones, and the drop lists of Browse drops are the ones prepared for the next phase (they belong to a phase too: a phase starts with no zones
// unless it follows an earlier one, see shared/game/guildTables.ts). The names are the Current phase and Next phase above, as saved. Starting and reopening are each one save of the settings
// document with its entry in the Log; no priority or award is rewritten. Starting records today (Eastern Time) as the new phase's start date and
// reopening takes the date of the phase being left away (RAID-019); Start dates, at the end, sets or corrects any finished or current phase's date.
export function PhasesPanel({ ctx }: { ctx: TabContext }) {
  const { busy, setBusy, setMutationError, setNotice } = ctx.feedback
  const { settings, allPriorities, awards, lootTables } = ctx.data
  const [reopening, setReopening] = useState(false)
  // Today in Eastern Time as the panel opened (a phase started from it records the day of the click; see StartPhaseModal).
  const [today] = useState(() => easternDateOf(Date.now()))

  const finished = settings.phaseHistory ?? []
  const last = finished[finished.length - 1]
  const prepared = allPriorities.filter((priority) => phaseNoOf(priority) === currentPhaseNo(settings) + 1).length
  const preparedLists = describePreparedTables(lootTables, currentPhaseNo(settings) + 1, (no) => phaseName(settings, no))
  const problem = startPhaseProblem(settings, settings.nextPhase)
  const dateProblem = startTodayProblem(settings, today)
  const reopenBlocked = reopenProblem(settings, awards, allPriorities)

  async function reopen() {
    setBusy(true)
    try {
      await changePhase(reopenPhase(settings), 'reopen', { uid: ctx.identity.uid, displayName: ctx.identity.displayName })
      setMutationError('')
      setNotice(`${last} is the current phase again.`)
    } catch (error) {
      setMutationError(error instanceof Error ? error.message : 'Could not reopen the phase.')
    } finally {
      setBusy(false)
      setReopening(false)
    }
  }

  return <section className="settings-section phases-panel">
    <header>
      <h3>Loot phases</h3>
      <p>Starting a phase closes the current one: its loot priorities become a read-only record, and the lists already prepared for the next phase become the current ones. The drop lists of Browse drops become the ones prepared for the next phase: it starts with no zones unless a leader ticked some or made it follow an earlier phase (Edit the drop lists). The names are the Current phase and Next phase above (save them first). Every start is in the Log on Loot priorities.</p>
    </header>
    <dl className="phases-summary">
      <div><dt>Current phase</dt><dd>{settings.currentPhase}</dd></div>
      <div><dt>Next phase</dt><dd>{settings.nextPhase}{prepared > 0 ? ` (${prepared} ${prepared === 1 ? 'priority' : 'priorities'} prepared)` : ''}</dd></div>
      <div><dt>Drop lists</dt><dd>{preparedLists ? `Prepared for ${settings.nextPhase}: ${preparedLists}.` : `Nothing prepared for ${settings.nextPhase} yet. It starts with no zones until a leader chooses them.`}</dd></div>
      <div><dt>Finished</dt><dd>{finished.length ? [...finished].reverse().join(', ') : 'none yet'}</dd></div>
    </dl>
    {(problem || dateProblem) && <p className="phases-hint" role="note">{problem ? `${problem} Change the Next phase above and save it to start it.` : dateProblem}</p>}
    <div className="phases-actions">
      <button type="button" className="button button-primary" disabled={busy || !!problem || !!dateProblem} onClick={() => ctx.openModal(({ close, live }) => <StartPhaseModal close={close} live={live} />)}>{problem ? 'Start the next phase' : startPhrase(settings.nextPhase)}</button>
    </div>
    {finished.length > 0 && <div className="phases-undo">
      <h4>Started by mistake?</h4>
      <p>Reopening makes {last} the current phase again, and {settings.currentPhase} the next one with its lists kept. It is only possible while nothing has been awarded in {settings.currentPhase}. Drop list changes already written for {settings.currentPhase} stay stored and apply again when it starts.</p>
      {reopenBlocked && <p className="phases-hint" role="note">{reopenBlocked}</p>}
      {reopening
        ? <div className="phases-confirm" role="alert"><span>Reopen {last}?</span><button type="button" className="button button-secondary" onClick={() => setReopening(false)} disabled={busy}>Back</button><button type="button" className="button button-primary" onClick={() => void reopen()} disabled={busy}>Yes, reopen it</button></div>
        : <button type="button" className="button button-secondary" disabled={busy || !!reopenBlocked} onClick={() => setReopening(true)}>Reopen {last}</button>}
    </div>}
    <div className="phases-dates">
      <h4>Start dates</h4>
      <p>The first day of each phase, in Eastern Time. Raid History uses them to show the raids of a phase. Starting a phase records today; set or correct any date here. A date cannot be after today, and a phase cannot start before an earlier one. Every change is in the Log.</p>
      <ul className="phases-date-list" aria-label="Start date of each phase, newest first">
        {phaseOptions(settings, false).map((option) => {
          const date = phaseStartOf(settings, option.no)
          return <li key={option.no}>
            <span className="phases-date-name">{option.name}<small>{option.kind === 'current' ? 'Current' : 'Finished'}</small></span>
            <span className={date ? 'phases-date-value' : 'phases-date-value is-empty'}>{date ? phaseDateLabel(date) : 'No date'}</span>
            <button type="button" className="button button-secondary" disabled={busy} aria-label={`${date ? 'Change' : 'Set'} the start date of ${option.name}`}
              onClick={() => ctx.openModal(({ close, live }) => <PhaseStartModal close={close} live={live} no={option.no} />)}>{date ? 'Change' : 'Set date'}</button>
          </li>
        })}
      </ul>
    </div>
  </section>
}

// One more step before a phase starts: the Guild Leader types the words, so it cannot be done by a stray click.
function StartPhaseModal({ close, live }: { close: () => void; live: TabContext }) {
  const { busy, setBusy, setMutationError, setNotice } = live.feedback
  const { settings, allPriorities, lootTables } = live.data
  const [typed, setTyped] = useState('')
  const [today] = useState(() => easternDateOf(Date.now()))
  const name = settings.nextPhase
  const phrase = startPhrase(name)
  const prepared = allPriorities.filter((priority) => phaseNoOf(priority) === currentPhaseNo(settings) + 1).length
  const preparedLists = describePreparedTables(lootTables, currentPhaseNo(settings) + 1, (no) => phaseName(settings, no))
  const dateProblem = startTodayProblem(settings, today)
  const ready = matchesPhrase(typed, phrase) && !startPhaseProblem(settings, name) && !dateProblem

  async function start() {
    if (!ready) return
    setBusy(true)
    try {
      // Today as the click happens, in case the dialog was open across midnight.
      await changePhase(startNextPhase(settings, name, easternDateOf(Date.now())), 'start', { uid: live.identity.uid, displayName: live.identity.displayName })
      setMutationError('')
      setNotice(`${name} has started. ${settings.currentPhase} is now a read-only record.`)
      close()
    } catch (error) {
      setMutationError(error instanceof Error ? error.message : 'Could not start the phase.')
    } finally {
      setBusy(false)
    }
  }

  return <Modal title={`${phrase}?`} onClose={close}><form className="modal-form" onSubmit={(event) => { event.preventDefault(); void start() }}>
    <p className="phases-warning"><strong>{settings.currentPhase}</strong> closes now: its loot priorities become a read-only record. {prepared > 0 ? (prepared === 1 ? `The 1 priority prepared for ${name} becomes the current list.` : `The ${prepared} priorities prepared for ${name} become the current lists.`) : `${name} starts with no priorities.`} {preparedLists ? `The drop lists of ${name} are the ones prepared for it (it ${preparedLists}).` : `Nothing is prepared for the drop lists of ${name}: Browse drops will show no zones until a leader chooses them in Edit the drop lists.`} Starting is logged and can be undone only until something is awarded in {name}. {name} starts today, {phaseDateLabel(today)} (Eastern Time); the date can be corrected under Start dates.</p>
    <label>Type <strong>{phrase}</strong> to confirm<input value={typed} onChange={(event) => setTyped(event.target.value)} autoFocus autoComplete="off" spellCheck={false} aria-label={`Type ${phrase} to confirm`} /></label>
    {dateProblem && <p className="phases-date-problem" role="alert">{dateProblem}</p>}
    <div className="modal-actions"><button type="button" className="button button-secondary" onClick={close} disabled={busy}>Cancel</button><button className="button button-primary" disabled={busy || !ready}>{phrase}</button></div>
  </form></Modal>
}

// Setting, correcting or taking away the start date of one finished or current phase (RAID-019): one save of the settings with its entry in the
// Log, like a start (changePhase with 'edit'). The dates never go backwards and none is after today, so the dialog says in plain words why a date
// is refused before anything is written; the rules refuse the same. It reads the settings from `live`, so a change by another leader shows here.
function PhaseStartModal({ close, live, no }: { close: () => void; live: TabContext; no: number }) {
  const { busy, setBusy, setMutationError, setNotice } = live.feedback
  const { settings } = live.data
  const saved = phaseStartOf(settings, no) ?? ''
  const [date, setDate] = useState(saved)
  const [today] = useState(() => easternDateOf(Date.now()))
  const name = phaseName(settings, no)
  // The phase was reopened away while the dialog was open (the next phase has no date).
  const gone = no > currentPhaseNo(settings)
  const problem = gone ? `${name} is not a finished or current phase any more. Close this and look again.` : date ? phaseStartProblem(settings, no, date, today) : undefined
  const changed = date !== saved

  async function save(next: string | null) {
    setBusy(true)
    try {
      await changePhase(withPhaseStart(settings, no, next), 'edit', { uid: live.identity.uid, displayName: live.identity.displayName })
      setMutationError('')
      setNotice(next ? `${name} now starts on ${phaseDateLabel(next)}.` : `${name} has no start date now.`)
      close()
    } catch (error) {
      setMutationError(error instanceof Error ? error.message : 'Could not save the start date.')
    } finally {
      setBusy(false)
    }
  }

  return <Modal title={`Start date of ${name}`} onClose={close}><form className="modal-form" onSubmit={(event) => { event.preventDefault(); if (date && !problem && changed) void save(date) }}>
    <p className="phases-date-help">The first day of {name}, in Eastern Time. Raid History shows the raids from that day on under {name}, until the next phase with a date starts. The change is in the Log.</p>
    <label>First day of {name}<input type="date" value={date} max={today} onChange={(event) => setDate(event.target.value)} disabled={busy || gone} autoFocus /></label>
    {problem && <p className="phases-date-problem" role="alert">{problem}</p>}
    <div className="modal-actions phases-date-actions">
      {saved && <button type="button" className="button button-secondary" onClick={() => void save(null)} disabled={busy || gone}>Remove the date</button>}
      <button type="button" className="button button-secondary" onClick={close} disabled={busy}>Cancel</button>
      <button className="button button-primary" disabled={busy || gone || !date || !!problem || !changed}>Save date</button>
    </div>
  </form></Modal>
}
