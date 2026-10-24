import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { awardsForPriority, listingProgress, nameKey, recipientChoices } from '../../src/features/loot/completion.ts'

// Every name here is invented: this repository is public.
const priority = (rankedPlayers: string[], overrides: Partial<{ id: string; item: string; phaseNo: number }> = {}) => ({ id: 'p1', item: 'Signet of the Deep Earth', rankedPlayers, ...overrides })
const award = (recipient: string, overrides: Partial<{ priorityId: string; item: string; status: string; phaseNo: number }> = {}) => ({ priorityId: 'p1', item: 'Signet of the Deep Earth', recipient, ...overrides })

describe('listingProgress', () => {
  it('has nothing received and the first listing next when there are no awards', () => {
    const progress = listingProgress(priority(['Morrow', 'Aurelia', 'Vex']), [])
    assert.deepEqual(progress.received, [false, false, false])
    assert.equal(progress.next, 0)
    assert.equal(progress.complete, false)
  })

  it('marks the receiving player and moves next to the first open listing', () => {
    const progress = listingProgress(priority(['Morrow', 'Aurelia', 'Vex']), [award('Morrow')])
    assert.deepEqual(progress.received, [true, false, false])
    assert.equal(progress.next, 1)
  })

  it('does not require the receivers to be in order', () => {
    const progress = listingProgress(priority(['Morrow', 'Aurelia', 'Vex']), [award('Vex')])
    assert.deepEqual(progress.received, [false, false, true])
    assert.equal(progress.next, 0)
  })

  it('satisfies a player listed twice one receipt at a time, first listing first', () => {
    const list = priority(['Morrow', 'Vex', 'Morrow'])
    assert.deepEqual(listingProgress(list, [award('Morrow')]).received, [true, false, false])
    assert.deepEqual(listingProgress(list, [award('Morrow'), award('Morrow')]).received, [true, false, true])
    assert.deepEqual(listingProgress(list, [award('Morrow'), award('Morrow'), award('Vex')]).complete, true)
  })

  it('ignores receipts beyond a player\'s listings', () => {
    const progress = listingProgress(priority(['Morrow', 'Vex']), [award('Morrow'), award('Morrow'), award('Morrow')])
    assert.deepEqual(progress.received, [true, false])
  })

  it('ignores awards to players who are not listed', () => {
    const progress = listingProgress(priority(['Morrow']), [award('Stranger')])
    assert.deepEqual(progress.received, [false])
  })

  it('ignores awards of other priorities and of other items', () => {
    const list = priority(['Morrow'])
    assert.deepEqual(listingProgress(list, [award('Morrow', { priorityId: 'p2' })]).received, [false])
    assert.deepEqual(listingProgress(list, [award('Morrow', { priorityId: '', item: 'Another Item' })]).received, [false])
  })

  it('counts an award with no priority by its item name', () => {
    const list = priority(['Morrow'])
    assert.deepEqual(listingProgress(list, [award('Morrow', { priorityId: '', item: '  signet of the DEEP earth ' })]).received, [true])
  })

  it('says which award each received line stands on, the oldest award on the first listing', () => {
    const list = priority(['Morrow', 'Vex', 'Morrow'])
    const awards = [
      { ...award('Morrow'), id: 'late', awardedAt: '2026-12-16' },
      { ...award('Vex'), id: 'vex', awardedAt: '2026-12-09' },
      { ...award('Morrow'), id: 'early', awardedAt: '2026-12-09' },
    ]
    const progress = listingProgress(list, awards)
    assert.deepEqual(progress.receipts.map((receipt) => receipt?.id), ['early', 'vex', 'late'])
    assert.deepEqual(listingProgress(list, [...awards].reverse()).receipts.map((receipt) => receipt?.id), ['early', 'vex', 'late'])
  })
  it('keeps two receipts of one item on one night in the order they were entered, whatever their ids say', () => {
    const list = priority(['Morrow', 'Morrow'])
    const first = { ...award('Morrow'), id: 'zzz', awardedAt: '2026-12-09', createdAt: { toMillis: () => 1000 } }
    const second = { ...award('Morrow'), id: 'aaa', awardedAt: '2026-12-09', createdAt: { toMillis: () => 2000 } }
    assert.deepEqual(listingProgress(list, [second, first]).receipts.map((receipt) => receipt?.id), ['zzz', 'aaa'])
    assert.deepEqual(listingProgress(list, [first, second]).receipts.map((receipt) => receipt?.id), ['zzz', 'aaa'])
    // Without a time (an award from before the Log, or a time that has not arrived yet) it falls back to the id.
    assert.deepEqual(listingProgress(list, [{ ...first, createdAt: undefined }, { ...second, createdAt: null }]).receipts.map((receipt) => receipt?.id), ['aaa', 'zzz'])
  })
  it('has no award for a line that is not received, and none for a note', () => {
    // The first line is an open note (an empty id), the second is Vex (id p-3), the third is Morrow, who has received nothing.
    const list = { ...priority(['Any warlock', 'Vex', 'Morrow']), rankedIds: ['', 'p-3', 'p-1'] }
    const progress = listingProgress(list, [{ ...award('Vex'), recipientId: 'p-3', id: 'v' }])
    assert.deepEqual(progress.receipts.map((receipt) => receipt?.id), [undefined, 'v', undefined])
    assert.deepEqual(progress.receipts.map((receipt) => receipt !== undefined), progress.received)
  })
  it('stands on the award that is still active when another of the same person was removed', () => {
    const list = priority(['Morrow', 'Morrow'])
    const progress = listingProgress(list, [{ ...award('Morrow', { status: 'removed' }), id: 'gone', awardedAt: '2026-12-09' }, { ...award('Morrow'), id: 'kept', awardedAt: '2026-12-16' }])
    assert.deepEqual(progress.receipts.map((receipt) => receipt?.id), ['kept', undefined])
  })
  it('stops counting a removed award', () => {
    const list = priority(['Morrow', 'Morrow'])
    assert.deepEqual(listingProgress(list, [award('Morrow'), award('Morrow', { status: 'removed' })]).received, [true, false])
    assert.deepEqual(listingProgress(list, [award('Morrow', { status: 'active' })]).received, [true, false])
  })

  it('matches names ignoring case and spacing', () => {
    const progress = listingProgress(priority(['Morrow', 'Vex']), [award('  morrow ')])
    assert.deepEqual(progress.received, [true, false])
  })

  it('is complete only when every listing is received', () => {
    const list = priority(['Morrow', 'Vex'])
    assert.equal(listingProgress(list, [award('Morrow')]).complete, false)
    const done = listingProgress(list, [award('Morrow'), award('Vex')])
    assert.equal(done.complete, true)
    assert.equal(done.next, -1)
  })

  it('is never complete with an empty list', () => {
    const progress = listingProgress(priority([]), [award('Morrow')])
    assert.equal(progress.complete, false)
    assert.equal(progress.next, -1)
  })

  it('does not depend on the order of the awards', () => {
    const list = priority(['Morrow', 'Vex', 'Morrow'])
    const one = [award('Vex'), award('Morrow')]
    assert.deepEqual(listingProgress(list, one).received, listingProgress(list, [...one].reverse()).received)
  })
})

