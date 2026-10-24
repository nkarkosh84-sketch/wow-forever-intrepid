import { useEffect, useMemo, useState } from 'react'
import { subscribeAuditLog } from '../../guildApi'
import { makeWho } from '../../shared/game/candidates'
import { TABLE_PHASE_MAX, firstPhases } from '../../shared/game/guildTables'
import { awardAsRecorded, isLegacyAward, legacyAwardEntry, legacyRowUncertain, type AuditEntry } from '../../shared/game/lootAudit'
import { currentPhaseNo, phaseName } from '../../shared/game/phases'
import { peekItem, requestItem } from '../../shared/lib/itemInfo'
import type { TabContext } from '../../shared/tabs/types'
import { Modal } from '../../shared/ui/Modal'
import { describeEntry } from './auditText'
import { encounterOptions } from './groupPriorities'
import { logFacts, logFilterActive, logPlayers, matchesLogFilter, noLogFilter, type LogFilter } from './logFilters'
import { slotChoices } from './slots'
import { useBossOrder, useMergedTables } from './useDropTables'
import { useSlotOf } from './useSlotOf'
import '../../shared/ui/spacing.css'
import './LootFilters.css'
import './AuditLog.css'

type Show = 'all' | 'priority' | 'award' | 'table'
const shows: { value: Show; label: string }[] = [{ value: 'all', label: 'All' }, { value: 'priority', label: 'Priorities' }, { value: 'award', label: 'Awards' }, { value: 'table', label: 'Drop lists' }]
const STEP = 100
// The indent of a boss under its dungeon in the encounter list.
const indent = '\u00a0\u00a0\u00a0\u00a0'

// A short time for the list: no year for the current year. The row that opens has the full time.
function whenOf(at: Date | null) {
  if (!at) return 'Just now'
  const sameYear = at.getFullYear() === new Date().getFullYear()
  return at.toLocaleString(undefined, { month: 'short', day: 'numeric', ...(sameYear ? {} : { year: 'numeric' }), hour: 'numeric', minute: '2-digit' })
}

const timeOf = (entry: AuditEntry) => (entry.at ? entry.at.getTime() : Number.MAX_SAFE_INTEGER)

