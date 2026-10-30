import { useEffect, useId, useRef, useState, type KeyboardEvent } from 'react'
import { formatRaidTime, isRaidCancelled, raidTimeOf, type RaidRecord, type RaidSize } from '../../guildApi'
import { subscribeRaidSignups, type RaidSignup } from '../../raidSignups'
import { effectiveRaidSignups } from '../../shared/raids/availability'
import { RaidBanner } from '../../shared/raids/RaidBanner'
import { RaidSignupModal } from '../../shared/raids/RaidSignupModal'
import { ScheduledRaidRoster } from '../../shared/raids/ScheduledRaidRoster'
import type { TabContext } from '../../shared/tabs/types'
import { raidRowId } from './groupRaids'
import { defaultRaidRowTab, raidRowTabLabels, raidRowTabs, tabForKey, type RaidRowTab } from './rowTabs'
import { ScheduledRaidWorkbench } from './ScheduledRaidWorkbench'
import { SignupBoard } from './SignupBoard'

const dateLabel = (date: string) => {
  const day = new Date(`${date}T12:00:00Z`)
  return Number.isNaN(day.getTime()) ? date : day.toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric', year: 'numeric', timeZone: 'UTC' })
}

// What a closed raid says it is. A raid still to come shows no chip.
function statusChip(raid: RaidRecord, closed: boolean) {
  if (isRaidCancelled(raid)) return { label: 'Cancelled', tone: 'cancelled' }
  return closed ? { label: 'Started', tone: 'closed' } : null
}

/**
 * One scheduled raid as a collapsed row: its zone pictures, name, date, time (ET), zones with their sizes and a status chip, all from the raid's own record, so a closed row
 * starts no listener. Opening it mounts the panel that has always been here (the actions and the roster) for this raid only, so its sign-up and planning listeners run only
 * while it is open. A closed <details> still mounts its children, so the panel is rendered only when the row is open. The panel has two tabs (RAID-018): Signups, a board
 * of who is coming, and Groups, the workbench as it was.
 */
export function RaidRow({ raid, ctx, closed, open, onToggle }: { raid: RaidRecord; ctx: TabContext; closed: boolean; open: boolean; onToggle: (raidId: string, open: boolean) => void }) {
  const [hideAlts, setHideAlts] = useState(false)
  const zones = raid.zones ?? []
  const sizes = [...new Set(zones.length ? zones.map((zone) => zone.size) : [raid.size])]
  const size = sizes.includes(ctx.shell.raidView) ? ctx.shell.raidView : sizes[0]
  const chip = statusChip(raid, closed)
  return <details className="raid-row" id={raidRowId(raid.id)} open={open} onToggle={(event) => { if (event.target === event.currentTarget) onToggle(raid.id, event.currentTarget.open) }}>
    <summary className="raid-row-summary">
      <span className="raid-row-art"><RaidBanner zones={zones} zoneArt={ctx.data.zoneArt} zoneColors={ctx.data.zoneColors} /></span>
      <h3 className="raid-row-name"><span className="raid-row-caret" aria-hidden="true" />{raid.name}</h3>
      <span className="raid-row-meta">{dateLabel(raid.date)} · {formatRaidTime(raidTimeOf(raid))} · {zones.length ? zones.map((zone) => `${zone.name} (${zone.size})`).join(', ') : `${raid.size}-player`}</span>
      {chip && <span className={`raid-row-chip raid-row-chip-${chip.tone}`}>{chip.label}</span>}
    </summary>
    {open && <RaidRowPanel raid={raid} ctx={ctx} closed={closed} sizes={sizes} size={size} hideAlts={hideAlts} setHideAlts={setHideAlts} />}
  </details>
}

/**
 * An opened row: the Signups and Groups tabs (the ARIA tabs pattern: arrows, Home and End move between them, and only the selected one is in the Tab order) above the
 * row's body, which is their one tab panel. The body keeps its children as they were (the actions, then the roster); the Groups tab shows exactly what it showed before,
 * and the Signups tab drops the lineup-size and alts controls, which only the workbench uses. The tab lives only while the row is open: a row opens on Groups for a Guild
 * or Raid Leader and on Signups for everyone else. Switching tabs re-renders the same roster, so it starts no listener.
 */
