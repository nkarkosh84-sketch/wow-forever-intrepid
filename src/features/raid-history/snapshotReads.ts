// The Firestore reads behind Raid History's Audit Info, kept apart from the hook (which adds the caches) and from the app's Firebase setup, so a local check can
// run exactly these reads as a member against the emulators. Every value shown comes from the snapshot itself, never from current roster or sign-up data.
import { collection, doc, getCountFromServer, getDoc, getDocs, query, where, type Firestore } from 'firebase/firestore'
import {
  buildSnapshotEntries,
  readSnapshotAccount,
  readSnapshotCharacter,
  readSnapshotLineup,
  readSnapshotManifest,
  SnapshotDataError,
  visibleSnapshotStatuses,
  type SnapshotAccount,
  type SnapshotCharacter,
  type SnapshotEntry,
  type SnapshotLineup,
  type SnapshotReport,
} from './history.ts'

/**
 * A raid's starting snapshot as list entries (none when it has no snapshot). Reads: one query per raid, as before; then one read per lineup the manifest lists;
 * and, only for a started or failed capture that has a manifest (RAID-015), two counts of the character and account records written so far. A failure notice
 * has no lineups, so it costs the query alone.
 */
export async function readRaidSnapshotEntries(database: Firestore, guildId: string, raidId: string): Promise<SnapshotEntry[]> {
  const snapshots = await getDocs(query(
    collection(database, 'guilds', guildId, 'raids', raidId, 'snapshots'),
    where('status', 'in', [...visibleSnapshotStatuses]),
  ))
  if (snapshots.empty) return []
  if (snapshots.size !== 1 || snapshots.docs[0].id !== 'start') {
    throw new SnapshotDataError(`Raid ${raidId} has unexpected snapshot records.`)
  }
  const manifest = readSnapshotManifest(raidId, snapshots.docs[0].data())
  const snapshotPath = `guilds/${guildId}/raids/${raidId}/snapshots/start`
  const partial = manifest.status !== 'complete'
  const lineups = await Promise.all(manifest.lineupSizes.map(async (size) => {
    const lineup = await getDoc(doc(database, snapshotPath, 'lineups', String(size)))
    if (lineup.exists()) return readSnapshotLineup(size, lineup.data())
    // A started capture may not have written it yet, and a failed one never will: Raid History says so instead of showing empty teams.
    if (partial) return null
    throw new SnapshotDataError(`Published ${size}M lineup is missing from raid ${raidId}.`)
  }))
  const written = lineups.filter((lineup): lineup is SnapshotLineup => lineup !== null)
  const recordCount = partial && manifest.counts ? written.length + await countRecords(database, snapshotPath) : null
  return buildSnapshotEntries(snapshotPath, manifest, written, recordCount)
}

async function countRecords(database: Firestore, snapshotPath: string) {
  const [characters, accounts] = await Promise.all(['characters', 'accounts'].map((name) => getCountFromServer(collection(database, snapshotPath, name))))
  return characters.data().count + accounts.data().count
}

/** One character record of a snapshot, or null when it has not been written. */
export async function readStoredCharacter(database: Firestore, snapshotPath: string, id: string): Promise<SnapshotCharacter | null> {
  const snapshot = await getDoc(doc(database, snapshotPath, 'characters', id))
  return snapshot.exists() ? readSnapshotCharacter(id, snapshot.data()) : null
}

/** A report's invitation and sign-up records. A complete snapshot must have every one; a started or failed one has what was written. */
export async function readReportAccounts(database: Firestore, report: SnapshotReport): Promise<SnapshotAccount[]> {
  const accounts = await getDocs(collection(database, report.snapshotPath, 'accounts'))
  if (report.progress.status === 'complete' && accounts.size !== report.expectedAccountCount) {
    throw new SnapshotDataError('The published snapshot invitation/sign-up records are incomplete.')
  }
  return accounts.docs.map((entry) => readSnapshotAccount(entry.id, entry.data()))
}

/** The characters that were read, by id, for the roster and response builders. */
export function characterMap(characters: (SnapshotCharacter | null)[]) {
  return new Map(characters.filter((character): character is SnapshotCharacter => character !== null).map((character) => [character.id, character]))
}
