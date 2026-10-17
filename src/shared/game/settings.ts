import type { CouncilStatus, GuildSettings, StatusTone } from '../../guildApi'
import { isPhaseRev, readPhaseHistory } from './phases.ts'

export const SETTINGS_LABEL_MAX = 40

export const statusTones: { value: StatusTone; label: string }[] = [
  { value: 'active', label: 'Active' },
  { value: 'preparing', label: 'Preparing' },
  { value: 'paused', label: 'Paused' },
]

export const councilStatuses: { value: CouncilStatus; label: string; hint: string }[] = [
  { value: 'deliberating', label: 'Deliberating', hint: 'Priorities are still being discussed.' },
  { value: 'live', label: 'Live', hint: 'Priorities are set and being acted on.' },
]

// What the app shows until a Guild Leader saves settings, and for any field that cannot be read.
// The rules (validPhaseHistory) name currentPhase's default as the one phase a first save of the settings may close, so keep the two together.
export const defaultGuildSettings: GuildSettings = {
  currentPhase: 'Launch prep',
  nextPhase: 'To be announced',
  currentStatusLabel: 'Preparing',
  currentStatusTone: 'preparing',
  nextStatusLabel: 'Not started',
  nextStatusTone: 'paused',
  councilStatus: 'deliberating',
  teamNames: { blue: 'Blue', yellow: 'Yellow', red: 'Red', white: 'White' },
  groupNames: { green: 'Green', pink: 'Pink', brown: 'Brown' },
}

const label = (value: unknown, fallback: string) => (typeof value === 'string' && value.trim() ? value.slice(0, SETTINGS_LABEL_MAX) : fallback)

/** Reads a settings document tolerantly: every missing or invalid field falls back to its default. Never throws. */
export function resolveGuildSettings(data: Record<string, unknown> | null | undefined): GuildSettings {
  const defaults = defaultGuildSettings
  const source = data ?? {}
  const groups = source.groupNames && typeof source.groupNames === 'object' ? (source.groupNames as Record<string, unknown>) : {}
  const names = source.teamNames && typeof source.teamNames === 'object' ? (source.teamNames as Record<string, unknown>) : {}
  const history = readPhaseHistory(source.phaseHistory, label)
  return {
    currentPhase: label(source.currentPhase, defaults.currentPhase),
    nextPhase: label(source.nextPhase, defaults.nextPhase),
    currentStatusLabel: label(source.currentStatusLabel, defaults.currentStatusLabel),
    currentStatusTone: statusTones.some((tone) => tone.value === source.currentStatusTone) ? (source.currentStatusTone as StatusTone) : defaults.currentStatusTone,
    nextStatusLabel: label(source.nextStatusLabel, defaults.nextStatusLabel),
    nextStatusTone: statusTones.some((tone) => tone.value === source.nextStatusTone) ? (source.nextStatusTone as StatusTone) : defaults.nextStatusTone,
    councilStatus: councilStatuses.some((status) => status.value === source.councilStatus) ? (source.councilStatus as CouncilStatus) : defaults.councilStatus,
    teamNames: {
      blue: label(names.blue, defaults.teamNames.blue),
      yellow: label(names.yellow, defaults.teamNames.yellow),
      red: label(names.red, defaults.teamNames.red),
      white: label(names.white, defaults.teamNames.white),
    },
    groupNames: {
      green: label(groups.green, defaults.groupNames.green),
      pink: label(groups.pink, defaults.groupNames.pink),
      brown: label(groups.brown, defaults.groupNames.brown),
    },
    ...(history ? { phaseHistory: history } : {}),
    ...(isPhaseRev(source.phaseRev) ? { phaseRev: source.phaseRev } : {}),
  }
}