// Every change to a loot priority or an award, newest first, for every guild role: the Log. It is written by the same batch as the change and the
// rules check that each entry tells the truth, and nobody can edit or delete an entry. It listens only while this dialog is open. Awards made
// before the Log began have no entry, so they are added from the awards themselves, dated the raid night, so no award is missing from it.
export function AuditLogModal({ close, live }: { close: () => void; live: TabContext }) {
  const [show, setShow] = useState<Show>('all')
  const [query, setQuery] = useState('')
  const [filter, setFilter] = useState<LogFilter>(noLogFilter)
  const [newestFirst, setNewestFirst] = useState(true)
  const slotOf = useSlotOf()
  const [limit, setLimit] = useState(STEP)
  const [entries, setEntries] = useState<AuditEntry[] | null>(null)
  const [error, setError] = useState('')
  useEffect(() => subscribeAuditLog(limit, (list) => { setEntries(list); setError('') }, (problem) => setError(problem.message)), [limit])

  const name = (no: number) => phaseName(live.data.settings, no)
  // The Log spans phases: the boss order comes from the current phase's lists, and the names of zones and creatures from the latest of every phase (a zone
  // prepared for the next phase has a name too, and an entry that sets no name is named from here).
  const nowNo = currentPhaseNo(live.data.settings)
  const bossOrder = useBossOrder(live.data.lootTables, nowNo)
  const zones = useMergedTables(live.data.lootTables, TABLE_PHASE_MAX, true)
  const first = useMemo(() => firstPhases(live.data.lootTables), [live.data.lootTables])
  const who = useMemo(() => makeWho(live.data.roster), [live.data.roster])
  const awardsById = new Map(live.data.awards.map((award) => [award.id, award]))
  const lookups = { firstZonePhase: (zoneId: number) => first.zones.get(zoneId), firstSourcePhase: (zoneId: number, key: string) => first.sources.get(`${zoneId}_${key}`), zoneName: (zoneId: number) => zones.find((zone) => zone.zoneId === zoneId)?.name, sourceName: (zoneId: number, key: string) => zones.find((zone) => zone.zoneId === zoneId)?.sources.find((source) => source.key === key)?.name, itemName: (itemId: number) => { const state = peekItem(itemId); return state?.status === 'ready' ? state.info.name : undefined }, awardRecipient: (id: string) => { const award = awardsById.get(id); return award ? ((award.recipientId !== undefined ? who.player(award.recipientId)?.name : undefined) ?? award.recipient) : undefined } }
  // A phase started or reopened changes which lists are current, so it is shown with the priorities.
  const wanted = (type: string) => (show === 'all' ? type === 'priority' || type === 'award' || type === 'phase' || type === 'table' : show === 'priority' ? type === 'priority' || type === 'phase' : show === 'table' ? type === 'table' : type === 'award')
  // An award from before the Log began has no entry, so it is added from the award itself (isLegacyAward: a correction gives it a revision and an entry of its
  // own, and it must not drop out of the Log by that). Its row says what it said when it was recorded: a later correction is its own entry, with the old and new value.
  const more = entries !== null && entries.length >= limit
  const earlier = live.data.awards.filter(isLegacyAward).map((award) => legacyAwardEntry(awardAsRecorded(award, entries ?? [])))
  // Only the newest entries are loaded, so the first row of such an award that was fixed can be unsure: its fix is not among them, and it can only show the award as it is now.
  const unsure = new Set(live.data.awards.filter((award) => legacyRowUncertain(award, entries ?? [], more)).map((award) => `before-${award.id}`))
  const text = query.trim().toLowerCase()
  const priorities = new Map([...live.data.allPriorities, ...live.data.hiddenPriorities].map((priority) => [priority.id, priority]))
  const everything = [...(entries ?? []), ...earlier].filter((entry) => wanted(entry.targetType)).map((entry) => ({ entry, facts: logFacts(entry, (id) => priorities.get(id), who, (id) => awardsById.get(id) as Record<string, unknown> | undefined) }))
  // The dropdowns offer what the entries are about; looking the items up is what lets the slot filter tell which ones match.
  const itemKey = [...new Set(everything.flatMap(({ facts }) => (facts.itemId ? [facts.itemId] : [])))].join(',')
  useEffect(() => { if (itemKey) itemKey.split(',').forEach((id) => requestItem(Number(id))) }, [itemKey])
  const players = logPlayers(everything.map(({ facts }) => facts), filter.player)
  const encounters = encounterOptions(everything.filter(({ facts }) => facts.encounter).map(({ facts }) => ({ encounter: facts.encounter })), bossOrder)
  if (filter.encounter && !encounters.some((option) => option.value === filter.encounter)) encounters.push({ value: filter.encounter, label: filter.encounter.slice(2).replace('|', ' \u00b7 '), level: 0 })
  const rows = everything
    .filter(({ facts }) => matchesLogFilter(facts, filter, slotOf))
    .sort((a, b) => (newestFirst ? timeOf(b.entry) - timeOf(a.entry) : timeOf(a.entry) - timeOf(b.entry)))
    .map(({ entry }) => { const words = describeEntry(entry, name, lookups); return { entry, ...words, details: unsure.has(entry.id) ? [...words.details, 'Older entries are not loaded yet, so this shows the award as it is now. Load older entries to see how it was first recorded.'] : words.details } })
    .filter(({ entry, title, details }) => !text || [title, entry.byName, ...details].join(' ').toLowerCase().includes(text))
  const narrowed = !!text || logFilterActive(filter)

  return <Modal title="Log" onClose={close}><div className="audit-log">
    <p className="audit-intro">Every change to a loot priority, an award, a phase or a drop list, newest first. Open a line to see who made it and what changed. Nobody can edit or delete an entry.</p>
    <div className="audit-controls">
      <div className="segmented-control audit-toggle" role="group" aria-label="What to show">
        {shows.map((option) => <button key={option.value} type="button" className={show === option.value ? 'segment selected' : 'segment'} aria-pressed={show === option.value} onClick={() => setShow(option.value)}>{option.label}</button>)}
      </div>
      <input className="audit-search" type="search" aria-label="Find in the Log" placeholder="Find an item or a player..." value={query} onChange={(event) => setQuery(event.target.value)} />
    </div>
    <div className="audit-controls">
      <select className="loot-filter-select" aria-label="Filter by player" value={filter.player} onChange={(event) => setFilter({ ...filter, player: event.target.value })}>
        <option value="">All players</option>
        {players.map((player) => <option key={player.key} value={player.key}>{player.name}</option>)}
      </select>
      <select className="loot-filter-select" aria-label="Filter by item slot" value={filter.slot} onChange={(event) => setFilter({ ...filter, slot: event.target.value })}>
        <option value="">All slots</option>
        {slotChoices.map((slot) => <option key={slot} value={slot}>{slot}</option>)}
      </select>
      <select className="loot-filter-select" aria-label="Filter by dungeon or boss" value={filter.encounter} onChange={(event) => setFilter({ ...filter, encounter: event.target.value })}>
        <option value="">All encounters</option>
        {encounters.map((option) => <option key={option.value} value={option.value}>{option.level === 1 ? indent : ''}{option.label}</option>)}
      </select>
      <select className="loot-filter-select" aria-label="Order" value={newestFirst ? 'newest' : 'oldest'} onChange={(event) => setNewestFirst(event.target.value === 'newest')}>
        <option value="newest">Newest first</option>
        <option value="oldest">Oldest first</option>
      </select>
      {(narrowed) && <button type="button" className="loot-filter-clear" onClick={() => { setFilter(noLogFilter); setQuery('') }}>Clear filters</button>}
    </div>
    {error && <p className="audit-error" role="alert">The Log could not be read: {error}</p>}
    {!error && entries === null && <p className="audit-empty">Loading...</p>}
    {entries !== null && rows.length === 0 && <p className="audit-empty">{narrowed ? 'Nothing here matches.' : 'Nothing has been logged yet.'}{narrowed && more ? ' Load older entries to look further back.' : ''}</p>}
    <ol className="audit-list">{rows.map(({ entry, title, details }) => {
      // One line each: what happened and when. Who did it and the fields are in the row that opens.
      return <li key={entry.id} className={`audit-entry audit-${entry.targetType}`}>
        <details>
          <summary><span className="audit-title" title={title}>{title}</span><time className="audit-when">{entry.rev === 0 && entry.at ? entry.at.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' }) : whenOf(entry.at)}</time></summary>
          <div className="audit-body">
            <p>{entry.rev === 0 ? 'Recorded before the Log began (dated the raid night)' : <>By <strong>{entry.byName || 'Unknown'}</strong>{' '}{'\u00b7'}{' '}{entry.targetType === 'award' ? 'Award' : entry.targetType === 'phase' ? 'Phase' : entry.targetType === 'table' ? 'Drop list' : 'Priority'}{entry.at ? ` \u00b7 ${entry.at.toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'medium' })}` : ''}</>}</p>
            {details.length > 0 && <ul>{details.map((line) => <li key={line}>{line}</li>)}</ul>}
          </div>
        </details>
      </li>
    })}</ol>
    {narrowed && rows.length > 0 && <p className="audit-count">{rows.length} {rows.length === 1 ? 'entry matches' : 'entries match'}{more ? `, in the newest ${entries?.length ?? 0} entries` : ''}.</p>}
    {more && <button type="button" className="button button-secondary audit-more" onClick={() => setLimit((current) => current + STEP)}>Load older entries</button>}
  </div></Modal>
}
