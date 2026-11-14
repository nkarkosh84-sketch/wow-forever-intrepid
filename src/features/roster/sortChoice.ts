import { useSyncExternalStore } from 'react'
import type { SortDirection, SortKey } from './sort'

type Choice = { key: SortKey; direction: SortDirection }
let choice: Choice = { key: 'name', direction: 'asc' }
const listeners = new Set<() => void>()
const publish = (next: Choice) => { choice = next; listeners.forEach((listener) => listener()) }

export const toggleSort = (key: Exclude<SortKey, 'default'>) => publish({ key, direction: choice.key === key && choice.direction === 'asc' ? 'desc' : 'asc' })
export const resetSort = () => publish({ key: 'name', direction: 'asc' })

export function useSortChoice() {
  return useSyncExternalStore((listener) => { listeners.add(listener); return () => { listeners.delete(listener) } }, () => choice)
}
