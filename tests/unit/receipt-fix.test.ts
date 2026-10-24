import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { FIX_REASON_MAX, moveChanges, reasonProblem, receiptChanged } from '../../src/features/loot/receiptFix.ts'
import { awardEditFields, describeEdit } from '../../src/shared/game/lootAudit.ts'

// Invented names.
const roster = new Map([['p-1', { id: 'p-1', name: 'Aria' }], ['p-2', { id: 'p-2', name: 'Brock' }]])
const who = { player: (id: string) => roster.get(id) }

describe('moving a receipt', () => {
  it('moves it to another roster character, with the name and the id together', () => {
    assert.deepEqual(moveChanges({ recipient: 'Aria', recipientId: 'p-1' }, 'p-2', who), { changes: { recipient: 'Brock', recipientId: 'p-2' } })
  })
  it('links an award that has only a name when it moves to a roster character', () => {
    assert.deepEqual(moveChanges({ recipient: 'Cale' }, 'p-1', who), { changes: { recipient: 'Aria', recipientId: 'p-1' } })
  })
  it('refuses a character who is not on the roster', () => {
    assert.equal(moveChanges({ recipient: 'Aria', recipientId: 'p-1' }, 'p-9', who).problem, 'Choose a character from the roster.')
    assert.equal(moveChanges({ recipient: 'Aria', recipientId: 'p-1' }, '', who).problem, 'Choose a character from the roster.')
  })
  it('refuses to move it to who has it already, by id when the award has one, else by name', () => {
    assert.equal(moveChanges({ recipient: 'Aria', recipientId: 'p-1' }, 'p-1', who).problem, 'That is who has it already.')
    // A renamed character is still the same person: the award keeps the old name, the id says who.
    assert.equal(moveChanges({ recipient: 'Old Name', recipientId: 'p-1' }, 'p-1', who).problem, 'That is who has it already.')
    assert.equal(moveChanges({ recipient: 'Aria' }, 'p-1', who).problem, 'That is who has it already.')
  })
})

describe('a receipt that changed under the dialog', () => {
  it('is told by the revision or the status having moved on since the dialog showed it', () => {
    assert.equal(receiptChanged({ rev: 1 }, { rev: 1 }), false)
    assert.equal(receiptChanged({}, {}), false)
    assert.equal(receiptChanged({ rev: 1 }, { rev: 2 }), true)
    assert.equal(receiptChanged({}, { rev: 1 }), true)
    assert.equal(receiptChanged({ rev: 2 }, { rev: 2, status: 'removed' }), true)
  })
})

describe('the reason', () => {
  it('is required to remove a receipt and optional to move one', () => {
    assert.equal(reasonProblem('', true), 'Give a reason for removing the receipt.')
    assert.equal(reasonProblem('   ', true), 'Give a reason for removing the receipt.')
    assert.equal(reasonProblem('', false), undefined)
    assert.equal(reasonProblem('Recorded twice', true), undefined)
  })
  it('is limited to what the rules allow', () => {
    assert.ok(reasonProblem('x'.repeat(FIX_REASON_MAX + 1), false))
    assert.equal(reasonProblem('x'.repeat(FIX_REASON_MAX), true), undefined)
  })
})

describe('what the entry of a fix lists', () => {
  const current = { recipient: 'Aria', recipientId: 'p-1', awardedAt: '2026-12-09', awardNote: '', phaseNo: 1 }
  it('lists a move as the recipient and the id, with who had it and who has it now', () => {
    assert.deepEqual(describeEdit(current, { recipient: 'Brock', recipientId: 'p-2' }, awardEditFields), {
      changed: ['recipient', 'recipientId'], before: { recipient: 'Aria', recipientId: 'p-1' }, after: { recipient: 'Brock', recipientId: 'p-2' },
    })
  })
  it('lists a removal as the status and the reason', () => {
    assert.deepEqual(describeEdit(current, { status: 'removed', removedReason: 'Recorded twice' }, awardEditFields), {
      changed: ['status', 'removedReason'], before: { status: null, removedReason: null }, after: { status: 'removed', removedReason: 'Recorded twice' },
    })
  })
  it('never lists the snapshot, the item or the stamps', () => {
    assert.equal(describeEdit(current, { prioritySnapshot: ['x'], councilNoteSnapshot: 'y', item: 'Other', encounter: 'Z', rev: 9 }, awardEditFields), null)
  })
})
