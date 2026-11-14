import assert from 'node:assert/strict'
import { test } from 'node:test'
import { Timestamp } from 'firebase/firestore'
import { emptyReadinessChecklist, isReadinessChecklist, normalizeReadiness, readinessChecks, readinessProgress } from '../../src/shared/members/readiness.ts'
import { isRaidReady } from '../../functions/readiness.js'

const stamps = { updatedBy: 'invented-account', updatedAt: Timestamp.fromMillis(10) }
const complete = () => Object.fromEntries(readinessChecks.map(({ key }) => [key, true]))

test('nine checks with three preparation checks and four acknowledgments; every completion combination agrees with backend eligibility', () => {
  assert.equal(readinessChecks.length, 9)
  assert.deepEqual(readinessChecks.filter((entry) => 'preparation' in entry).map(({ key }) => key), ['gear', 'professions', 'talentsAndAbilities'])
  assert.deepEqual(readinessChecks.filter((entry) => 'acknowledgment' in entry).map(({ key }) => key), ['enchants', 'rotation', 'consumables', 'raidKnowledge'])
  for (let mask = 0; mask < 512; mask++) {
    const checklist = { ...emptyReadinessChecklist() }
    readinessChecks.forEach(({ key }, index) => { checklist[key] = !!(mask & (1 << index)) })
    const completed = readinessChecks.filter(({ key }) => checklist[key]).length
    const ready = mask === 511
    assert.equal(isReadinessChecklist(checklist), true)
    assert.deepEqual(readinessProgress(checklist), { completed, total: 9, percent: Math.round(completed / 9 * 100), ready })
    const record = { schemaVersion: 1, checklist, ready, ...stamps }
    assert.equal(normalizeReadiness('main', record)?.ready, ready)
    assert.equal(isRaidReady(record), ready)
    assert.equal(normalizeReadiness('main', { ...record, ready: !ready }), null)
    assert.equal(isRaidReady({ ...record, ready: !ready }), false)
  }
})

test('legacy ready and not-ready flags have zero assumed progress and cannot qualify in backend', () => {
  for (const ready of [true, false]) {
    const legacy = { ready, ...stamps }
    assert.deepEqual(normalizeReadiness('main', legacy), { id: 'main', ready: false, checklist: null, ...stamps })
    assert.equal(isRaidReady(legacy), false)
  }
  assert.equal(isRaidReady(undefined), false)
})

test('malformed checklists, schema versions and stamps are rejected instead of becoming valid empty checklists', () => {
  const checklist = complete()
  const valid = { schemaVersion: 1, checklist, ready: true, ...stamps }
  for (const value of [null, [], true, {}, { ...checklist, extra: true }, ...readinessChecks.flatMap(({ key }) => [
    Object.fromEntries(Object.entries(checklist).filter(([field]) => field !== key)),
    { ...checklist, [key]: 'true' },
    { ...checklist, [key]: 1 },
  ])]) {
    assert.equal(isReadinessChecklist(value), false)
    assert.equal(normalizeReadiness('main', { ...valid, checklist: value }), null)
    assert.equal(isRaidReady({ ...valid, checklist: value }), false)
  }
  for (const schemaVersion of [undefined, 0, 2, '1']) {
    assert.equal(normalizeReadiness('main', { ...valid, schemaVersion }), null)
    assert.equal(isRaidReady({ ...valid, schemaVersion }), false)
  }
  for (const change of [{ ready: 'true' }, { updatedBy: '' }, { updatedAt: 10 }]) {
    assert.equal(normalizeReadiness('main', { ...valid, ...change }), null)
  }
})

test('empty progress is independent and normalization preserves immutable character IDs', () => {
  const main = emptyReadinessChecklist()
  const alt = emptyReadinessChecklist()
  main.level60 = true
  assert.equal(alt.level60, false)
  const record = { schemaVersion: 1, checklist: main, ready: false, ...stamps }
  assert.equal(normalizeReadiness('unchanged-character-id', record)?.id, 'unchanged-character-id')
  assert.equal(readinessProgress(main).percent, 11)
  assert.equal(readinessProgress(alt).percent, 0)
})
