// Editing, cancelling, restoring and marking complete a raid (match /raids/{raidId}: update). Every change is one batch: the
// raid update plus its audit entry (auditLog/raid_{id}_{rev}), like an award edit. A cancelled raid stays on
// the calendar with status 'cancelled' and a reason. Guild Leaders and Raid Leaders may do it; nobody else.
import assert from 'node:assert/strict'
import { describe, test } from 'node:test'
import { deleteField, FieldValue, serverTimestamp, setDoc, Timestamp, writeBatch, type DocumentData } from 'firebase/firestore'
import { UID, displayNameOf, raidDoc } from './support/fixtures.ts'
import { asAdmin, dbFor, expectAllowed, expectDenied, guildDoc, stored, setUpGuildEmulator } from './support/harness.ts'

setUpGuildEmulator()

const RAID = 'raid-1' // seeded by the fixtures without rev or status, like every raid scheduled before this change
type Who = 'raidLeader' | 'guildLeader' | 'member'

const clean = (data: DocumentData): DocumentData => Object.fromEntries(Object.entries(data).filter(([, value]) => value !== undefined))

type Change = {
  who?: Who
  changes?: DocumentData // what the raid update sets
  stamp?: DocumentData // overrides for rev, updatedBy, updatedAt
  action?: string
  entry?: DocumentData // overrides for the audit entry
  entryRev?: number // the rev in the entry id and entry body
  skipEntry?: boolean
  skipRaid?: boolean
  raid?: string
}

/** One batch: the raid update plus an honest entry for it. Either part can be altered or left out. */
async function changeRaid({ who = 'raidLeader', changes = { name: 'Renamed Raid' }, stamp = {}, action = 'edit', entry = {}, entryRev, skipEntry = false, skipRaid = false, raid = RAID }: Change = {}) {
  const db = dbFor(who)
  const current = await stored(`raids/${raid}`)
  const rev = (current?.rev ?? 0) + 1
  const logged = entryRev ?? rev
  const keys = Object.keys(changes)
  const after = Object.fromEntries(keys.map((key) => [key, changes[key] instanceof FieldValue ? null : changes[key]]))
  const batch = writeBatch(db)
  if (!skipRaid) batch.update(guildDoc(db, `raids/${raid}`), clean({ ...changes, rev, updatedBy: UID[who], updatedAt: serverTimestamp(), ...stamp }))
  if (!skipEntry) {
    batch.set(guildDoc(db, `auditLog/raid_${raid}_${logged}`), clean({
      at: serverTimestamp(), by: UID[who], byName: displayNameOf(UID[who]), targetType: 'raid', targetId: raid, rev: logged, action, item: current?.name,
      changed: keys, before: Object.fromEntries(keys.map((key) => [key, current?.[key] ?? null])), after,
      ...(action === 'cancel' ? { reason: changes.cancelReason } : {}),
      ...entry,
    }))
  }
  return batch.commit()
}

const cancelled = (overrides: DocumentData = {}) => raidDoc(UID.raidLeader, { rev: 1, status: 'cancelled', cancelReason: 'Tank unavailable', updatedBy: UID.raidLeader, updatedAt: new Date('2026-12-01T00:00:00Z'), ...overrides })
const seed = (data: DocumentData) => asAdmin((db) => setDoc(guildDoc(db, `raids/${RAID}`), data))
const tenZones = () => Array.from({ length: 10 }, (_, index) => ({ id: `zone-${index}`, name: `Test Zone ${index}`, size: [10, 20, 40][index % 3] }))

