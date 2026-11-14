import { namedTeams } from '../../shared/game/teams'
import type { TabContext } from '../../shared/tabs/types'
import { useHideAlts } from './altVisibility'
import { filterRoster } from './filter'
import { PlayerModal } from './PlayerModal'
import { sortRoster } from './sort'
import { useSortChoice } from './sortChoice'
import { RosterTable } from './RosterTable'
import './Roster.css'
import { RaidReadinessControl } from '../../shared/members/RaidReadinessControl'
import { useRosterRaiderTypes } from './useRosterRaiderTypes'
import { raiderTypeLabel } from './raiderTypes'
import { rosterAccountUid } from './account'

export function RosterTab({ ctx }: { ctx: TabContext }) {
  const { roster, assignments } = ctx.data
  const hideAlts = useHideAlts()
  const sort = useSortChoice()
  const teams = namedTeams(ctx.data.settings.teamNames)
  const raiderTypes = useRosterRaiderTypes(ctx.identity.uid)
  const rosterById = new Map(roster.map((player) => [player.id, player]))
  const typesByUid = new Map(raiderTypes.records.map((record) => [record.id, record.type]))
  const publicComments = new Map(ctx.data.comments.public.records.map((record) => [record.id, record.text]))
  const leadershipComments = new Map(ctx.data.comments.leadership?.records.map((record) => [record.id, record.text]) ?? [])
  const sortUnavailable = (sort.key === 'raiderType' && (raiderTypes.loading || !!raiderTypes.error))
    || (sort.key === 'publicComment' && (ctx.data.comments.public.loading || !!ctx.data.comments.public.error))
    || (sort.key === 'leadershipComment' && (!ctx.identity.canEditRaidData || !ctx.data.comments.leadership || ctx.data.comments.leadership.loading || !!ctx.data.comments.leadership.error))
  const players = sortRoster(filterRoster(roster, ctx.query, hideAlts), sortUnavailable ? 'default' : sort.key, sort.direction, (playerId) => assignments[playerId], teams.map((team) => team.key), (player, key) => {
    if (key === 'name') return player.name
    if (key === 'class') return player.className
    if (key === 'specialization') return player.specialization || undefined
    if (key === 'role') return player.role
    if (key === 'team') return teams.find((team) => team.key === assignments[player.id])?.name
    if (key === 'raiderType') {
      const owner = rosterAccountUid(player, rosterById)
      const type = owner ? typesByUid.get(owner) : undefined
      return type ? raiderTypeLabel(type) : undefined
    }
    if (key === 'access') return rosterAccountUid(player, rosterById) ? 'Linked' : 'No account'
    if (key === 'publicComment') return player.linkedUid ? publicComments.get(player.linkedUid) : undefined
    if (key === 'leadershipComment') return player.linkedUid ? leadershipComments.get(player.linkedUid) : undefined
    return undefined
  })
  return <>{ctx.data.readinessError && <p role="alert">{ctx.data.readinessError}</p>}{raiderTypes.error && <p role="alert">{raiderTypes.error}</p>}<RosterTable raiderTypes={raiderTypes} sortUnavailable={sortUnavailable} readinessControl={ctx.identity.canEditRoster ? (player) => <RaidReadinessControl characterId={player.id} name={player.name} ctx={ctx} compact /> : undefined} teams={teams} players={players} allPlayers={roster} hideAlts={hideAlts} keepAltsTogether assignments={assignments} canEdit={ctx.identity.canEditRoster} comments={ctx.data.comments} showLeadership={ctx.identity.canEditRaidData && ctx.data.comments.leadership !== null} onEdit={(player) => ctx.openModal(({ close, live }) => <PlayerModal existing={player} close={close} live={live} />)} /></>
}
