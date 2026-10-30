import assert from 'node:assert/strict'
import { beforeEach, describe, test } from 'node:test'
import {
  collection, deleteDoc, deleteField, getCountFromServer, getDoc, getDocs, query, setDoc, updateDoc, where, type Firestore,
} from 'firebase/firestore'
import { ANY_ROLE, GUILD_ID, LABEL, UID, type Persona } from './support/fixtures.ts'
import { asAdmin, dbFor, expectAllowed, expectDenied, guildDoc, setUpGuildEmulator } from './support/harness.ts'

setUpGuildEmulator()

const manifestPath = 'raids/planned/snapshots/start'
const childPaths = [
  `${manifestPath}/lineups/10`,
  `${manifestPath}/characters/player-1`,
  `${manifestPath}/accounts/${UID.member}`,
]
// RAID-015: the statuses a member may read. A capture writes `capturing` first, then `complete`, or `failed` on a terminal failure.
const STATUSES = ['capturing', 'complete', 'failed'] as const
const OUTSIDERS: readonly Persona[] = ['anonymous', 'stranger', 'otherGuildLeader']

const snapshots = (db: Firestore) => collection(db, 'guilds', GUILD_ID, 'raids', 'planned', 'snapshots')
/** The query Raid History runs (RAID-015). */
const visibleSnapshots = (db: Firestore) => query(snapshots(db), where('status', 'in', [...STATUSES]))
/** The query the app ran before RAID-015; a tab opened before the deploy still runs it. */
const completeSnapshots = (db: Firestore) => query(snapshots(db), where('status', '==', 'complete'))

beforeEach(() => asAdmin(async (db) => {
  await setDoc(guildDoc(db, manifestPath), {
    schemaVersion: 1, status: 'complete', raidId: 'planned',
    scheduledStartAt: new Date('2026-10-20T00:00:00Z'),
  })
  await setDoc(guildDoc(db, `${manifestPath}/lineups/10`), { size: 10, teams: [], bench: [] })
  await setDoc(guildDoc(db, `${manifestPath}/characters/player-1`), { id: 'player-1', name: 'Invented Raider' })
  await setDoc(guildDoc(db, `${manifestPath}/accounts/${UID.member}`), { uid: UID.member, displayName: 'Invented Member' })
}))

const setStatus = (status: string) => asAdmin((db) => updateDoc(guildDoc(db, manifestPath), { status }))

async function expectNoClientWrites(db: Firestore) {
  const manifest = guildDoc(db, manifestPath)
  await expectDenied(setDoc(guildDoc(db, 'raids/planned/snapshots/forged'), { status: 'complete' }), 'creating a snapshot')
  await expectDenied(updateDoc(manifest, { status: 'complete' }), 'publishing a snapshot')
  await expectDenied(updateDoc(manifest, { status: 'failed' }), 'failing a snapshot')
  await expectDenied(deleteDoc(manifest), 'deleting a snapshot')
  await expectDenied(setDoc(guildDoc(db, `${manifestPath}/characters/forged`), { name: 'Forged Raider' }), 'adding a character record')
  await expectDenied(updateDoc(guildDoc(db, `${manifestPath}/accounts/${UID.member}`), { displayName: 'Changed' }), 'changing an account record')
  await expectDenied(deleteDoc(guildDoc(db, `${manifestPath}/lineups/10`)), 'deleting a lineup record')
}