describe('editing a raid', () => {
  for (const who of ['raidLeader', 'guildLeader'] as const) {
    test(`a ${who} can correct the name, date and size, and the entry records it`, async () => {
      await expectAllowed(changeRaid({ who, changes: { name: 'Fixed Name', date: '2026-12-11', size: 40 } }))
      const raid = await stored(`raids/${RAID}`)
      assert.equal(raid?.name, 'Fixed Name')
      assert.equal(raid?.date, '2026-12-11')
      assert.equal(raid?.size, 40)
      assert.equal(raid?.rev, 1)
      assert.equal(raid?.createdBy, UID.raidLeader)
      const entry = await stored(`auditLog/raid_${RAID}_1`)
      assert.equal(entry?.item, 'Test Raid')
      assert.deepEqual(entry?.changed, ['name', 'date', 'size'])
    })
  }

  test('a second edit uses the next revision', async () => {
    await expectAllowed(changeRaid())
    await expectAllowed(changeRaid({ changes: { size: 10 } }))
    assert.equal((await stored(`raids/${RAID}`))?.rev, 2)
    assert.equal((await stored(`auditLog/raid_${RAID}_2`))?.item, 'Renamed Raid')
  })

  test('a zone selection is saved with its exact audit snapshot', async () => {
    const zones = [{ id: 'barrow-deeps', name: 'Barrow Deeps', size: 10 }, { id: 'hyjal-summit', name: 'Hyjal Summit', size: 20 }]
    await expectAllowed(changeRaid({ changes: { zones } }))
    assert.deepEqual((await stored(`raids/${RAID}`))?.zones, zones)
    assert.deepEqual((await stored(`auditLog/raid_${RAID}_1`))?.after, { zones })
  })

  test('a legacy raid gets an audited start instant', async () => {
    const startsAt = Timestamp.fromDate(new Date('2026-12-10T02:00:00Z'))
    await expectAllowed(changeRaid({ changes: { startsAt } }))
    assert.ok((await stored(`raids/${RAID}`))?.startsAt.isEqual(startsAt))
    assert.deepEqual((await stored(`auditLog/raid_${RAID}_1`))?.before, { startsAt: null })
    assert.ok((await stored(`auditLog/raid_${RAID}_1`))?.after.startsAt.isEqual(startsAt))
  })

  test('unchanged zones must not be reported as changed when initializing a raid', async () => {
    const zones = [{ id: 'test-summit', name: 'Test Summit', size: 20 }, { id: 'test-lair', name: 'Test Lair', size: 40 }]
    await seed(raidDoc(UID.raidLeader, { size: 40, zones }))
    const startsAt = Timestamp.fromDate(new Date('2026-12-10T02:00:00Z'))
    await expectDenied(changeRaid({ changes: { zones: zones.map(({ id, name, size }) => ({ size, name, id })), startsAt } }))
    await expectAllowed(changeRaid({ changes: { startsAt } }))
    assert.deepEqual((await stored(`auditLog/raid_${RAID}_1`))?.changed, ['startsAt'])
  })

  for (const count of [2, 10]) {
    test(`initializing a legacy raid with ${count} selected zones preserves its snapshots`, async () => {
      const zones = Array.from({ length: count }, (_, index) => ({ id: `zone-${index}`, name: `Test Zone ${index}`, size: index % 2 ? 40 : 20 }))
      await seed(raidDoc(UID.raidLeader, { size: 40, zones }))
      const startsAt = Timestamp.fromDate(new Date('2026-12-10T02:00:00Z'))
      await expectAllowed(changeRaid({ changes: { startsAt } }))
      assert.deepEqual((await stored(`raids/${RAID}`))?.zones, zones)
    })
    test(`saving a legacy raid with ${count} reordered zone snapshots and a start instant succeeds`, async () => {
      const zones = Array.from({ length: count }, (_, index) => ({ id: `zone-${index}`, name: `Test Zone ${index}`, size: index % 2 ? 40 : 20 }))
      await seed(raidDoc(UID.raidLeader, { size: 40, zones }))
      const startsAt = Timestamp.fromDate(new Date('2026-12-10T02:00:00Z'))
      await expectAllowed(changeRaid({ changes: { zones: [...zones].reverse(), startsAt } }))
    })
  }

  test('rescheduling preserves the server cutoff and its audit truth', async () => {
    const startsAt = Timestamp.fromDate(new Date('2026-12-10T02:00:00Z'))
    await seed(raidDoc(UID.raidLeader, { startsAt }))
    await expectDenied(changeRaid({ changes: { date: '2026-12-11' } }))
    await expectDenied(changeRaid({ changes: { startsAt: deleteField() } }))
    await expectDenied(changeRaid({ changes: { startsAt: 'not-a-timestamp' } }))
    const next = Timestamp.fromDate(new Date('2026-12-12T02:00:00Z'))
    await expectDenied(changeRaid({ changes: { date: '2026-12-11', startsAt: next }, entry: { after: { date: '2026-12-11', startsAt } } }))
    await expectAllowed(changeRaid({ changes: { date: '2026-12-11', startsAt: next } }))
  })

  test('a member cannot edit a raid, even with an honest entry', async () => {
    await expectDenied(changeRaid({ who: 'member' }))
    assert.equal((await stored(`raids/${RAID}`))?.name, 'Test Raid')
  })

  const refused: [string, Change][] = [
    ['an edit without its audit entry', { skipEntry: true }],
    ['an audit entry without the edit', { skipRaid: true }],
    ['a revision that skips ahead', { stamp: { rev: 5 }, entryRev: 5 }],
    ['an entry for a different revision than the raid carries', { entryRev: 2 }],
    ['an updatedBy that is someone else', { stamp: { updatedBy: UID.guildLeader } }],
    ['an updatedAt chosen by the client', { stamp: { updatedAt: new Date('2020-01-01T00:00:00Z') } }],
    ['a createdBy changed', { changes: { name: 'Renamed Raid', createdBy: UID.guildLeader } }],
    ['an empty name', { changes: { name: '' } }],
    ['a name of 81 characters', { changes: { name: 'x'.repeat(81) } }],
    ['a size of 25', { changes: { size: 25 } }],
    ['a malformed zone snapshot', { changes: { zones: [{ id: 'barrow-deeps', name: 'Barrow Deeps', size: 25 }] } }],
    ['a date in the wrong format', { changes: { date: '09/12/2026' } }],
    ['an extra field', { changes: { name: 'Renamed Raid', notes: 'bring flasks' } }],
    ['an entry that lists a field that did not change', { entry: { changed: ['name', 'size'], before: { name: 'Test Raid', size: 20 }, after: { name: 'Renamed Raid', size: 20 } } }],
    ['an entry with a wrong before value', { entry: { before: { name: 'Something Else' } } }],
    ['an entry with a wrong after value', { entry: { after: { name: 'Something Else' } } }],
    ['an entry that is not for this raid', { entry: { targetId: 'raid-2' } }],
    ['an entry written under another name', { entry: { byName: 'Somebody Else' } }],
    ['an entry with an item that is not the raid name', { entry: { item: 'Another Raid' } }],
    ['an entry for a different action', { action: 'cancel' }],
  ]
  for (const [what, change] of refused) {
    test(`${what} is refused`, async () => {
      await expectDenied(changeRaid(change))
      assert.equal((await stored(`raids/${RAID}`))?.name, 'Test Raid')
      assert.equal(await stored(`auditLog/raid_${RAID}_1`), undefined)
    })
  }

  test('a raid cannot be deleted, even with an entry', async () => {
    const db = dbFor('guildLeader')
    const batch = writeBatch(db)
    batch.delete(guildDoc(db, `raids/${RAID}`))
    await expectDenied(batch.commit())
    assert.ok(await stored(`raids/${RAID}`))
  })
})

