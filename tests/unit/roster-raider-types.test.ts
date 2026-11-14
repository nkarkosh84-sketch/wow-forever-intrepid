import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { normalizeRosterRaiderType, raiderTypeLabel } from '../../src/features/roster/raiderTypes.ts'
import { rosterAccountUid } from '../../src/features/roster/account.ts'
import { sortRoster } from '../../src/features/roster/sort.ts'
import type { PlayerRecord } from '../../src/shared/game/players.ts'

const main: PlayerRecord = { id: 'main', name: 'Aldric', className: 'Warrior', specialization: 'Arms', role: 'Melee', linkedUid: 'member-a' }
const alt: PlayerRecord = { id: 'alt', name: 'Elowen', className: 'Mage', specialization: 'Frost', role: 'Ranged', mainId: 'main' }
const roster = new Map([main, alt].map((player) => [player.id, player]))

describe('roster raider types', () => {
  it('accepts only a valid selection for the matching document owner', () => {
    assert.deepEqual(normalizeRosterRaiderType('member-a', { userId: 'member-a', type: 'casual' }), { id: 'member-a', type: 'casual' })
    assert.deepEqual(normalizeRosterRaiderType('member-a', { userId: 'member-a', type: 'hardcore' }), { id: 'member-a', type: 'hardcore' })
    assert.equal(normalizeRosterRaiderType('member-a', { userId: 'member-b', type: 'casual' }), null)
    assert.equal(normalizeRosterRaiderType('member-a', { userId: 'member-a', type: 'unknown' }), null)
  })

  it('uses the linked main account for alts even if the main is not in the visible rows', () => {
    assert.equal(rosterAccountUid(main, roster), 'member-a')
    assert.equal(rosterAccountUid(alt, roster), 'member-a')
    assert.equal(rosterAccountUid({ ...main, linkedUid: undefined }, roster), undefined)
    assert.equal(rosterAccountUid(alt, new Map()), undefined)
    assert.equal(rosterAccountUid({ ...alt, mainId: 'alt' }, roster), undefined)
    assert.equal(rosterAccountUid({ ...alt, mainId: 'alt' }, new Map([['alt', alt]])), undefined)
    assert.equal(rosterAccountUid({ ...main, mainId: 'alt' }, roster), undefined)
  })

  it('does not imply access for an alt of an unlinked main or use a conflicting direct alt link', () => {
    const unlinked = new Map([[main.id, { ...main, linkedUid: undefined }]])
    assert.equal(rosterAccountUid(alt, unlinked), undefined)
    assert.equal(rosterAccountUid({ ...alt, linkedUid: 'conflicting-account' }, roster), 'member-a')
    assert.equal(rosterAccountUid({ ...alt, linkedUid: 'conflicting-account' }, unlinked), undefined)
  })

  it('sorts App Access by the inherited account status in either direction', () => {
    const unlinked: PlayerRecord = { ...main, id: 'unlinked', name: 'Bryn', linkedUid: undefined }
    const players = [unlinked, alt, main]
    const value = (player: PlayerRecord) => rosterAccountUid(player, roster) ? 'Linked' : 'No account'
    assert.deepEqual(sortRoster(players, 'access', 'asc', () => undefined, [], value).map((player) => player.id), ['main', 'alt', 'unlinked'])
    assert.deepEqual(sortRoster(players, 'access', 'desc', () => undefined, [], value).map((player) => player.id), ['unlinked', 'main', 'alt'])
  })

  it('shows the member-facing names without treating an unset choice as Casual', () => {
    assert.equal(raiderTypeLabel('casual'), 'Casual')
    assert.equal(raiderTypeLabel('hardcore'), 'Raider')
    assert.equal(raiderTypeLabel(undefined), 'Not set')
  })
})
