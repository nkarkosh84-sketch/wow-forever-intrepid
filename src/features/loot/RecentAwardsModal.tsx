import { useMemo, useState } from 'react'
import { Pencil } from 'lucide-react'
import type { AwardRecord } from '../../guildApi'
import { makeWho } from '../../shared/game/candidates'
import { currentPhaseNo, phaseName } from '../../shared/game/phases'
import type { TabContext } from '../../shared/tabs/types'
import { Modal } from '../../shared/ui/Modal'
import { ReceiptFixModal } from './ReceiptFixModal'
import { awardState, howDecided, moreLabel, placeOf, RECENT_STEP, recentAwards, recentPage } from './recentAwards'
import '../../shared/ui/spacing.css'
import './RecentAwards.css'

// A raid night for a row: "Dec 9", with the year when it is not this year.
function nightOf(day: string) {
  const date = new Date(`${day}T12:00:00`)
  if (Number.isNaN(date.getTime())) return day || 'No date'
  return date.toLocaleDateString(undefined, { month: 'short', day: 'numeric', ...(date.getFullYear() === new Date().getFullYear() ? {} : { year: 'numeric' }) })
}

// Recently recorded (LOOT-014): every award of the current phase, newest raid night first, with or without a priority list, so a leader can move one to
// someone else or remove it. Before priority lists exist (the first raid nights) every award is a Record loot award, and the x on a priority line, the
// only other way to fix one, never appears for them. Fix opens the same ReceiptFixModal as that x: the move, the removal, the reason rules and the check
// that the award did not change meanwhile are its own, and the rules check the write and its Log entry as before. A removed award is listed, its item struck through, with its
// reason and no Fix (it is recorded again instead). Only one dialog is open at a time, so Fix takes the place of this one.
export function RecentAwardsModal({ close, live }: { close: () => void; live: TabContext }) {
  const [shown, setShown] = useState(RECENT_STEP)
  const { roster, settings, awards } = live.data
  const who = useMemo(() => makeWho(roster), [roster])
  const phaseNo = currentPhaseNo(settings)
  const list = useMemo(() => recentAwards(awards, phaseNo), [awards, phaseNo])
  const page = recentPage(list, shown)
  // The Fix button is for leaders only (the rules let only them change an award); the button that opens this dialog is too.
  const canFix = live.identity.canEditRaidData
  const { busy } = live.feedback
  const priorities = new Map([...live.data.allPriorities, ...live.data.hiddenPriorities].map((priority) => [priority.id, priority]))

  function fix(award: AwardRecord) {
    // An award made from a list offers the people on it first, as the x does. A Record loot award has no list: the choice is the roster.
    const priority = award.priorityId ? priorities.get(award.priorityId) : undefined
    live.openModal(({ close, live }) => <ReceiptFixModal priority={priority} award={award} close={close} live={live} />)
  }

  return <Modal title="Recently recorded" onClose={close}><div className="recent-awards">
    <p className="recent-intro">Every award recorded in <strong>{phaseName(settings, phaseNo)}</strong>, the newest raid night first, with or without a priority list.{canFix ? ' Fix moves one to someone else, or removes it if it was a mistake; the Log keeps what it was.' : ''}</p>
    {list.length === 0 ? <p className="recent-empty">Nothing has been recorded in {phaseName(settings, phaseNo)} yet.</p>
      : <ol className="recent-list">{page.rows.map((award) => {
        const state = awardState(award)
        const player = award.recipientId !== undefined ? who.player(award.recipientId) : who.byName(award.recipient)
        const name = (award.recipientId !== undefined ? player?.name : undefined) ?? award.recipient
        const facts = [placeOf(award.encounter), howDecided(award), nightOf(award.awardedAt)].filter(Boolean).join(' · ')
        return <li key={award.id} className={`recent-award recent-${state}`}>
          <div className="recent-award-text">
            <span className="recent-award-line"><strong>{award.item || 'Unnamed item'}</strong><span className="recent-award-to">{name}{player?.className ? ` (${player.className})` : ''}</span>{state === 'corrected' && <span className="recent-tag" title="Changed since it was recorded. The Log says what it was.">Corrected</span>}{state === 'removed' && <span className="recent-tag recent-tag-removed">Removed</span>}</span>
            <small className="recent-award-facts">{facts}</small>
            {state === 'removed' && <small className="recent-award-reason">Reason: {award.removedReason || 'none given'}</small>}
          </div>
          {canFix && state !== 'removed' && <button type="button" className="button button-secondary recent-fix" onClick={() => fix(award)} disabled={busy} title="Move it to someone else, or remove it if it was a mistake" aria-label={`Fix the award of ${award.item || 'this item'} to ${name}`}><Pencil size={13} /> Fix</button>}
        </li>
      })}</ol>}
    {page.total > 0 && <p className="recent-count">Showing {page.rows.length} of {page.total}</p>}
    {page.more > 0 && <button type="button" className="button button-secondary recent-more" onClick={() => setShown((current) => current + RECENT_STEP)}>{moreLabel(page.more)}</button>}
  </div></Modal>
}