describe('ten-zone audited raid edits', () => {
  for (const who of ['raidLeader', 'guildLeader'] as const) {
    test(`a ${who} can change every editable detail with ten zones and an exact audit entry`, async () => {
      const zones = tenZones().map((zone, index) => ({ ...zone, id: `${index}${'x'.repeat(99)}`, name: 'x'.repeat(80) }))
      const startsAt = Timestamp.fromDate(new Date('2026-12-10T02:00:00Z'))
      const old = { name: 'Original Raid', date: '2026-12-09', time: '21:00', size: 40, description: 'Original plan', zones, startsAt, status: 'scheduled' }
      await seed(raidDoc(UID.raidLeader, old))
      const changes = {
        name: 'R'.repeat(80), date: '2026-12-10', time: '20:00', size: 20, description: 'D'.repeat(500),
        zones: [...zones].reverse().map((zone) => ({ ...zone, name: 'R'.repeat(80) })),
        startsAt: Timestamp.fromDate(new Date('2026-12-11T01:00:00Z')), status: 'cancelled', cancelReason: 'R'.repeat(300),
      }
      await expectAllowed(changeRaid({ who, action: 'cancel', changes }))
      const entry = await stored(`auditLog/raid_${RAID}_1`)
      assert.deepEqual(entry?.changed, Object.keys(changes))
      assert.deepEqual(entry?.before, { ...old, cancelReason: null })
      assert.deepEqual(entry?.after, changes)
      assert.deepEqual((await stored(`raids/${RAID}`))?.zones, changes.zones)
      await expectAllowed(changeRaid({ who, changes: { status: 'scheduled', cancelReason: deleteField() } }))
      assert.deepEqual((await stored(`raids/${RAID}`))?.zones, changes.zones)
      assert.deepEqual((await stored(`auditLog/raid_${RAID}_2`))?.after, { status: 'scheduled', cancelReason: null })
    })
  }

  test('adding ten zones logs every snapshot', async () => {
    const zones = tenZones()
    await expectAllowed(changeRaid({ changes: { zones } }))
    assert.deepEqual((await stored(`auditLog/raid_${RAID}_1`))?.before, { zones: null })
    assert.deepEqual((await stored(`auditLog/raid_${RAID}_1`))?.after, { zones })
  })

  test('unchanged ten-zone maps with different key order are not logged as changes', async () => {
    const zones = tenZones()
    await seed(raidDoc(UID.raidLeader, { zones }))
    await expectAllowed(changeRaid({ changes: { name: 'Revised Raid', zones: zones.map(({ id, name, size }) => ({ size, name, id })) },
      entry: { changed: ['name'], before: { name: 'Test Raid' }, after: { name: 'Revised Raid' } } }))
    assert.deepEqual((await stored(`auditLog/raid_${RAID}_1`))?.changed, ['name'])
  })

  for (let index = 0; index < 10; index++) {
    test(`a malformed snapshot at position ${index + 1} is refused atomically`, async () => {
      const original = tenZones()
      await seed(raidDoc(UID.raidLeader, { zones: original }))
      const zones = tenZones().map((zone, i) => i === index ? { ...zone, size: 25 } : zone)
      await expectDenied(changeRaid({ changes: { zones } }))
      assert.deepEqual((await stored(`raids/${RAID}`))?.zones, original)
      assert.equal(await stored(`auditLog/raid_${RAID}_1`), undefined)
    })
  }

  const invalidSnapshots: [string, unknown][] = [
    ['missing id', { name: 'Test Zone', size: 10 }],
    ['missing name', { id: 'zone-9', size: 10 }],
    ['missing size', { id: 'zone-9', name: 'Test Zone' }],
    ['extra key', { id: 'zone-9', name: 'Test Zone', size: 10, extra: true }],
    ['empty id', { id: '', name: 'Test Zone', size: 10 }],
    ['oversized id', { id: 'x'.repeat(101), name: 'Test Zone', size: 10 }],
    ['non-string id', { id: 9, name: 'Test Zone', size: 10 }],
    ['list id', { id: ['zone-9'], name: 'Test Zone', size: 10 }],
    ['empty name', { id: 'zone-9', name: '', size: 10 }],
    ['blank name', { id: 'zone-9', name: '   ', size: 10 }],
    ['oversized name', { id: 'zone-9', name: 'x'.repeat(81), size: 10 }],
    ['non-string name', { id: 'zone-9', name: 9, size: 10 }],
    ['list name', { id: 'zone-9', name: ['Test Zone'], size: 10 }],
    ['string size', { id: 'zone-9', name: 'Test Zone', size: '10' }],
    ['non-map snapshot', null],
  ]
  for (const [label, invalid] of invalidSnapshots) {
    test(`the tenth snapshot with ${label} is refused`, async () => {
      await expectDenied(changeRaid({ changes: { zones: [...tenZones().slice(0, 9), invalid] } }))
      assert.equal(await stored(`auditLog/raid_${RAID}_1`), undefined)
    })
  }

  const falseAudits: [string, (zones: ReturnType<typeof tenZones>, next: ReturnType<typeof tenZones>) => Change][] = [
    ['missing entry', () => ({ skipEntry: true })],
    ['missing zone change', () => ({ entry: { changed: [], before: {}, after: {} } })],
    ['truncated before snapshots', (zones, next) => ({ entry: { before: { zones: zones.slice(0, 9) }, after: { zones: next } } })],
    ['incorrect tenth after snapshot', (zones, next) => ({ entry: { before: { zones }, after: { zones: next.map((zone, index) => index === 9 ? { ...zone, name: 'False Name' } : zone) } } })],
  ]
  for (const [label, override] of falseAudits) {
    test(`ten-zone changes with ${label} are refused atomically`, async () => {
      const zones = tenZones()
      const next = [...zones].reverse()
      await seed(raidDoc(UID.raidLeader, { zones }))
      await expectDenied(changeRaid({ changes: { zones: next }, ...override(zones, next) }))
      assert.deepEqual((await stored(`raids/${RAID}`))?.zones, zones)
      assert.equal(await stored(`auditLog/raid_${RAID}_1`), undefined)
    })
  }

  test('members cannot make a ten-zone edit even with an honest entry', async () => {
    await expectDenied(changeRaid({ who: 'member', changes: { zones: tenZones() } }))
  })

  test('an unrelated edit cannot preserve a malformed legacy tenth zone', async () => {
    await seed(raidDoc(UID.raidLeader, { zones: [...tenZones().slice(0, 9), { id: 'zone-9', name: 'Test Zone', size: 25 }] }))
    await expectDenied(changeRaid({ changes: { name: 'Revised Raid' } }))
  })

  const invalidLists: [string, unknown][] = [
    ['empty', []],
    ['eleven snapshots', [...tenZones(), { id: 'zone-10', name: 'Eleventh Zone', size: 10 }]],
    ['null', null], ['string', 'zones'], ['map', {}],
  ]
  for (const [label, zones] of invalidLists) {
    test(`an invalid zone list (${label}) is refused`, async () => {
      await expectDenied(changeRaid({ changes: { zones } }))
    })
  }
})

