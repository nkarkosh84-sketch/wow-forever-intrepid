import type { CSSProperties } from 'react'
import { ArrowDown, ArrowUp, Check, ClipboardList, Lock, LockOpen, Pencil, X } from 'lucide-react'
import type { AwardRecord as Award, PriorityRecord as LootPriority } from '../../guildApi'
import { encounterArt, lootArt } from '../../shared/art'
import { ArtIcon } from '../../shared/ui/ArtIcon'
import { ItemTooltip } from '../../shared/ui/ItemTooltip'
import { readLines, type Who } from '../../shared/game/candidates'
import { classAccent } from '../../shared/game/classes'
import { awardsForPriority, isRemovedAward, listingProgress, type PriorityLookup } from './completion'
import { carriedLabel } from './carried'
import { groupPriorities, type DungeonGroup } from './groupPriorities'
import { toggleOrderLock, useUnlockedOrders } from './orderLock'
import { zoneStyle, type ZoneColors } from './useZoneColors'
import '../../shared/ui/spacing.css'
import '../../shared/ui/zoneArt.css'
import './PriorityList.css'
import './ReceiptFix.css'

// canEdit: the list can be changed (Add, Edit, reorder). canAward: loot can be awarded from it. Neither holds in a closed phase; `notice` says why.
export function PriorityList({ priorities, awards, lookup, who, canEdit, canAward, notice, busy, grouped, bossOrder, zoneColors, phaseName, onEdit, onAward, onMoveCandidate, onFixReceipt }: { priorities: LootPriority[]; grouped: boolean; bossOrder: (dungeon: string) => string[]; zoneColors: ZoneColors; awards: Award[]; lookup: PriorityLookup; who: Who; canEdit: boolean; canAward: boolean; notice?: string; busy: boolean; onEdit: (priority: LootPriority) => void; onAward: (priority: LootPriority) => void; onMoveCandidate: (priority: LootPriority, index: number, direction: -1 | 1) => void; onFixReceipt: (priority: LootPriority, award: Award) => void; phaseName: (no: number) => string }) {
  const unlocked = useUnlockedOrders()
  const row = (priority: LootPriority, index: number) => {
    const progress = listingProgress(priority, awards, lookup, who)
    const lines = readLines(priority)
    const open = canEdit && unlocked.has(priority.id)
    const carried = carriedLabel(priority, lookup, phaseName)
    const recentAward = awardsForPriority(priority, awards, lookup).filter((award) => !isRemovedAward(award)).sort((a, b) => b.awardedAt.localeCompare(a.awardedAt))[0]
    const zone = zoneColors.ofPriority(priority)
    return <article className={['priority-row stagger-row', progress.complete ? 'complete' : '', zone ? 'zone-colored' : ''].filter(Boolean).join(' ')} key={priority.id} style={{ '--row-index': index, ...zoneStyle(zone) } as CSSProperties}>
      <div className="priority-main"><div className="priority-item-line">{!priority.itemId && <span className="item-gem"><ArtIcon src={lootArt} className="priority-loot-icon" /></span>}<div><h3>{priority.itemId ? <ItemTooltip itemId={priority.itemId} fallbackName={priority.item} /> : priority.item}</h3><span className="encounter-label"><ArtIcon src={encounterArt} className="encounter-art-icon" /> {priority.encounter}</span>{carried && <span className="carried-tag">{carried}</span>}</div></div><p className="council-note">{priority.councilNote || <span className="muted">{canEdit ? 'No council note yet. Use Edit Prio to add one.' : 'No council note yet'}</span>}</p></div>
      <div className="priority-ranking"><div className="ranking-heading"><span>COUNCIL ORDER{canEdit && <button className="order-lock" onClick={() => toggleOrderLock(priority.id)} aria-pressed={open} title={open ? 'Lock the order again' : 'Unlock to move the candidates up and down'} aria-label={open ? `Lock the order of ${priority.item}` : `Unlock the order of ${priority.item}`}>{open ? <LockOpen size={12} /> : <Lock size={12} />}</button>}</span><span className="rank-count">{priority.rankedPlayers.length ? `${priority.rankedPlayers.length} ranked` : <span className="needs-players">Needs players</span>}{progress.complete && <span className="complete-tag">COMPLETE</span>}</span></div>
        {lines.length ? <ol>{lines.map((line, rank) => {
          const name = who.nameOf(line)
          const label = line.kind === 'note' ? 'note' : name
          const reorder = open && <span className="rank-reorder"><button onClick={() => onMoveCandidate(priority, rank, -1)} disabled={busy || rank === 0} title="Move up" aria-label={`Move ${label} up`}><ArrowUp size={13} /></button><button onClick={() => onMoveCandidate(priority, rank, 1)} disabled={busy || rank === lines.length - 1} title="Move down" aria-label={`Move ${label} down`}><ArrowDown size={13} /></button></span>
          const number = <span className={rank === progress.next ? 'rank-number first' : 'rank-number'}>{String(rank + 1).padStart(2, '0')}</span>
          if (line.kind === 'note') return <li key={`${name}-${rank}`} className={line.done ? 'listing-note note-done' : 'listing-note'}>{number}<span className="ranked-name">{name}</span>{line.done ? <span className="received-tag"><Check size={10} /> DONE</span> : rank === progress.next && <span className="top-pick">NEXT UP</span>}{reorder}</li>
          const cls = who.classOf(line)
          return <li key={`${name}-${rank}`} className={[progress.received[rank] ? 'listing-received' : '', cls ? classAccent(cls) : ''].filter(Boolean).join(' ') || undefined}>{number}<span className="ranked-name">{name}</span>{line.id !== undefined && !who.known(line) && <span className="not-on-roster">not on the roster</span>}{progress.received[rank] && <span className="received-tag"><Check size={10} /> RECEIVED</span>}{open && progress.receipts[rank] && <button className="receipt-fix" onClick={() => onFixReceipt(priority, progress.receipts[rank]!)} disabled={busy} title="Fix this receipt: move it to someone else, or remove it if it was a mistake" aria-label={`Fix the receipt of ${priority.item} for ${name}`}><X size={11} /></button>}{rank === progress.next && <span className="top-pick">{rank === 0 ? 'TOP PICK' : 'NEXT UP'}</span>}{reorder}</li>
        })}</ol> : <div className="unranked">Needs players{canEdit && <>: use Assign players to add them in order.</>}</div>}
      </div>
      {canEdit && <div className="priority-actions">{recentAward && <span className="awarded-tag"><Check size={13} /> Last awarded {new Date(`${recentAward.awardedAt}T12:00:00`).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })}</span>}{!priority.rankedPlayers.length && <button className="button button-secondary" onClick={() => onEdit(priority)} disabled={busy}>Assign players</button>}{canAward && <button className="button button-award" onClick={() => onAward(priority)} disabled={busy || !priority.rankedPlayers.length}><Check size={14} /> Award loot</button>}<button className="button button-secondary" onClick={() => onEdit(priority)} disabled={busy} title="Edit this priority: the item, the players and the council note" aria-label={`Edit priority for ${priority.item}`}><Pencil size={14} /> Edit Prio</button></div>}
    </article>
  }
  // Grouped: a heading for each dungeon and for each boss in it, then its rows. The animation index runs on through all the rows.
  let position = 0
  // The color of a dungeon's heading is that of its priorities (by their zone number, so a renamed zone keeps its color), else of the zone with that name.
  const headingColor = (group: DungeonGroup<LootPriority>) => group.bosses.flatMap((boss) => boss.priorities).map((priority) => zoneColors.ofPriority(priority)).find(Boolean) ?? zoneColors.ofName(group.dungeon)
  const headingArt = (group: DungeonGroup<LootPriority>) => group.bosses.flatMap((boss) => boss.priorities).map((priority) => zoneColors.artOfPriority(priority)).find(Boolean) ?? zoneColors.artOfName(group.dungeon)
  const groupedRows = () => groupPriorities(priorities, bossOrder).flatMap((group) => [
    <div key={`d-${group.key}`} className={['priority-dungeon', headingColor(group) ? 'zone-colored' : '', headingArt(group) ? 'zone-arted' : ''].filter(Boolean).join(' ')} style={zoneStyle(headingColor(group), headingArt(group))} role="heading" aria-level={3}>{group.dungeon || 'Other priorities'}<span>{group.count} {group.count === 1 ? 'item' : 'items'}</span></div>,
    ...group.bosses.flatMap((boss) => [
      <div key={`b-${boss.key}`} className={headingColor(group) ? 'priority-boss zone-colored' : 'priority-boss'} style={zoneStyle(headingColor(group))} role="heading" aria-level={4}>{boss.boss || 'No encounter noted'}<span>{boss.priorities.length}</span></div>,
      ...boss.priorities.map((priority) => row(priority, position++)),
    ]),
  ])
  return <div className="priority-list">{notice && <p className="phase-notice" role="note">{notice}</p>}{grouped ? groupedRows() : priorities.map(row)}{!priorities.length && <div className="empty-state"><span className="empty-icon"><ClipboardList size={21} /></span><strong>No priorities found</strong><p>Leaders add items from Browse drops. Adjust your search or filters to see more.</p></div>}</div>
}
