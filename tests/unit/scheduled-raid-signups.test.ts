// The Signups board of an opened Scheduled Raids row (features/scheduled-raids/signupGroups.ts) and its tabs (rowTabs.ts), RAID-018. Every name here is invented.
import assert from 'node:assert/strict'
import { describe, test } from 'node:test'
import type { PlayerRecord } from '../../src/shared/game/players.ts'
import type { RaidInvitation } from '../../src/shared/raids/planning.ts'
import type { RaidSignup, SignupStatus } from '../../src/raidSignups.ts'
import { effectiveRaidSignups } from '../../src/shared/raids/availability.ts'
import { boardColumns, boardSections, signupBoard, type SignupBoard } from '../../src/features/scheduled-raids/signupGroups.ts'
import { defaultRaidRowTab, raidRowTabs, tabForKey } from '../../src/features/scheduled-raids/rowTabs.ts'

// Ten specs, repeated: the 10-player pattern below gives one of each response to known roles and classes.
const specs: Pick<PlayerRecord, 'className' | 'specialization' | 'role'>[] = [
  { className: 'Warrior', specialization: 'Protection', role: 'Tank' },
  { className: 'Priest', specialization: 'Holy', role: 'Healer' },
  { className: 'Mage', specialization: 'Frost', role: 'Ranged' },
  { className: 'Rogue', specialization: 'Combat', role: 'Melee' },
  { className: 'Druid', specialization: 'Restoration', role: 'Healer' },
  { className: 'Hunter', specialization: 'Marksmanship', role: 'Ranged' },
  { className: 'Warlock', specialization: 'Affliction', role: 'Ranged' },
  { className: 'Paladin', specialization: 'Retribution', role: 'Melee' },
  { className: 'Shaman', specialization: 'Restoration', role: 'Healer' },
  { className: 'Warrior', specialization: 'Fury', role: 'Melee' },
]
// Per ten players: Accept for the Protection Warrior, Holy Priest, Frost Mage, Restoration Druid and Fury Warrior; Tentative Rogue, Late Hunter, Absent Warlock, Bench
// Paladin, and no response from the Shaman.
const pattern: (SignupStatus | null)[] = ['accept', 'accept', 'accept', 'tentative', 'accept', 'late', 'absent', 'bench', null, 'accept']
// Invented names, deliberately not in alphabetical order (and not in id order), so the sorting is by name.
const names = ['Talwyn', 'Brisa', 'Corvane', 'Dessaly', 'Eamor', 'Fiorel', 'Galvric', 'Hesprin', 'Ilsara', 'Jodrin', 'Kaelith', 'Lunessa', 'Morvain', 'Nyxa', 'Orlin',
  'Pellam', 'Quessa', 'Ravick', 'Sylvar', 'Tirra', 'Ulmer', 'Vanthe', 'Wrenna', 'Xyrin', 'Yorvel', 'Zalia', 'Amsel', 'Bricca', 'Cadrel', 'Dorvin', 'Elsabet', 'Fennick',
  'Gorwen', 'Halcy', 'Ivoren', 'Jestra', 'Korvin', 'Lirien', 'Mavren', 'Nolwen']

const guild = (size: number) => {
  const roster: PlayerRecord[] = Array.from({ length: size }, (_, index) => ({ id: `char-${String(size - index).padStart(2, '0')}`, name: names[index], linkedUid: `uid-${index}`, ...specs[index % 10] }))
  const invitations: RaidInvitation[] = roster.map((character) => ({ uid: character.linkedUid!, mainId: character.id }))
  return { roster, invitations }
}
const respond = (roster: PlayerRecord[], statusOf: (index: number) => SignupStatus | null): RaidSignup[] => roster.flatMap((character, index) => {
  const status = statusOf(index)
  return status ? [{ id: character.linkedUid!, characterId: character.id, status, ...(status === 'bench' ? { benchKind: 'self' as const } : {}) }] : []
})

const column = (board: SignupBoard, label: string) => board.columns.find((entry) => entry.label === label)!
const classCounts = (board: SignupBoard, label: string) => column(board, label).classes.map((group) => `${group.className} ${group.entries.length}`)
const sectionCounts = (board: SignupBoard) => Object.fromEntries(board.sections.map((section) => [section.key, section.entries.length]))
const shownNames = (board: SignupBoard) => [...board.columns.flatMap((entry) => entry.classes.flatMap((group) => group.entries)), ...board.sections.flatMap((section) => section.entries)].map((entry) => entry.character.name)
const sorted = (list: string[]) => [...list].sort((a, b) => a.localeCompare(b))