describe('a raid description', () => {
  test('can be added, changed and cleared, each with an entry', async () => {
    await expectAllowed(changeRaid({ changes: { description: 'Bring flasks.' } }))
    assert.equal((await stored(`raids/${RAID}`))?.description, 'Bring flasks.')
    await expectAllowed(changeRaid({ changes: { description: 'x'.repeat(500) } }))
    await expectAllowed(changeRaid({ changes: { description: deleteField() } }))
    const raid = await stored(`raids/${RAID}`)
    assert.equal(raid?.description, undefined)
    assert.equal(raid?.rev, 3)
    assert.deepEqual((await stored(`auditLog/raid_${RAID}_3`))?.changed, ['description'])
  })

  test('is kept when the raid is cancelled', async () => {
    await seed(raidDoc(UID.raidLeader, { rev: 1, description: 'Bring flasks.', updatedBy: UID.raidLeader, updatedAt: new Date('2026-12-01T00:00:00Z') }))
    await expectAllowed(changeRaid({ action: 'cancel', changes: { status: 'cancelled', cancelReason: 'Tank unavailable' } }))
    assert.equal((await stored(`raids/${RAID}`))?.description, 'Bring flasks.')
  })

  const refused: [string, Change][] = [
    ['a description of 501 characters', { changes: { description: 'x'.repeat(501) } }],
    ['an empty description', { changes: { description: '' } }],
    ['a description that is a number', { changes: { description: 7 } }],
    ['a description change by a member', { who: 'member', changes: { description: 'Hi' } }],
    ['a description change the entry does not list', { changes: { description: 'Hi' }, entry: { changed: ['name'], before: { name: 'Test Raid' }, after: { name: 'Renamed Raid' } } }],
    ['a description change with a wrong after value', { changes: { description: 'Hi' }, entry: { after: { description: 'Other' } } }],
  ]
  for (const [what, change] of refused) {
    test(`${what} is refused`, async () => {
      await expectDenied(changeRaid(change))
      assert.equal((await stored(`raids/${RAID}`))?.description, undefined)
    })
  }
})