function RaidRowPanel({ raid, ctx, closed, sizes, size, hideAlts, setHideAlts }: { raid: RaidRecord; ctx: TabContext; closed: boolean; sizes: RaidSize[]; size: RaidSize; hideAlts: boolean; setHideAlts: (hide: boolean) => void }) {
  const [tab, setTab] = useState<RaidRowTab>(() => defaultRaidRowTab(ctx.identity.canEditRaidData))
  const id = useId()
  const tabId = (key: RaidRowTab) => `${id}-tab-${key}`
  const panelId = `${id}-panel`
  const tabButtons = useRef<Partial<Record<RaidRowTab, HTMLButtonElement | null>>>({})
  const onTabKey = (event: KeyboardEvent<HTMLButtonElement>) => {
    const next = tabForKey(raidRowTabs, tab, event.key)
    if (!next) return
    event.preventDefault()
    setTab(next)
    tabButtons.current[next]?.focus()
  }
  return <>
    <div className="raid-row-tabs" role="tablist" aria-label={`${raid.name}: signups and groups`}>
      {raidRowTabs.map((key) => <button key={key} ref={(button) => { tabButtons.current[key] = button }} type="button" role="tab" id={tabId(key)} className="raid-row-tab" aria-selected={key === tab} aria-controls={panelId} tabIndex={key === tab ? 0 : -1} onClick={() => setTab(key)} onKeyDown={onTabKey}>{raidRowTabLabels[key]}</button>)}
    </div>
    <div className="raid-row-body" role="tabpanel" id={panelId} aria-labelledby={tabId(tab)}>
      <div className="scheduled-raids-actions">
        <button className="button button-secondary" onClick={() => ctx.openModal(({ close, live }) => <RaidSignupModal raidId={raid.id} close={close} live={live} />)}>Your sign-up / roster</button>
        <button className="button button-secondary" onClick={() => ctx.navigate('afk', raid.id)}>Open Guild Calendar</button>
        {tab === 'groups' && <div className="scheduled-workbench-toolbar">
          <div className="segmented-control" role="group" aria-label={`Scheduled lineup size for ${raid.name}`}>{([10, 20, 40] as const).map((option) => <button type="button" key={option} disabled={!sizes.includes(option)} className={option === size ? 'segment selected' : 'segment'} aria-pressed={option === size} onClick={() => ctx.shell.setRaidView(option)}>{option}<span>player</span></button>)}</div>
          <div className="segmented-control" role="group" aria-label={`Available characters for ${raid.name}`}>
            <button type="button" className={hideAlts ? 'segment' : 'segment selected'} aria-pressed={!hideAlts} onClick={() => setHideAlts(false)}>All characters</button>
            <button type="button" className={hideAlts ? 'segment selected' : 'segment'} aria-pressed={hideAlts} onClick={() => setHideAlts(true)}>Hide alts</button>
          </div>
        </div>}
      </div>
      <RaidRoster raid={raid} ctx={ctx} closed={closed} hideAlts={hideAlts} tab={tab} />
    </div>
  </>
}

// The row's one set of listeners: the sign-ups here and the working roster inside ScheduledRaidRoster. Both tabs render through the same ScheduledRaidRoster (its
// renderWorkbench gets the roster it already reads), so switching tabs changes only what is drawn, never what is subscribed.
function RaidRoster({ raid, ctx, closed, hideAlts, tab }: { raid: RaidRecord; ctx: TabContext; closed: boolean; hideAlts: boolean; tab: RaidRowTab }) {
  const [responses, setResponses] = useState<RaidSignup[] | null>(null)
  const [error, setError] = useState('')
  const [retry, setRetry] = useState(0)
  useEffect(() => subscribeRaidSignups(raid.id, (records) => { setResponses(records); setError('') },
    (failure) => { setResponses(null); setError(failure.message) }), [raid.id, retry])
  if (error) return <p role="alert">Could not load raid responses: {error} <button className="button button-secondary" onClick={() => { setError(''); setRetry((value) => value + 1) }}>Retry responses</button></p>
  if (!responses) return <p role="status">Loading raid responses...</p>
  const effective = effectiveRaidSignups(responses, ctx.data.afkEntries, ctx.data.roster, raid.date)
  return <ScheduledRaidRoster raid={raid} live={ctx} responses={effective} closed={closed} management renderWorkbench={(roster) => tab === 'signups'
    ? <SignupBoard invitations={roster.invitations} characters={ctx.data.roster} responses={effective} />
    : <ScheduledRaidWorkbench key={ctx.shell.raidView} raid={raid} ctx={ctx} responses={effective} roster={roster} closed={closed} hideAlts={hideAlts} />} />
}