// Shape checks that hold for every board: class sub-groups add up to their column, the columns to the accepted total, and every list is in name order.
function assertConsistent(board: SignupBoard) {
  assert.deepEqual(board.columns.map((entry) => entry.label), ['Tanks', 'Healers', 'Ranged', 'Melee'])
  assert.deepEqual(board.sections.map((section) => section.label), ['Bench', 'Tentative', 'Late', 'Absent', 'Not responded'])
  for (const entry of board.columns) {
    assert.equal(entry.classes.reduce((total, group) => total + group.entries.length, 0), entry.count, `${entry.label} class groups add up to the column`)
    assert.deepEqual(entry.classes.map((group) => group.className), sorted(entry.classes.map((group) => group.className)), `${entry.label} classes are alphabetical`)
    for (const group of entry.classes) {
      assert.ok(group.entries.every((item) => item.character.className === group.className && item.character.role === entry.role), `${group.className} holds only its own class and role`)
      assert.deepEqual(group.entries.map((item) => item.character.name), sorted(group.entries.map((item) => item.character.name)))
    }
  }
  assert.equal(board.accepted, board.columns.reduce((total, entry) => total + entry.count, 0))
  for (const section of board.sections) assert.deepEqual(section.entries.map((item) => item.character.name), sorted(section.entries.map((item) => item.character.name)))
}

describe('the Signups board groups a raid by role, class and response', () => {
  test('10 players: one of each response, with the role columns split by class', () => {
    const { roster, invitations } = guild(10)
    const board = signupBoard(respond(roster, (index) => pattern[index]), invitations, roster)
    assertConsistent(board)
    assert.equal(board.accepted, 5)
    assert.equal(board.invited, 10)
    assert.deepEqual(board.columns.map((entry) => entry.count), [1, 2, 1, 1])
    assert.deepEqual(classCounts(board, 'Tanks'), ['Warrior 1'])
    assert.deepEqual(classCounts(board, 'Healers'), ['Druid 1', 'Priest 1'])
    assert.deepEqual(classCounts(board, 'Ranged'), ['Mage 1'])
    assert.deepEqual(classCounts(board, 'Melee'), ['Warrior 1'])
    assert.deepEqual(column(board, 'Tanks').classes[0].entries.map((entry) => entry.character.name), ['Talwyn'])
    assert.deepEqual(sectionCounts(board), { bench: 1, tentative: 1, late: 1, absent: 1, unanswered: 1 })
    assert.deepEqual(board.sections.map((section) => section.entries.map((entry) => entry.character.name)), [['Hesprin'], ['Dessaly'], ['Fiorel'], ['Galvric'], ['Ilsara']])
    assert.equal(board.unshown, 0)
    assert.deepEqual(sorted(shownNames(board)), sorted(roster.map((character) => character.name)), 'every invited player appears exactly once')
  })

  test('20 players: the same pattern twice, names in order inside each class', () => {
    const { roster, invitations } = guild(20)
    const board = signupBoard(respond(roster, (index) => pattern[index % 10]), invitations, roster)
    assertConsistent(board)
    assert.equal(board.accepted, 10)
    assert.deepEqual(board.columns.map((entry) => entry.count), [2, 4, 2, 2])
    assert.deepEqual(classCounts(board, 'Healers'), ['Druid 2', 'Priest 2'])
    assert.deepEqual(column(board, 'Healers').classes[1].entries.map((entry) => entry.character.name), ['Brisa', 'Lunessa'])
    assert.deepEqual(column(board, 'Tanks').classes[0].entries.map((entry) => entry.character.name), ['Kaelith', 'Talwyn'], 'by name, not by roster order or id')
    assert.deepEqual(sectionCounts(board), { bench: 2, tentative: 2, late: 2, absent: 2, unanswered: 2 })
    assert.deepEqual(sorted(shownNames(board)), sorted(roster.map((character) => character.name)))
  })

  test('40 players: three tens follow the pattern and the last ten have not responded', () => {
    const { roster, invitations } = guild(40)
    const board = signupBoard(respond(roster, (index) => index < 30 ? pattern[index % 10] : null), invitations, roster)
    assertConsistent(board)
    assert.equal(board.accepted, 15)
    assert.equal(board.invited, 40)
    assert.deepEqual(board.columns.map((entry) => entry.count), [3, 6, 3, 3])
    assert.deepEqual(classCounts(board, 'Healers'), ['Druid 3', 'Priest 3'])
    assert.deepEqual(classCounts(board, 'Melee'), ['Warrior 3'])
    assert.deepEqual(sectionCounts(board), { bench: 3, tentative: 3, late: 3, absent: 3, unanswered: 13 })
    const unanswered = board.sections.find((section) => section.key === 'unanswered')!.entries.map((entry) => entry.character.name)
    assert.ok(roster.slice(30).every((character) => unanswered.includes(character.name)), 'every invited player without a response is listed')
    assert.deepEqual(sorted(shownNames(board)), sorted(roster.map((character) => character.name)))
  })

  test('a raid with no responses: empty columns and every invited player under Not responded', () => {
    const { roster, invitations } = guild(10)
    const board = signupBoard([], invitations, roster)
    assertConsistent(board)
    assert.equal(board.accepted, 0)
    assert.deepEqual(board.columns.map((entry) => [entry.count, entry.classes.length]), [[0, 0], [0, 0], [0, 0], [0, 0]])
    assert.deepEqual(sectionCounts(board), { bench: 0, tentative: 0, late: 0, absent: 0, unanswered: 10 })
    assert.deepEqual(board.sections.at(-1)!.entries.map((entry) => entry.character.name), sorted(roster.map((character) => character.name)))
  })

  test('a raid with no responses and no invitations shows an empty board', () => {
    const board = signupBoard([], [], guild(10).roster)
    assertConsistent(board)
    assert.deepEqual({ accepted: board.accepted, invited: board.invited, unshown: board.unshown }, { accepted: 0, invited: 0, unshown: 0 })
    assert.ok(board.sections.every((section) => section.entries.length === 0))
  })
})

