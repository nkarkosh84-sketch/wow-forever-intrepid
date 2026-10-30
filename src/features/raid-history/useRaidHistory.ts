import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { db, guildId } from '../../firebase'
import type { RaidRecord } from '../../guildApi'
import {
  buildSnapshotInvitationRows,
  buildSnapshotReportRoster,
  sortSnapshotEntries,
  SnapshotDataError,
  type SnapshotCharacter,
  type SnapshotEntry,
  type SnapshotInvitationRow,
  type SnapshotReport,
  type SnapshotReportRoster,
} from './history'
import { characterMap, readRaidSnapshotEntries, readReportAccounts, readStoredCharacter } from './snapshotReads'

type RaidMetadata = { entries: SnapshotEntry[] } | { entries: []; error: string }
type HistoryState = { entries: SnapshotEntry[]; errors: string[]; raidIdsKey: string; refreshVersion: number }

function firestoreErrorMessage(error: unknown, fallback: string) {
  const code = error && typeof error === 'object' && 'code' in error ? error.code : undefined
  if (code === 'permission-denied') return 'You do not have permission to read this published raid history.'
  if (error instanceof SnapshotDataError) return error.message
  return fallback
}

function requireFirestore() {
  if (!db || !guildId) throw new Error('Guild Firestore is not configured.')
  return db
}

async function raidMetadata(raidId: string): Promise<RaidMetadata> {
  return { entries: await readRaidSnapshotEntries(requireFirestore(), guildId, raidId) }
}

export function useRaidHistory(raids: RaidRecord[], raidsLoaded: boolean) {
  const [state, setState] = useState<HistoryState>({ entries: [], errors: [], raidIdsKey: '', refreshVersion: -1 })
  const [refreshVersion, setRefreshVersion] = useState(0)
  const metadataCache = useRef(new Map<string, RaidMetadata>())
  const characterCache = useRef(new Map<string, Promise<SnapshotCharacter | null>>())
  const rosterCache = useRef(new Map<string, Promise<SnapshotReportRoster>>())
  const invitationCache = useRef(new Map<string, Promise<SnapshotInvitationRow[]>>())
  const raidIds = useMemo(() => [...new Set(raids.map(({ id }) => id))].sort(), [raids])
  const raidIdsKey = raidIds.join('\u0000')

  useEffect(() => {
    if (!raidsLoaded) return
    let cancelled = false
    const ids = raidIdsKey ? raidIdsKey.split('\u0000') : []
    const discover = async () => {
      const missing = ids.filter((id) => !metadataCache.current.has(id))
      for (let index = 0; index < missing.length; index += 8) {
        await Promise.all(missing.slice(index, index + 8).map(async (raidId) => {
          try {
            metadataCache.current.set(raidId, await raidMetadata(raidId))
          } catch (error) {
            metadataCache.current.set(raidId, {
              entries: [],
              error: firestoreErrorMessage(error, `Could not load the published snapshot for raid ${raidId}.`),
            })
          }
        }))
      }
      if (cancelled) return
      const cached = ids.map((id) => metadataCache.current.get(id)).filter((entry): entry is RaidMetadata => Boolean(entry))
      setState({
        entries: sortSnapshotEntries(cached.flatMap((entry) => entry.entries)),
        errors: cached.flatMap((entry) => 'error' in entry ? [entry.error] : []),
        raidIdsKey,
        refreshVersion,
      })
    }
    void discover()
    return () => { cancelled = true }
  }, [raidIdsKey, raidsLoaded, refreshVersion])

  // A record that was read never changes (the capture only creates them), so it is kept. One a started capture has not written yet is read again next time, and a
  // complete snapshot must have every one (RAID-015).
  const loadCharacters = useCallback(async (snapshotPath: string, ids: string[], partial: boolean) => {
    const database = requireFirestore()
    return Promise.all([...new Set(ids)].map(async (id) => {
      const key = `${snapshotPath}/characters/${id}`
      let pending = characterCache.current.get(key)
      if (!pending) {
        pending = readStoredCharacter(database, snapshotPath, id).then((character) => {
          if (!character) characterCache.current.delete(key)
          return character
        }).catch((error) => {
          characterCache.current.delete(key)
          throw error
        })
        characterCache.current.set(key, pending)
      }
      const character = await pending
      if (!character && !partial) throw new SnapshotDataError(`Snapshot character ${id} is missing.`)
      return character
    }))
  }, [])

  // The roster and responses of a complete snapshot are kept; those of a started or failed one are worked out again each time, from the cached records.
  const loadReport = useCallback((report: SnapshotReport) => {
    const complete = report.progress.status === 'complete'
    const cached = complete ? rosterCache.current.get(report.id) : undefined
    if (cached) return cached
    const pending = loadCharacters(report.snapshotPath, [...report.characterIds, ...report.benchIds], !complete)
      .then((characters) => buildSnapshotReportRoster(report, characterMap(characters)))
      .catch((error) => {
        rosterCache.current.delete(report.id)
        throw error
      })
    if (complete) rosterCache.current.set(report.id, pending)
    return pending
  }, [loadCharacters])

  const loadInvitations = useCallback((report: SnapshotReport) => {
    const complete = report.progress.status === 'complete'
    const cached = complete ? invitationCache.current.get(report.snapshotPath) : undefined
    if (cached) return cached
    const pending = (async () => {
      const accounts = await readReportAccounts(requireFirestore(), report)
      const characters = await loadCharacters(report.snapshotPath, accounts.flatMap((account) => [
        ...(account.invitationMainId ? [account.invitationMainId] : []),
        ...(account.signup ? [account.signup.characterId] : []),
      ]), !complete)
      return buildSnapshotInvitationRows(accounts, characterMap(characters), !complete)
    })().catch((error) => {
      invitationCache.current.delete(report.snapshotPath)
      throw error
    })
    if (complete) invitationCache.current.set(report.snapshotPath, pending)
    return pending
  }, [loadCharacters])

  const refresh = useCallback(() => {
    metadataCache.current.clear()
    setRefreshVersion((current) => current + 1)
  }, [])

  const isCurrent = state.raidIdsKey === raidIdsKey && state.refreshVersion === refreshVersion
  return {
    entries: isCurrent ? state.entries : [],
    errors: isCurrent ? state.errors : [],
    loading: raidsLoaded && !isCurrent,
    loadReport,
    loadInvitations,
    refresh,
  }
}
