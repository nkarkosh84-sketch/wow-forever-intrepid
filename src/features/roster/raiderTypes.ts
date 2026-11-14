import type { RaiderType } from '../../guildApi'

export type RosterRaiderType = { id: string; type: RaiderType }

export function normalizeRosterRaiderType(id: string, data: Record<string, unknown>): RosterRaiderType | null {
  return data.userId === id && (data.type === 'casual' || data.type === 'hardcore') ? { id, type: data.type } : null
}

export function raiderTypeLabel(type: RaiderType | undefined): string {
  return type === 'casual' ? 'Casual' : type === 'hardcore' ? 'Raider' : 'Not set'
}