describe('who the Signups board shows', () => {
  const main: PlayerRecord = { id: 'main-1', name: 'Talwyn', className: 'Warrior', specialization: 'Protection', role: 'Tank', linkedUid: 'uid-1' }
  const alt: PlayerRecord = { id: 'alt-1', name: 'Brisa', className: 'Druid', specialization: 'Restoration', role: 'Healer', mainId: 'main-1' }
  const other: PlayerRecord = { id: 'main-2', name: 'Corvane', className: 'Mage', specialization: 'Frost', role: 'Ranged', linkedUid: 'uid-2' }
  const roster = [main, alt, other]
  const invitations: RaidInvitation[] = [{ uid: 'uid-1', mainId: 'main-1' }, { uid: 'uid-2', mainId: 'main-2' }]

  test('an alt sign-up appears in the alt\'s own role and class, with its main named, and the member is not also Not responded', () => {
    const board = signupBoard([{ id: 'uid-1', characterId: 'alt-1', status: 'accept' }], invitations, roster)
    assert.deepEqual(classCounts(board, 'Healers'), ['Druid 1'])
    assert.deepEqual(column(board, 'Healers').classes[0].entries[0], { uid: 'uid-1', character: alt, mainName: 'Talwyn' })
    assert.equal(column(board, 'Tanks').count, 0)
    assert.deepEqual(board.sections.at(-1)!.entries.map((entry) => entry.character.name), ['Corvane'])
  })

  test('a main has no main named, and a character linked to a missing main or to itself is not treated as an alt', () => {
    const orphan: PlayerRecord = { ...alt, id: 'orphan', mainId: 'gone' }
    const self: PlayerRecord = { ...alt, id: 'self', mainId: 'self' }
    const board = signupBoard([{ id: 'uid-1', characterId: 'orphan', status: 'tentative' }, { id: 'uid-2', characterId: 'self', status: 'late' }, { id: 'uid-3', characterId: 'main-1', status: 'absent' }], [], [...roster, orphan, self])
    assert.ok(board.sections.flatMap((section) => section.entries).every((entry) => entry.mainName === undefined))
  })

  test('unavailable dates read as Absent, through the same effective responses the workbench uses', () => {
    const responses: RaidSignup[] = [{ id: 'uid-1', characterId: 'main-1', status: 'accept' }]
    const away = [{ id: 'away-1', userId: 'uid-1', displayName: 'Talwyn', startDate: '2026-12-01', endDate: '2026-12-31' }, { id: 'away-2', userId: 'uid-2', displayName: 'Corvane', startDate: '2026-12-09', endDate: '2026-12-09' }]
    const board = signupBoard(effectiveRaidSignups(responses, away, roster, '2026-12-09'), invitations, roster)
    assert.equal(board.accepted, 0)
    assert.deepEqual(board.sections.find((section) => section.key === 'absent')!.entries.map((entry) => entry.character.name), ['Corvane', 'Talwyn'])
    assert.equal(board.sections.at(-1)!.entries.length, 0, 'a member with unavailable dates and no response is Absent, not Not responded')
  })

  test('a response from a member who is not on the invitation list is still shown, and the invited count is the list', () => {
    const board = signupBoard([{ id: 'uid-9', characterId: 'main-2', status: 'bench', benchKind: 'self' }], [{ uid: 'uid-1', mainId: 'main-1' }], roster)
    assert.equal(board.invited, 1)
    assert.deepEqual(board.sections.map((section) => section.entries.map((entry) => entry.character.name)), [['Corvane'], [], [], [], ['Talwyn']])
  })

  test('Not responded names the account\'s current linked main, or the invited main when the account has none', () => {
    const relinked: PlayerRecord = { id: 'main-3', name: 'Dessaly', className: 'Rogue', specialization: 'Combat', role: 'Melee', linkedUid: 'uid-1' }
    const unlinked: PlayerRecord = { ...other, linkedUid: undefined }
    const board = signupBoard([], invitations, [{ ...main, linkedUid: undefined }, relinked, unlinked])
    assert.deepEqual(board.sections.at(-1)!.entries.map((entry) => [entry.uid, entry.character.name]), [['uid-2', 'Corvane'], ['uid-1', 'Dessaly']])
  })

  test('a response or invitation for a character no longer on the roster is counted as not shown, not guessed', () => {
    const board = signupBoard([{ id: 'uid-1', characterId: 'deleted', status: 'accept' }], [...invitations, { uid: 'uid-7', mainId: 'deleted-main' }], roster)
    assert.equal(board.unshown, 2)
    assert.equal(board.accepted, 0)
    assert.deepEqual(board.sections.at(-1)!.entries.map((entry) => entry.character.name), ['Corvane'])
  })

  test('a character with no raid role is counted as not shown rather than put in a column', () => {
    const roleless = { ...other, role: '' } as unknown as PlayerRecord
    const board = signupBoard([{ id: 'uid-2', characterId: 'main-2', status: 'accept' }], [], [roleless])
    assert.equal(board.accepted, 0)
    assert.equal(board.unshown, 1)
  })

  test('the columns and sections are fixed and in the board\'s order', () => {
    assert.deepEqual(boardColumns.map((entry) => entry.role), ['Tank', 'Healer', 'Ranged', 'Melee'])
    assert.deepEqual(boardSections.map((entry) => entry.key), ['bench', 'tentative', 'late', 'absent', 'unanswered'])
  })
})

