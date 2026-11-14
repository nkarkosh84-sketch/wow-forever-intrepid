import { useState, type CSSProperties, type ReactNode } from 'react'
import { ArrowDown, ArrowUp, ArrowUpDown, ChevronDown, ChevronRight, CornerDownRight, Pencil } from 'lucide-react'
import type { PlayerRecord as Player, TenManTeam } from '../../guildApi'
import { classColorKey } from '../../shared/game/classes'
import type { TeamOption } from '../../shared/game/teams'
import { ClassAvatar } from '../../shared/ui/ClassAvatar'
import { EmptyRow } from '../../shared/ui/EmptyRow'
import { RolePill } from '../../shared/ui/RolePill'
import { groupAlts } from './filter'
import type { CommentFeed } from '../../rosterComments'
import { RosterCommentCell } from './RosterCommentCell'
import { useShowComments } from './commentVisibility'
import { raiderTypeLabel, type RosterRaiderType } from './raiderTypes'
import { rosterAccountUid } from './account'
import { toggleSort, useSortChoice } from './sortChoice'
import type { SortKey } from './sort'

function SortHeader({ label, sortKey, disabled, sortUnavailable }: { label: string; sortKey: Exclude<SortKey, 'default'>; disabled?: boolean; sortUnavailable: boolean }) {
  const sort = useSortChoice()
  const active = sort.key === sortKey && !sortUnavailable
  const Icon = active ? (sort.direction === 'asc' ? ArrowUp : ArrowDown) : ArrowUpDown
  return <th scope="col" className={sortKey === 'team' ? 'team-column-heading' : undefined} aria-sort={active ? (sort.direction === 'asc' ? 'ascending' : 'descending') : undefined}>
    <button type="button" className="roster-sort-header" disabled={disabled} onClick={() => toggleSort(sortKey)} title={disabled ? 'Sorting is unavailable while this data is loading or has an error.' : `Sort by ${label}`}>
      {label}<Icon size={13} aria-hidden="true" />
    </button>
  </th>
}