describe('awardsForPriority', () => {
  it('keeps awards recorded from the priority and unlinked awards for the same item', () => {
    const list = priority(['Morrow'])
    const mine = award('Morrow')
    const unlinked = award('Vex', { priorityId: '' })
    const other = award('Vex', { priorityId: 'p2' })
    assert.deepEqual(awardsForPriority(list, [mine, unlinked, other]), [mine, unlinked])
  })
  it('counts an unlinked award only in its own phase; no phase means the first', () => {
    const first = priority(['Morrow'])
    const second = priority(['Morrow'], { id: 'p9', phaseNo: 1 })
    const old = award('Morrow', { priorityId: '' })
    const stamped = award('Morrow', { priorityId: '', phaseNo: 1 })
    assert.deepEqual(awardsForPriority(first, [old, stamped]), [old])
    assert.deepEqual(awardsForPriority(second, [old, stamped]), [stamped])
  })
  it('does not mark a second phase\'s item received because of a first-phase award of the same name', () => {
    const second = priority(['Morrow', 'Vex'], { id: 'p9', phaseNo: 1 })
    assert.deepEqual(listingProgress(second, [award('Morrow', { priorityId: '' })]).received, [false, false])
    assert.deepEqual(listingProgress(second, [award('Morrow', { priorityId: '', phaseNo: 1 })]).received, [true, false])
  })
  it('ignores a phase number that is not valid, as the first phase', () => {
    const first = priority(['Morrow'])
    const odd = award('Morrow', { priorityId: '', phaseNo: -4 })
    assert.deepEqual(awardsForPriority(first, [odd]), [odd])
  })
})

describe('recipientChoices', () => {
  it('lists a player listed twice once, with how many listings are received', () => {
    const list = priority(['Morrow', 'Vex', 'morrow'])
    const choices = recipientChoices(list, listingProgress(list, [award('Morrow')]))
    assert.deepEqual(choices, [{ key: 'name:morrow', name: 'Morrow', listed: 2, received: 1 }, { key: 'name:vex', name: 'Vex', listed: 1, received: 0 }])
  })
})

describe('nameKey', () => {
  it('trims, collapses spaces and ignores case', () => {
    assert.equal(nameKey('  Dun   Morogh '), 'dun morogh')
  })
})
