// The two tabs inside an opened Scheduled Raids row (RAID-018). Pure, so Node tests it.

export const raidRowTabs = ['signups', 'groups'] as const
export type RaidRowTab = typeof raidRowTabs[number]
export const raidRowTabLabels: Record<RaidRowTab, string> = { signups: 'Signups', groups: 'Groups' }

/** The tab a row opens on: Groups for a Guild or Raid Leader, who place people there, and Signups for everyone else. */
export const defaultRaidRowTab = (canEditRaidData: boolean): RaidRowTab => canEditRaidData ? 'groups' : 'signups'

/**
 * The tab a key moves to in a horizontal tablist (the ARIA tabs pattern): the arrows move to the next or previous tab and wrap, Home and End go to the first and the last.
 * Any other key moves nothing.
 */
export function tabForKey<T>(tabs: readonly T[], current: T, key: string): T | undefined {
  const index = Math.max(tabs.indexOf(current), 0)
  if (key === 'ArrowRight') return tabs[(index + 1) % tabs.length]
  if (key === 'ArrowLeft') return tabs[(index - 1 + tabs.length) % tabs.length]
  if (key === 'Home') return tabs[0]
  if (key === 'End') return tabs[tabs.length - 1]
  return undefined
}
