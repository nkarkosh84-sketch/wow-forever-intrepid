import { useMemo, useState, type FormEvent } from 'react'
import { ArrowRightLeft, Shield, Trash2 } from 'lucide-react'
import { correctAward, removeAward, type AwardRecord, type PriorityRecord } from '../../guildApi'
import { coinsArt } from '../../shared/art'
import { makeWho, sortPlayers } from '../../shared/game/candidates'
import { phaseName, phaseNoOf } from '../../shared/game/phases'
import type { TabContext } from '../../shared/tabs/types'
import { ArtIcon } from '../../shared/ui/ArtIcon'
import { Modal } from '../../shared/ui/Modal'
import { listingProgress, priorityLookup, recipientChoices } from './completion'
import { FIX_REASON_MAX, moveChanges, reasonProblem, receiptChanged } from './receiptFix'
import './ReceiptFix.css'

// Fixing a receipt: the x next to RECEIVED on an unlocked item opens this, and so does Fix in Recently recorded (LOOT-014), for any award of the phase. The
// receipt is moved to someone else (the common case: it was recorded to the wrong character) or, when it should never have been recorded, removed with a
// reason. Either way the award is kept and the Log gets one entry that says what it was and what it is now; nothing is deleted and no Log entry is touched.
// The candidate order and council note saved with the award never change. `priority` is the list the award stands on, when there is one: without it (a Record
// loot award, or one whose list is gone) the choice is the roster alone.
export function ReceiptFixModal({ priority, award, close, live }: { priority?: PriorityRecord; award: AwardRecord; close: () => void; live: TabContext }) {
  const { busy, setBusy, setMutationError, setNotice } = live.feedback
  const { roster, settings } = live.data
  const who = useMemo(() => makeWho(roster), [roster])
  const [mode, setMode] = useState<'move' | 'remove'>('move')
  const [toId, setToId] = useState('')
  const [reason, setReason] = useState('')

  // Who it can move to: the people on the list first (the same people the award dialog offers), then anyone else on the roster.
  const holder = who.awardKey(award)
  const onList = priority === undefined ? [] : recipientChoices(priority, listingProgress(priority, live.data.awards, priorityLookup([...live.data.allPriorities, ...live.data.hiddenPriorities]), who), who).flatMap((choice) => {
    const id = choice.id ?? who.byName(choice.name)?.id
    return choice.key === holder || id === undefined ? [] : [{ ...choice, id }]
  })
  const listed = new Set(onList.map((choice) => choice.id))
  const others = sortPlayers(roster.filter((player) => !listed.has(player.id) && `id:${player.id}` !== holder), 'class')
  const label = (choice: { name: string; listed: number; received: number }) => choice.listed > 1 ? `${choice.name} (${choice.received} of ${choice.listed} received)` : choice.received ? `${choice.name} (received)` : choice.name

  const move = moveChanges(award, toId, who)
  const reasonIssue = reasonProblem(reason, mode === 'remove')
  const ready = !busy && !reasonIssue && (mode === 'move' ? toId !== '' && !move.problem : reason.trim() !== '')
  const shown = award.recipientId !== undefined ? who.player(award.recipientId)?.name ?? award.recipient : award.recipient
  const recordedIn = priority !== undefined && phaseNoOf(award) !== phaseNoOf(priority) ? phaseName(settings, phaseNoOf(award)) : undefined
  // A Record loot award has no priority, so nothing about a candidate order was saved with it; what stays is how it was decided and its note.
  const keeps = award.priorityId ? 'The candidate order and council note saved with it do not change.' : 'How it was decided and its note do not change.'

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (!ready) return
    // The award as it stands now. If someone else changed it since this dialog opened, the leader decided from a view that is out of date: nothing is written.
    const current = live.data.awards.find((entry) => entry.id === award.id) ?? award
    if (receiptChanged(award, current)) { setMutationError('This receipt was changed by someone else since you opened it. Close this and look at it again.'); return }
    const author = { uid: live.identity.uid, displayName: live.identity.displayName }
    setBusy(true)
    try {
      if (mode === 'move') {
        const { changes, problem } = moveChanges(current, toId, who)
        if (problem) throw new Error(problem)
        await correctAward(current, changes, author, reason)
        setNotice(`The receipt of ${award.item} now belongs to ${changes.recipient}. The Log shows who had it before.`)
      } else {
        await removeAward(current, reason, author)
        setNotice(`The receipt of ${award.item} was removed. It stays in the Log.`)
      }
      setMutationError('')
      close()
    } catch (error) {
      setMutationError(error instanceof Error ? error.message : 'Could not fix the receipt.')
    } finally {
      setBusy(false)
    }
  }

  return <Modal title="Fix receipt" onClose={close}>
    <div className="award-modal-item"><span className="item-gem"><ArtIcon src={coinsArt} className="loot-art-icon" /></span><span><strong>{award.item}</strong><small>Received by {shown} {'·'} {award.awardedAt}{recordedIn ? ` · recorded in ${recordedIn}` : ''}</small></span></div>
    <form className="modal-form receipt-fix-form" onSubmit={(event) => void submit(event)}>
      <fieldset className="receipt-fix-modes">
        <legend>What needs fixing?</legend>
        <label className="receipt-fix-mode"><input type="radio" name="fix" checked={mode === 'move'} onChange={() => setMode('move')} /><span><strong>It went to the wrong person</strong><small>Move the receipt to someone else.</small></span></label>
        <label className="receipt-fix-mode"><input type="radio" name="fix" checked={mode === 'remove'} onChange={() => setMode('remove')} /><span><strong>It should not have been recorded</strong><small>Remove the receipt. Nobody holds it.</small></span></label>
      </fieldset>
      {mode === 'move' && <label>Move it to<select value={toId} onChange={(event) => setToId(event.target.value)} autoFocus>
        <option value="" disabled>Choose a character</option>
        {onList.length > 0 && <optgroup label="On the list">{onList.map((choice) => <option key={choice.id} value={choice.id}>{label(choice)}</option>)}</optgroup>}
        {others.length > 0 && <optgroup label={priority === undefined ? 'The roster' : 'Anyone else on the roster'}>{others.map((player) => <option key={player.id} value={player.id}>{player.name} ({player.className})</option>)}</optgroup>}
      </select></label>}
      <label>{mode === 'remove' ? 'Reason (required)' : 'Reason (optional)'}<input value={reason} maxLength={FIX_REASON_MAX} autoComplete="off" placeholder={mode === 'remove' ? 'For example: recorded twice' : 'For example: entered under the wrong character'} onChange={(event) => setReason(event.target.value)} /></label>
      {reasonIssue && reason.trim() !== '' && <p className="receipt-fix-problem" role="alert">{reasonIssue}</p>}
      <p className="snapshot-callout"><Shield size={15} /> {mode === 'move' ? 'The Log gets one entry that says who had it and who has it now.' : 'The award stays in the Log, marked removed, with your reason.'} {keeps}</p>
      <div className="modal-actions">
        <button type="button" className="button button-secondary" onClick={close} disabled={busy}>Cancel</button>
        {mode === 'move'
          ? <button className="button button-primary" disabled={!ready}><ArrowRightLeft size={15} /> Move receipt</button>
          : <button className="button button-danger" disabled={!ready}><Trash2 size={15} /> Remove receipt</button>}
      </div>
    </form>
  </Modal>
}
