import { raidArt } from '../../shared/art'
import type { TabDefinition } from '../../shared/tabs/types'
import { RaidHistoryTab } from './RaidHistoryTab'

export const raidHistoryTab = {
  id: 'raid-history',
  label: 'Raid History',
  art: raidArt,
  hint: 'Every raid, newest first: scheduled, in progress, complete or cancelled. Audit Info has the immutable start snapshots of lineups and responses.',
  panelTitle: 'Raid records',
  recordCount: () => null,
  footer: () => <>Starting snapshots show the scheduled plan and responses; they do not confirm attendance.</>,
  Content: RaidHistoryTab,
} as const satisfies TabDefinition
