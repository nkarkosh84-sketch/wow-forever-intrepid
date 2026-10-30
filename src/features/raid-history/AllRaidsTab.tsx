import { useEffect, useState } from 'react'
import { formatRaidTime, raidTimeOf, type RaidRecord } from '../../guildApi'
import { hasPhaseStarts } from '../../shared/game/phases'
import { RAID_CATEGORIES, raidCategoryLabel, type RaidCategory } from '../../shared/raids/raidCategory'
import type { TabContext } from '../../shared/tabs/types'
import { categorizedRaids, categoryCounts, inCategory, inMonth, inPhase, monthLabel, PAGE_SIZE, phaseChoices, raidMonths, type CategoryFilter, type PhaseFilter } from './raidList'

const MINUTE = 60_000
const filterOptions: CategoryFilter[] = ['all', ...RAID_CATEGORIES]

const dateLabel = (date: string) => {
  const day = new Date(`${date}T12:00:00Z`)
  return Number.isNaN(day.getTime()) ? date : day.toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric', year: 'numeric', timeZone: 'UTC' })
}

/**
 * Every raid with its category, newest first (RAID-019). It reads only the raids the app has already loaded (`ctx.data.raids`), so it adds no Firestore read; the start
 * snapshots stay in Audit Info. The Phase filter places each raid by its date in the phases' start dates from the settings, which are loaded already too.
 */
export function AllRaidsTab({ ctx }: { ctx: TabContext }) {
  const [now, setNow] = useState(Date.now)
  const [category, setCategory] = useState<CategoryFilter>('all')
  const [month, setMonth] = useState('')
  const [phase, setPhase] = useState<PhaseFilter>('all')
  const [shown, setShown] = useState(PAGE_SIZE)
  // A raid's category moves on with the clock (at its start, and 5 hours later), so the list looks again every minute.
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), MINUTE)
    return () => window.clearInterval(timer)
  }, [])

  if (ctx.data.dataError) return <p role="alert">Raids could not be loaded: {ctx.data.dataError}. Reload to retry.</p>
  if (!ctx.data.raidPlanningLoaded) return <p role="status">Loading raids...</p>

  const all = categorizedRaids(ctx.data.raids, now, raidTimeOf)
  const months = raidMonths(ctx.data.raids)
  const { settings } = ctx.data
  const phases = phaseChoices(settings)
  const dated = hasPhaseStarts(settings)
  // A phase picked earlier that is no longer offered (it was reopened away, or every date was taken away) reads as All phases.
  const picked = phase !== 'all' && dated ? phases.find((option) => option.no === phase) : undefined
  const ofMonth = inMonth(all, month)
  const ofPhase = inPhase(ofMonth, settings, picked ? picked.no : 'all')
  // A phase with no start date holds no raid (the first phase can, when it is the only one before the earliest date), so say why rather than "no match".
  const undatedEmpty = picked !== undefined && !picked.dated && !inPhase(all, settings, picked.no).length
  const counts = categoryCounts(ofPhase)
  const matching = inCategory(ofPhase, category)
  const visible = matching.slice(0, shown)

  return <div className="raid-history-all">
    <div className="raid-history-filters">
      <div className="segmented-control" role="group" aria-label="Show raids by category">
        {filterOptions.map((option) => <button type="button" key={option} className={option === category ? 'segment selected' : 'segment'} aria-pressed={option === category}
          onClick={() => { setCategory(option); setShown(PAGE_SIZE) }}>{option === 'all' ? 'All' : raidCategoryLabel[option]}<span>{counts[option]}</span></button>)}
      </div>
      <label className="raid-history-month">Month
        <select value={month} onChange={(event) => { setMonth(event.target.value); setShown(PAGE_SIZE) }}>
          <option value="">All months</option>
          {months.map((value) => <option key={value} value={value}>{monthLabel(value)}</option>)}
        </select>
      </label>
      <label className="raid-history-phase">Phase
        <select value={picked ? String(picked.no) : ''} disabled={!dated} aria-describedby={dated ? undefined : 'raid-history-phase-why'}
          onChange={(event) => { setPhase(event.target.value === '' ? 'all' : Number(event.target.value)); setShown(PAGE_SIZE) }}>
          <option value="">All phases</option>
          {phases.map((option) => <option key={option.no} value={option.no}>{option.name}{option.dated ? '' : ' (no start date)'}</option>)}
        </select>
      </label>
      {!dated && <p className="raid-history-phase-why" id="raid-history-phase-why">No loot phase has a start date yet, so raids cannot be shown by phase. A Guild Leader can set the dates in Settings, under Loot phases.</p>}
    </div>
    {!all.length
      ? <div className="empty-state raid-history-empty"><strong>No raids yet</strong><p>Raids scheduled on the Guild Calendar appear here, newest first.</p></div>
      : !matching.length
        ? <p className="raid-history-none" role="status">{undatedEmpty ? `${picked.name} has no start date, so no raid is placed in it. A Guild Leader can set it in Settings, under Loot phases.` : 'No raids match these filters.'}</p>
        : <>
          <ul className="raid-history-raids" aria-label="Raids, newest first">
            {visible.map((entry) => <RaidLine key={entry.raid.id} raid={entry.raid} category={entry.category} />)}
          </ul>
          <div className="raid-history-more">
            <span>Showing {visible.length} of {matching.length} {matching.length === 1 ? 'raid' : 'raids'}</span>
            {visible.length < matching.length && <button type="button" className="button button-secondary" onClick={() => setShown((current) => current + PAGE_SIZE)}>Show more</button>}
          </div>
        </>}
  </div>
}

function RaidLine({ raid, category }: { raid: RaidRecord; category: RaidCategory }) {
  const zones = raid.zones ?? []
  return <li className="raid-history-raid">
    <div className="raid-history-raid-text">
      <strong>{raid.name}</strong>
      <small>{dateLabel(raid.date)} · {formatRaidTime(raidTimeOf(raid))} · {zones.length ? zones.map((zone) => `${zone.name} (${zone.size})`).join(', ') : `${raid.size}-player`}</small>
      {category === 'cancelled' && raid.cancelReason && <small>Reason: {raid.cancelReason}</small>}
    </div>
    <span className={`raid-history-category raid-history-category-${category}`}>{raidCategoryLabel[category]}</span>
  </li>
}
