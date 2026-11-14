import { useId, useState, type FormEvent } from 'react'
import { setCharacterReadiness } from '../../guildApi'
import type { TabContext } from '../tabs/types'
import { Modal } from '../ui/Modal'
import { emptyReadinessChecklist, readinessChecks, readinessProgress, type CharacterReadiness } from './readiness'
import './RaidReadinessControl.css'

function progressColor(percent: number) {
  const hue = percent <= 50 ? percent * 0.6 : 30 + (percent - 50) * 1.8
  return `hsl(${hue} 72% 40%)`
}

function canManageReadiness(characterId: string, ctx: TabContext) {
  const main = ctx.data.roster.find((character) => character.linkedUid === ctx.identity.uid && !character.mainId)
  const character = ctx.data.roster.find((entry) => entry.id === characterId)
  return !!character && (ctx.identity.canEditRoster || !!main && (character.id === main.id || character.mainId === main.id && !character.linkedUid))
}

export function RaidReadinessControl({ characterId, name, ctx, compact = false }: { characterId: string; name: string; ctx: TabContext; compact?: boolean }) {
  const { readiness, readinessLoaded, readinessError } = ctx.data
  const record = readiness.find((entry) => entry.id === characterId)
  const progress = readinessProgress(record?.checklist ?? emptyReadinessChecklist())
  if (!canManageReadiness(characterId, ctx)) return null
  return <button type="button" className={`raid-readiness-control${compact ? ' raid-readiness-control-compact' : ''}`} disabled={ctx.feedback.busy || !readinessLoaded || !!readinessError} onClick={() => {
    ctx.openModal(({ close, live }) => <ReadinessForm characterId={characterId} name={name} close={close} live={live} />)
  }} aria-label={`Raid readiness: ${name}. ${readinessError ? 'Unavailable' : !readinessLoaded ? 'Loading' : `${progress.completed} of ${progress.total} complete. ${record?.ready ? 'Raid Ready' : 'Not raid ready'}`}`}>
    {(!compact || !readinessLoaded || !!readinessError) && <span>{readinessError ? 'Readiness unavailable' : !readinessLoaded ? 'Loading readiness...' : record?.ready ? 'Raid Ready' : 'Prepare for raids'}</span>}
    {readinessLoaded && !readinessError && <><span className="raid-readiness-track" aria-hidden="true"><span style={{ width: `${progress.percent}%`, backgroundColor: progressColor(progress.percent) }} /></span><small>{progress.completed}/{progress.total}{compact ? ' - ' : ' · '}{progress.percent}%</small></>}
  </button>
}

function ReadinessForm({ characterId, name, close, live }: { characterId: string; name: string; close: () => void; live: TabContext }) {
  const [initial] = useState(() => live.data.readiness.find((entry) => entry.id === characterId))
  const [checklist, setChecklist] = useState(() => ({ ...(initial?.checklist ?? emptyReadinessChecklist()) }))
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')
  const progressId = useId()
  const { busy, setBusy, setMutationError, setNotice } = live.feedback
  const current = live.data.readiness.find((entry) => entry.id === characterId)
  const sameRecord = (a: CharacterReadiness | undefined, b: CharacterReadiness | undefined) => a ? !!b && a.updatedAt.isEqual(b.updatedAt) : !b
  const stale = !sameRecord(initial, current)
  const allowed = canManageReadiness(characterId, live)
  const unavailable = !live.data.readinessLoaded || !!live.data.readinessError
  const disabled = busy || saving || stale || unavailable || !allowed
  const progress = readinessProgress(checklist)
  const dirty = !initial?.checklist || readinessChecks.some(({ key }) => checklist[key] !== initial.checklist?.[key])
  const check = ({ key, label }: typeof readinessChecks[number]) => <label key={key} className="raid-readiness-check"><input type="checkbox" autoFocus={key === 'level60'} checked={checklist[key]} disabled={disabled} onChange={(event) => setChecklist((previous) => ({ ...previous, [key]: event.target.checked }))} /><span>{label}</span></label>
  const dismiss = () => { if (!saving && !busy) close() }

  async function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (disabled || !dirty) return
    setSaving(true)
    setBusy(true)
    setError('')
    try {
      await setCharacterReadiness(characterId, checklist, initial?.updatedAt ?? null)
      setMutationError('')
      setNotice(`${name}: readiness saved (${progress.completed}/${progress.total}). ${progress.ready ? 'Raid Ready.' : 'Not raid ready yet.'}`)
      close()
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Could not save raid readiness.'
      setError(message)
      setMutationError(message)
    } finally {
      setBusy(false)
      setSaving(false)
    }
  }
  return <Modal title={`Raid readiness: ${name}`} onClose={dismiss}>
    <form className="raid-readiness-form" onSubmit={(event) => void save(event)}>
      <p>Confirm your preparation and acknowledgments for this character. Save your progress at any time; all nine checks are required to be raid ready.</p>
      {initial && !initial.checklist && <p className="raid-readiness-transition">The previous ready/not-ready flag did not record these steps. Please complete this checklist; no steps have been assumed complete.</p>}
      <div className="raid-readiness-progress">
        <label htmlFor={progressId}>{progress.completed} of {progress.total} complete · {progress.percent}%</label>
        <progress id={progressId} max={progress.total} value={progress.completed} style={{ color: progressColor(progress.percent) }} />
        <span role="status">{progress.ready ? dirty ? 'Ready when saved' : 'Raid Ready' : 'Not raid ready yet'}{dirty ? ' · Unsaved progress' : ' · Saved'}</span>
      </div>
      <fieldset disabled={disabled} className="raid-readiness-checks"><legend>Readiness checklist</legend>
        {readinessChecks.filter((entry) => ['level60', 'raidRequirements'].includes(entry.key)).map(check)}
        <fieldset className="raid-readiness-preparation"><legend>I have spent time preparing my character for raiding:</legend>{readinessChecks.filter((entry) => 'preparation' in entry).map(check)}</fieldset>
        <fieldset className="raid-readiness-preparation"><legend>Acknowledge that:</legend>{readinessChecks.filter((entry) => 'acknowledgment' in entry).map(check)}</fieldset>
      </fieldset>
      <p className="raid-readiness-note">This is your confirmation of preparation, not automatic game verification. Readiness does not reserve a raid spot or restrict sign-ups. Unchecking a step and saving marks this character not ready.</p>
      {unavailable && <p role="alert">{live.data.readinessError || 'Loading raid readiness. Please wait before saving.'}</p>}
      {!allowed && <p role="alert">You can no longer edit this character's readiness.</p>}
      {stale && <p role="alert">Readiness changed while you were editing. Close and reopen the checklist to review the latest progress.</p>}
      {error && <p role="alert">{error}</p>}
      <div className="modal-actions"><button type="button" className="button button-secondary" disabled={saving || busy} onClick={dismiss}>Cancel</button><button type="submit" className="button button-primary" disabled={disabled || !dirty}>{saving ? 'Saving...' : 'Save progress'}</button></div>
    </form>
  </Modal>
}