describe('a raid start time', () => {
  test('can be set and changed, each with an entry', async () => {
    await expectAllowed(changeRaid({ changes: { time: '19:30' } }))
    assert.equal((await stored(`raids/${RAID}`))?.time, '19:30')
    await expectAllowed(changeRaid({ changes: { time: '00:00' } }))
    await expectAllowed(changeRaid({ changes: { time: '23:59' } }))
    assert.deepEqual((await stored(`auditLog/raid_${RAID}_3`))?.changed, ['time'])
  })

  for (const bad of ['9:00', '24:00', '21:60', '21:00:00', '', 2100, '9pm']) {
    test(`${JSON.stringify(bad)} is refused`, async () => {
      await expectDenied(changeRaid({ changes: { time: bad } }))
      assert.equal((await stored(`raids/${RAID}`))?.time, undefined)
    })
  }

  test('a time change by a member is refused', async () => {
    await expectDenied(changeRaid({ who: 'member', changes: { time: '20:00' } }))
  })

  test('a time change the entry does not list is refused', async () => {
    await expectDenied(changeRaid({ changes: { time: '20:00' }, entry: { changed: ['name'], before: { name: 'Test Raid' }, after: { name: 'Renamed Raid' } } }))
  })
})

describe('cancelling a raid', () => {
  const cancel = (overrides: Change = {}) => changeRaid({ action: 'cancel', changes: { status: 'cancelled', cancelReason: 'Tank unavailable' }, ...overrides })

  for (const who of ['raidLeader', 'guildLeader'] as const) {
    test(`a ${who} can cancel a raid with a reason and it stays in the list`, async () => {
      await expectAllowed(cancel({ who }))
      const raid = await stored(`raids/${RAID}`)
      assert.equal(raid?.status, 'cancelled')
      assert.equal(raid?.cancelReason, 'Tank unavailable')
      assert.equal(raid?.name, 'Test Raid')
      const entry = await stored(`auditLog/raid_${RAID}_1`)
      assert.equal(entry?.action, 'cancel')
      assert.equal(entry?.reason, 'Tank unavailable')
    })
  }

  test('a member cannot cancel a raid', async () => {
    await expectDenied(cancel({ who: 'member' }))
  })

  const refused: [string, Change][] = [
    ['no reason', { changes: { status: 'cancelled' }, entry: { reason: 'Tank unavailable' } }],
    ['a blank reason', { changes: { status: 'cancelled', cancelReason: '   ' }, entry: { reason: '   ' } }],
    ['a reason of 301 characters', { changes: { status: 'cancelled', cancelReason: 'x'.repeat(301) }, entry: { reason: 'x'.repeat(301) } }],
    ['a reason that is not a string', { changes: { status: 'cancelled', cancelReason: 7 }, entry: { reason: '7' } }],
    ['an entry with a different reason than the raid carries', { entry: { reason: 'Something else' } }],
    ['an entry with no reason', { entry: { reason: undefined } }],
    ['a cancellation logged as an edit', { action: 'edit' }],
    ['a status that is not scheduled or cancelled', { changes: { status: 'removed', cancelReason: 'Tank unavailable' } }],
  ]
  for (const [what, change] of refused) {
    test(`a cancellation with ${what} is refused`, async () => {
      await expectDenied(cancel(change))
      assert.equal((await stored(`raids/${RAID}`))?.status, undefined)
    })
  }

  test('a raid cannot be cancelled twice', async () => {
    await expectAllowed(cancel())
    await expectDenied(cancel({ changes: { status: 'cancelled', cancelReason: 'Different reason' } }))
  })

  test('a cancelled raid can still be corrected, and stays cancelled', async () => {
    await seed(cancelled())
    await expectAllowed(changeRaid({ changes: { date: '2026-12-16' } }))
    const raid = await stored(`raids/${RAID}`)
    assert.equal(raid?.status, 'cancelled')
    assert.equal(raid?.date, '2026-12-16')
    assert.equal(raid?.rev, 2)
  })

  test('an edit cannot drop the reason while the raid is cancelled', async () => {
    await seed(cancelled())
    await expectDenied(changeRaid({ changes: { cancelReason: deleteField() } }))
  })
})

