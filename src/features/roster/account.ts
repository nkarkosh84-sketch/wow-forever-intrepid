import type { PlayerRecord } from '../../shared/game/players'

export function rosterAccountUid(player: PlayerRecord, rosterById: ReadonlyMap<string, PlayerRecord>): string | undefined {
  if (!player.mainId) return player.linkedUid
  const main = rosterById.get(player.mainId)
  return main && main.id !== player.id && !main.mainId ? main.linkedUid : undefined
}
