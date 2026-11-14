import { useSyncExternalStore } from 'react'

// The roster view choice is shared by the toolbar, the table and the footer, which are separate components.
// It lives for the page session only and is not saved anywhere.
let hideAlts = true
const listeners = new Set<() => void>()

export function setHideAlts(next: boolean) {
  hideAlts = next
  listeners.forEach((listener) => listener())
}

export function useHideAlts() {
  return useSyncExternalStore((listener) => { listeners.add(listener); return () => { listeners.delete(listener) } }, () => hideAlts)
}