// Mark Complete (RAID-019): a Guild or Raid Leader marks a raid that has started complete, logged as 'complete', and can undo it (an edit back to
// scheduled). Never before the start, never on a cancelled raid, never on a raid with no saved start time, and never by a Member.
describe('marking a raid complete', () => {
  const HOUR = 3_600_000
  const started = (hoursAgo = 1) => Timestamp.fromMillis(Date.now() - hoursAgo * HOUR)
  const markComplete = (overrides: Change = {}) => changeRaid({ action: 'complete', changes: { status: 'complete' }, ...overrides })
  const seedStarted = (overrides: DocumentData = {}) => seed(raidDoc(UID.raidLeader, { startsAt: started(), ...overrides }))
  const seedComplete = (overrides: DocumentData = {}) => seedStarted({ rev: 1, status: 'complete', updatedBy: UID.raidLeader, updatedAt: new Date('2026-12-01T00:00:00Z'), ...overrides })

  for (const who of ['raidLeader', 'guildLeader'] as const) {
    test(`a ${who} can mark a started raid complete, and the entry says so`, async () => {
      await seedStarted()
      await expectAllowed(markComplete({ who }))
      const raid = await stored(`raids/${RAID}`)
      assert.equal(raid?.status, 'complete')
      assert.equal(raid?.rev, 1)
      const entry = await stored(`auditLog/raid_${RAID}_1`)
      assert.equal(entry?.action, 'complete')
      assert.deepEqual(entry?.changed, ['status'])
      assert.deepEqual(entry?.before, { status: null })
      assert.deepEqual(entry?.after, { status: 'complete' })
    })
  }

  test('a raid recorded as scheduled can be marked complete too, more than 5 hours after its start', async () => {
    await seedStarted({ startsAt: started(30), status: 'scheduled' })
    await expectAllowed(markComplete())
    assert.deepEqual((await stored(`auditLog/raid_${RAID}_1`))?.before, { status: 'scheduled' })
  })

  test('a member cannot mark a raid complete, even with an honest entry', async () => {
    await seedStarted()
    await expectDenied(markComplete({ who: 'member' }))
    assert.equal((await stored(`raids/${RAID}`))?.status, undefined)
  })

  test('a raid cannot be marked complete before its start', async () => {
    await seedStarted({ startsAt: Timestamp.fromMillis(Date.now() + HOUR) })
    await expectDenied(markComplete())
    assert.equal((await stored(`raids/${RAID}`))?.status, undefined)
  })

  test('a raid with no saved start time cannot be marked complete', async () => {
    await expectDenied(markComplete())
    assert.equal((await stored(`raids/${RAID}`))?.status, undefined)
    // Saving a start that has already passed in the same audited edit is accepted: the raid then has a start, and it has passed.
    await expectAllowed(markComplete({ changes: { status: 'complete', startsAt: started() } }))
  })

  test('a cancelled raid cannot be marked complete, before or after its start', async () => {
    for (const startsAt of [started(), Timestamp.fromMillis(Date.now() + HOUR)]) {
      await seed(cancelled({ startsAt }))
      await expectDenied(markComplete({ changes: { status: 'complete', cancelReason: deleteField() } }))
      await expectDenied(markComplete())
      assert.equal((await stored(`raids/${RAID}`))?.status, 'cancelled')
    }
  })

  const refused: [string, Change][] = [
    ['without its audit entry', { skipEntry: true }],
    ['with an entry but no raid change', { skipRaid: true }],
    ['logged as an edit', { action: 'edit' }],
    ['logged as a cancellation', { action: 'cancel', entry: { reason: 'Done early' } }],
    ['with a reason on the raid', { changes: { status: 'complete', cancelReason: 'Done early' } }],
    ['with an entry that leaves the status out', { entry: { changed: [], before: {}, after: {} } }],
    ['with an entry that says it went to scheduled', { entry: { after: { status: 'scheduled' } } }],
    ['with an entry written under another name', { entry: { byName: 'Somebody Else' } }],
  ]
  for (const [what, change] of refused) {
    test(`marking complete ${what} is refused`, async () => {
      await seedStarted()
      await expectDenied(markComplete(change))
      assert.equal((await stored(`raids/${RAID}`))?.status, undefined)
      assert.equal(await stored(`auditLog/raid_${RAID}_1`), undefined)
    })
  }

  test('an edit that is not Mark Complete cannot be logged as complete', async () => {
    await seedStarted()
    await expectDenied(changeRaid({ action: 'complete', changes: { name: 'Renamed Raid' } }))
    await seedComplete()
    await expectDenied(changeRaid({ action: 'complete', changes: { name: 'Renamed Raid' } }), 'nor an edit of a raid that is already complete')
  })

  test('a complete raid can be corrected and stays complete, but cannot move to a start still to come', async () => {
    await seedComplete()
    await expectAllowed(changeRaid({ changes: { name: 'Corrected Raid' } }))
    assert.equal((await stored(`raids/${RAID}`))?.status, 'complete')
    const later = Timestamp.fromMillis(Date.now() + 24 * HOUR)
    await expectDenied(changeRaid({ changes: { date: '2027-01-02', startsAt: later } }))
    await expectAllowed(changeRaid({ changes: { date: '2026-12-08', startsAt: started(48) } }), 'an earlier start that has also passed is fine')
    // What updateRaidEvent writes for a complete raid moved to a later start: back to scheduled in the same edit.
    await expectAllowed(changeRaid({ changes: { date: '2027-01-02', startsAt: later, status: 'scheduled' } }))
    const entry = await stored(`auditLog/raid_${RAID}_4`)
    assert.equal(entry?.action, 'edit')
    assert.deepEqual(entry?.changed, ['date', 'startsAt', 'status'])
    assert.equal((await stored(`raids/${RAID}`))?.status, 'scheduled')
  })

  test('a leader can undo it, back to scheduled, logged as an edit', async () => {
    await seedComplete()
    await expectAllowed(changeRaid({ changes: { status: 'scheduled' } }))
    const raid = await stored(`raids/${RAID}`)
    assert.equal(raid?.status, 'scheduled')
    assert.equal(raid?.rev, 2)
    const entry = await stored(`auditLog/raid_${RAID}_2`)
    assert.equal(entry?.action, 'edit')
    assert.deepEqual(entry?.before, { status: 'complete' })
    assert.deepEqual(entry?.after, { status: 'scheduled' })
    await expectAllowed(markComplete(), 'and mark it again')
    assert.equal((await stored(`auditLog/raid_${RAID}_3`))?.action, 'complete')
  })

  test('an undo logged as complete, without its entry, or by a member is refused', async () => {
    await seedComplete()
    await expectDenied(changeRaid({ action: 'complete', changes: { status: 'scheduled' } }))
    await expectDenied(changeRaid({ changes: { status: 'scheduled' }, skipEntry: true }))
    await expectDenied(changeRaid({ who: 'member', changes: { status: 'scheduled' } }))
    assert.equal((await stored(`raids/${RAID}`))?.status, 'complete')
  })

  test('a complete raid can still be cancelled with a reason, and restoring it puts it back to scheduled', async () => {
    await seedComplete()
    await expectDenied(changeRaid({ action: 'complete', changes: { status: 'cancelled', cancelReason: 'Called off' } }))
    await expectAllowed(changeRaid({ action: 'cancel', changes: { status: 'cancelled', cancelReason: 'Called off' } }))
    assert.equal((await stored(`raids/${RAID}`))?.status, 'cancelled')
    await expectAllowed(changeRaid({ changes: { status: 'scheduled', cancelReason: deleteField() } }))
    assert.equal((await stored(`raids/${RAID}`))?.status, 'scheduled')
  })

  for (const who of ['raidLeader', 'guildLeader'] as const) {
    test(`a ${who} can mark a ten-zone raid complete while changing every other detail, with an exact entry`, async () => {
      const zones = tenZones().map((zone, index) => ({ ...zone, id: `${index}${'x'.repeat(99)}`, name: 'x'.repeat(80) }))
      const old = { name: 'Original Raid', date: '2026-12-09', time: '21:00', size: 40, description: 'Original plan', zones, startsAt: started(3), status: 'scheduled' }
      await seed(raidDoc(UID.raidLeader, old))
      const changes = {
        name: 'R'.repeat(80), date: '2026-12-08', time: '20:00', size: 20, description: 'D'.repeat(500),
        zones: [...zones].reverse().map((zone) => ({ ...zone, name: 'R'.repeat(80) })), startsAt: started(2), status: 'complete',
      }
      await expectAllowed(changeRaid({ who, action: 'complete', changes }))
      const entry = await stored(`auditLog/raid_${RAID}_1`)
      assert.deepEqual(entry?.changed, Object.keys(changes))
      assert.deepEqual(entry?.after, changes)
      assert.equal((await stored(`raids/${RAID}`))?.status, 'complete')
    })
  }
})

describe('restoring a cancelled raid', () => {
  test('a leader can put it back to scheduled, which clears the reason', async () => {
    await seed(cancelled())
    await expectAllowed(changeRaid({ changes: { status: 'scheduled', cancelReason: deleteField() } }))
    const raid = await stored(`raids/${RAID}`)
    assert.equal(raid?.status, 'scheduled')
    assert.equal(raid?.cancelReason, undefined)
    const entry = await stored(`auditLog/raid_${RAID}_2`)
    assert.equal(entry?.action, 'edit')
    assert.deepEqual(entry?.before, { status: 'cancelled', cancelReason: 'Tank unavailable' })
  })

  test('restoring while keeping the old reason is refused', async () => {
    await seed(cancelled())
    await expectDenied(changeRaid({ changes: { status: 'scheduled' } }))
  })

  test('a member cannot restore a raid', async () => {
    await seed(cancelled())
    await expectDenied(changeRaid({ who: 'member', changes: { status: 'scheduled', cancelReason: deleteField() } }))
  })
})