describe('immutable scheduled raid start snapshots', () => {
  for (const status of STATUSES) {
    for (const who of ANY_ROLE) {
      test(`a ${LABEL[who]} can read a ${status} snapshot and its records, and cannot write them`, async () => {
        await setStatus(status)
        const db = dbFor(who)
        await expectAllowed(getDoc(guildDoc(db, manifestPath)), 'reading the manifest')
        await expectAllowed(getDocs(visibleSnapshots(db)), 'listing snapshots by status')
        for (const path of childPaths) await expectAllowed(getDoc(guildDoc(db, path)), `reading ${path}`)
        await expectAllowed(getDocs(collection(db, 'guilds', GUILD_ID, `${manifestPath}/accounts`)), 'listing the account records')
        // Raid History counts what a started or failed capture has written so far.
        await expectAllowed(getCountFromServer(collection(db, 'guilds', GUILD_ID, `${manifestPath}/characters`)), 'counting the character records')
        await expectAllowed(getCountFromServer(collection(db, 'guilds', GUILD_ID, `${manifestPath}/accounts`)), 'counting the account records')
        await expectNoClientWrites(db)
      })
    }

    test(`outsiders and removed members cannot read a ${status} snapshot or its records`, async () => {
      await setStatus(status)
      for (const who of OUTSIDERS) {
        const db = dbFor(who)
        await expectDenied(getDoc(guildDoc(db, manifestPath)), `${LABEL[who]} reading the manifest`)
        await expectDenied(getDocs(visibleSnapshots(db)), `${LABEL[who]} listing snapshots`)
        for (const path of childPaths) await expectDenied(getDoc(guildDoc(db, path)), `${LABEL[who]} reading ${path}`)
        await expectDenied(getCountFromServer(collection(db, 'guilds', GUILD_ID, `${manifestPath}/characters`)), `${LABEL[who]} counting records`)
        await expectNoClientWrites(db)
      }
      await asAdmin((db) => updateDoc(guildDoc(db, `members/${UID.member}`), { role: 'Removed' }))
      const removed = dbFor('member')
      await expectDenied(getDoc(guildDoc(removed, manifestPath)), 'a removed member reading the manifest')
      await expectDenied(getDocs(visibleSnapshots(removed)), 'a removed member listing snapshots')
      for (const path of childPaths) await expectDenied(getDoc(guildDoc(removed, path)), `a removed member reading ${path}`)
    })
  }

  test('a tab opened before RAID-015 can still list complete snapshots, and sees no others', async () => {
    for (const who of ANY_ROLE) assert.equal((await getDocs(completeSnapshots(dbFor(who)))).size, 1)
    await setStatus('capturing')
    for (const who of ANY_ROLE) assert.equal((await getDocs(completeSnapshots(dbFor(who)))).size, 0)
  })

  test('a list that does not ask for the readable statuses is refused', async () => {
    for (const who of ANY_ROLE) {
      await expectDenied(getDocs(snapshots(dbFor(who))), `${LABEL[who]} listing snapshots with no status filter`)
      await expectDenied(getDocs(query(snapshots(dbFor(who)), where('status', 'in', ['capturing', 'draft']))), `${LABEL[who]} listing an unknown status`)
    }
  })

  test('a manifest with any other status, or none, is hidden with its records', async () => {
    for (const status of ['draft', 'published', '']) {
      await setStatus(status)
      for (const who of ANY_ROLE) {
        await expectDenied(getDoc(guildDoc(dbFor(who), manifestPath)), `${LABEL[who]} reading a "${status}" manifest`)
        for (const path of childPaths) await expectDenied(getDoc(guildDoc(dbFor(who), path)), `${LABEL[who]} reading ${path} under "${status}"`)
      }
    }
    await asAdmin((db) => updateDoc(guildDoc(db, manifestPath), { status: deleteField() }))
    for (const who of ANY_ROLE) await expectDenied(getDoc(guildDoc(dbFor(who), manifestPath)), `${LABEL[who]} reading a manifest with no status`)
  })

  test('records without a manifest are not readable', async () => {
    await asAdmin((db) => deleteDoc(guildDoc(db, manifestPath)))
    for (const who of ANY_ROLE) {
      for (const path of childPaths) await expectDenied(getDoc(guildDoc(dbFor(who), path)), `${LABEL[who]} reading orphaned ${path}`)
    }
  })

  test('the small failed record of a capture that failed before writing anything is readable by members only', async () => {
    const noticePath = 'raids/raid-1/snapshots/start'
    await asAdmin((db) => setDoc(guildDoc(db, noticePath), {
      schemaVersion: 1, status: 'failed', failureNotice: true, raidId: 'raid-1',
      raid: { id: 'raid-1', name: 'Test Raid', date: '2026-12-09' },
      scheduledStartAt: new Date('2026-12-10T02:00:00Z'), failureCode: 'missing-working-roster', failedAt: new Date('2026-12-10T02:05:00Z'),
    }))
    const notices = (db: Firestore) => query(collection(db, 'guilds', GUILD_ID, 'raids', 'raid-1', 'snapshots'), where('status', 'in', [...STATUSES]))
    for (const who of ANY_ROLE) {
      await expectAllowed(getDoc(guildDoc(dbFor(who), noticePath)), `${LABEL[who]} reading the failed record`)
      await expectAllowed(getDocs(notices(dbFor(who))), `${LABEL[who]} listing it`)
      await expectDenied(updateDoc(guildDoc(dbFor(who), noticePath), { status: 'capturing' }), `${LABEL[who]} changing it`)
      await expectDenied(deleteDoc(guildDoc(dbFor(who), noticePath)), `${LABEL[who]} deleting it`)
    }
    for (const who of OUTSIDERS) {
      await expectDenied(getDoc(guildDoc(dbFor(who), noticePath)), `${LABEL[who]} reading the failed record`)
      await expectDenied(getDocs(notices(dbFor(who))), `${LABEL[who]} listing it`)
    }
  })

  test('server-side capture failure records are not exposed through client rules', async () => {
    await asAdmin((db) => setDoc(guildDoc(db, 'raidSnapshotFailures/failure-record'), {
      raidId: 'planned', code: 'missing-working-roster', message: 'Internal diagnostic',
    }))
    for (const who of [...ANY_ROLE, ...OUTSIDERS]) await expectDenied(getDoc(guildDoc(dbFor(who), 'raidSnapshotFailures/failure-record')))
  })
})