export function RosterTable({ teams, players, allPlayers, hideAlts, keepAltsTogether, assignments, canEdit, onEdit, comments, showLeadership, readinessControl, raiderTypes, sortUnavailable }: { teams: TeamOption[]; players: Player[]; allPlayers: Player[]; hideAlts: boolean; keepAltsTogether: boolean; assignments: Record<string, TenManTeam>; canEdit: boolean; onEdit: (player: Player) => void; comments: { public: CommentFeed; leadership: CommentFeed | null }; showLeadership: boolean; readinessControl?: (player: Player) => ReactNode; raiderTypes: { records: RosterRaiderType[]; loading: boolean; error: string }; sortUnavailable: boolean }) {
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set())
  const showComments = useShowComments()
  const { rows, mainNames } = groupAlts(players, allPlayers, collapsed, keepAltsTogether)
  const rosterById = new Map(allPlayers.map((player) => [player.id, player]))
  const typesByUid = new Map(raiderTypes.records.map((record) => [record.id, record.type]))
  const toggle = (id: string) => setCollapsed((current) => { const next = new Set(current); if (!next.delete(id)) next.add(id); return next })
  return <div className="table-scroll"><table className={`data-table roster-table${showComments ? ' roster-with-comments' : ''}${readinessControl ? ' roster-with-readiness' : ''}`}><colgroup><col className="roster-col-character" />{showComments ? <><col className="roster-col-comment" />{showLeadership && <col className="roster-col-comment" />}</> : <><col className="roster-col-class" /><col className="roster-col-spec" /><col className="roster-col-role" /><col className="roster-col-team" /><col className="roster-col-type" /><col className="roster-col-access" />{readinessControl && <col className="roster-col-readiness" />}{canEdit && <col className="roster-col-actions" />}</>}</colgroup><thead><tr><SortHeader label="CHARACTER" sortKey="name" sortUnavailable={sortUnavailable} />{showComments ? <><SortHeader label="PUBLIC COMMENT" sortKey="publicComment" disabled={comments.public.loading || !!comments.public.error} sortUnavailable={sortUnavailable} />{showLeadership && comments.leadership && <SortHeader label="LEADERSHIP COMMENT" sortKey="leadershipComment" disabled={comments.leadership.loading || !!comments.leadership.error} sortUnavailable={sortUnavailable} />}</> : <><SortHeader label="CLASS" sortKey="class" sortUnavailable={sortUnavailable} /><SortHeader label="SPECIALIZATION" sortKey="specialization" sortUnavailable={sortUnavailable} /><SortHeader label="ROLE" sortKey="role" sortUnavailable={sortUnavailable} /><SortHeader label="10-PLAYER TEAM" sortKey="team" sortUnavailable={sortUnavailable} /><SortHeader label="RAIDER TYPE" sortKey="raiderType" disabled={raiderTypes.loading || !!raiderTypes.error} sortUnavailable={sortUnavailable} /><SortHeader label="APP ACCESS" sortKey="access" sortUnavailable={sortUnavailable} />{readinessControl && <th scope="col">RAID READINESS</th>}{canEdit && <th><span className="visually-hidden">Actions</span></th>}</>}</tr></thead><tbody>
    {rows.map(({ player, isAlt, altCount }, index) => {
      const assignedTeam = teams.find((team) => team.key === assignments[player.id])
      const owner = rosterAccountUid(player, rosterById)
      return <tr key={player.id} className={`${isAlt ? 'stagger-row alt-row' : 'stagger-row'} class-accent-row class-color-${classColorKey(player.className)}`} style={{ '--row-index': index } as CSSProperties}>
        <td><span className="character-cell">{altCount && !hideAlts && keepAltsTogether ? <button type="button" className="alt-toggle" onClick={() => toggle(player.id)} aria-expanded={!collapsed.has(player.id)} aria-label={`${collapsed.has(player.id) ? 'Show' : 'Hide'} alts of ${player.name}`}>{collapsed.has(player.id) ? <ChevronRight size={14} /> : <ChevronDown size={14} />}</button> : isAlt ? <CornerDownRight className="alt-link-icon" size={14} aria-hidden="true" /> : <span className="alt-toggle-spacer" />}<ClassAvatar player={player} /><span className="character-name-stack"><strong title={[player.name, player.surname].filter(Boolean).join(' ')}>{player.name}</strong>{altCount ? <small className="table-subtext">{altCount} {altCount === 1 ? 'alt' : 'alts'}{hideAlts ? ' hidden' : ''}</small> : !isAlt && mainNames.get(player.id) && <small className="table-subtext">Alt of {mainNames.get(player.id)}</small>}</span></span></td>
        {!showComments && <><td><span className={`class-name class-color-${classColorKey(player.className)}`}>{player.className}</span></td>
        <td><span className={`specialization-name class-color-${classColorKey(player.className)}`}>{player.specialization || 'Not set'}</span></td>
        <td><RolePill role={player.role} /></td>
        <td className="team-dot-cell">{assignedTeam ? <span className={`team-dot-indicator team-dot-${assignedTeam.key}`} role="img" aria-label={`${assignedTeam.name} team`} title={`${assignedTeam.name} team`} /> : !mainNames.has(player.id) && <span className="unassigned-label">Unassigned</span>}</td>
        <td>{!owner ? 'Not set' : raiderTypes.loading ? 'Loading...' : raiderTypes.error ? 'Unavailable' : raiderTypeLabel(typesByUid.get(owner))}</td>
        <td><span className={owner ? 'linked-account-status linked' : 'linked-account-status'}>{owner ? 'Linked' : 'No account'}</span></td>
        {readinessControl && <td>{readinessControl(player)}</td>}
        {canEdit && <td><button className="row-action" onClick={() => onEdit(player)} title={`Edit ${player.name}`} aria-label={`Edit ${player.name}`}><Pencil size={15} /></button></td>}</>}
        {showComments && <><RosterCommentCell feed={comments.public} uid={player.linkedUid} audience="Public" name={player.name} />
        {showLeadership && comments.leadership && <RosterCommentCell feed={comments.leadership} uid={player.linkedUid} audience="Leadership" name={player.name} />}</>}
      </tr>
    })}
    {!rows.length && <EmptyRow colSpan={showComments ? 2 + Number(showLeadership) : 7 + Number(!!readinessControl) + Number(canEdit)} title="No members found" detail="Try a different search or add a guild member." />}
  </tbody></table></div>
}
