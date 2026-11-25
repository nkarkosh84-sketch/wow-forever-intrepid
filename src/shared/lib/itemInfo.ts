import { useEffect, useSyncExternalStore } from 'react'
import { itemLookupErrorOf, itemLookupErrors, itemTooltipUrl, parseItemTooltip, type ItemInfo, type ItemLookupError, type ItemLookupReason } from '../game/itemTooltip'

// Item names, icons and tooltips are read live from Wowhead's public tooltip endpoint by item id, once per id per page session, and
// kept in memory only. A few requests run at a time, so a long list does not open dozens of connections at once. Manual entry never
// depends on this: a failed lookup leaves the id (and any name a person typed) in place. A failure says why (`reason`, see ItemLookupReason): only
// 'missing' means Wowhead has no such item; when Wowhead could not be reached or was busy the item may well exist.
export type ItemState = { status: 'loading' } | { status: 'ready'; info: ItemInfo } | { status: 'error'; reason: ItemLookupReason; message: string }
type ItemFailure = Extract<ItemState, { status: 'error' }>
const failed = (error: ItemLookupError): ItemFailure => ({ status: 'error', ...error })

const states = new Map<number, ItemState>()
const listeners = new Set<() => void>()
let version = 0
const publish = (id: number, state: ItemState) => { states.set(id, state); version++; listeners.forEach((listener) => listener()) }
const subscribe = (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener) } }

const queue: number[] = []
let running = 0
const maxRunning = 4
const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

async function load(id: number) {
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const response = await fetch(itemTooltipUrl(id), { signal: AbortSignal.timeout(10000) })
      if (response.ok) {
        // An item answer is a few kilobytes. Refuse a much larger one before reading it.
        if (Number(response.headers.get('content-length')) > 300000) return publish(id, failed(itemLookupErrors.tooLarge))
        const info = parseItemTooltip(await response.json())
        return publish(id, info ? { status: 'ready', info } : failed(itemLookupErrors.missing))
      }
      // No such item, or refused: final. Busy: asked once more.
      const error = itemLookupErrorOf(response.status)
      if (error.reason !== 'busy') return publish(id, failed(error))
    } catch {
      if (attempt === 1) return publish(id, failed(itemLookupErrors.unreachable))
    }
    await wait(1000)
  }
  publish(id, failed(itemLookupErrors.busy))
}

function pump() {
  while (running < maxRunning && queue.length) {
    const id = queue.shift() as number
    running++
    load(id).finally(() => { running--; pump() })
  }
}

// Starts the lookup for an id unless it is already loaded, loading or failed.
export function requestItem(id: number) {
  if (states.has(id) || !Number.isInteger(id) || id <= 0) return
  publish(id, { status: 'loading' })
  queue.push(id)
  pump()
}

// Looks up a failed id again.
export function retryItem(id: number) {
  if (states.get(id)?.status !== 'error') return
  states.delete(id)
  requestItem(id)
}

// What is known about an id right now, without starting a lookup.
export const peekItem = (id: number) => states.get(id)

// Whether Wowhead answered that it has no item with this id. Not when it could not be reached, was busy or sent an error: the item may exist then.
export const isMissingItem = (state: ItemState | undefined): state is ItemFailure & { reason: 'missing' } => state?.status === 'error' && state.reason === 'missing'

// The state of one item, looked up when first used. undefined only before the first effect has run.
export function useItemInfo(id: number) {
  useEffect(() => { requestItem(id) }, [id])
  return useSyncExternalStore(subscribe, () => states.get(id))
}

// A number that changes whenever any item's state changes, for a list that filters or sorts by item name.
export function useItemInfoVersion() {
  return useSyncExternalStore(subscribe, () => version)
}