describe('the tabs of an opened raid row', () => {
  test('a Guild or Raid Leader opens on Groups and everyone else on Signups', () => {
    assert.equal(defaultRaidRowTab(true), 'groups')
    assert.equal(defaultRaidRowTab(false), 'signups')
    assert.deepEqual(raidRowTabs, ['signups', 'groups'])
  })

  test('the arrows move to the other tab and wrap; Home and End go to the ends; other keys move nothing', () => {
    assert.equal(tabForKey(raidRowTabs, 'signups', 'ArrowRight'), 'groups')
    assert.equal(tabForKey(raidRowTabs, 'groups', 'ArrowRight'), 'signups')
    assert.equal(tabForKey(raidRowTabs, 'signups', 'ArrowLeft'), 'groups')
    assert.equal(tabForKey(raidRowTabs, 'groups', 'ArrowLeft'), 'signups')
    assert.equal(tabForKey(raidRowTabs, 'groups', 'Home'), 'signups')
    assert.equal(tabForKey(raidRowTabs, 'signups', 'End'), 'groups')
    for (const key of ['Enter', ' ', 'Tab', 'ArrowDown', 'ArrowUp', 'a']) assert.equal(tabForKey(raidRowTabs, 'signups', key), undefined, key)
  })

  test('with three tabs the arrows step one at a time', () => {
    const three = ['a', 'b', 'c'] as const
    assert.equal(tabForKey(three, 'a', 'ArrowRight'), 'b')
    assert.equal(tabForKey(three, 'a', 'ArrowLeft'), 'c')
    assert.equal(tabForKey(three, 'b', 'End'), 'c')
  })
})
