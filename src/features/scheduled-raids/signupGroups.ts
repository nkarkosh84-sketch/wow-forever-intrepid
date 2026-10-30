// The Signups tab of an opened Scheduled Raids row (RAID-018): a read-only board of one raid's responses, like Discord's Raid Helper. Pure, so Node tests it; it takes the
// effective responses (effectiveRaidSignups, so unavailable dates already read as Absent), the raid's invitation list and the roster, and reads nothing else.
import type { Role } from '../../shared/game/classes.ts'
import type { PlayerRecord } from '../../shared/game/players.ts'
import type { RaidInvitation } from '../../shared/raids/planning.ts'
import type { RaidSignup, SignupStatus } from '../../raidSignups.ts'

/** The role columns, in the order the team cards list roles (RAID-012): Tanks, Healers, Ranged, Melee. Only an Accept response goes in a column. */
export const boardColumns = [
  { role: 'Tank', label: 'Tanks' },
  { role: 'Healer', label: 'Healers' },
  { role: 'Ranged', label: 'Ranged' },
  { role: 'Melee', label: 'Melee' },
] as const satisfies readonly { role: Role; label: string }[]

/** The lists under the columns, in this order. Not responded is every invited member with no response. */
export const boardSections = [
  { key: 'bench', label: 'Bench' },
  { key: 'tentative', label: 'Tentative' },
  { key: 'late', label: 'Late' },
  { key: 'absent', label: 'Absent' },
  { key: 'unanswered', label: 'Not responded' },
] as const satisfies readonly { key: Exclude<SignupStatus, 'accept'> | 'unanswered'; label: string }[]

export type BoardSectionKey = typeof boardSections[number]['key']

/** One name on the board: the character the member responded with (or, for Not responded, their invited main), and the main's name when that character is an alt. */
export type BoardEntry = { uid: string; character: PlayerRecord; mainName?: string }
export type BoardClassGroup = { className: string; entries: BoardEntry[] }
export type BoardColumn = { role: Role; label: string; count: number; classes: BoardClassGroup[] }
export type BoardSection = { key: BoardSectionKey; label: string; entries: BoardEntry[] }
export type SignupBoard = {
  /** Accept responses shown in the columns. */
  accepted: number
  /** Members on the raid's invitation list. */
  invited: number
  columns: BoardColumn[]
  sections: BoardSection[]
  /** Responses or invitations that cannot be shown: the character is no longer on the roster, or has no raid role. */
  unshown: number
}

const byName = (a: BoardEntry, b: BoardEntry) => a.character.name.localeCompare(b.character.name) || a.character.id.localeCompare(b.character.id)

export function signupBoard(responses: readonly RaidSignup[], invitations: readonly RaidInvitation[], roster: readonly PlayerRecord[]): SignupBoard {
  const characters = new Map(roster.map((character) => [character.id, character]))
  const entry = (uid: string, character: PlayerRecord): BoardEntry => {
    const main = character.mainId && character.mainId !== character.id ? characters.get(character.mainId) : undefined
    // The roster's own rule for an alt (shared/game/alts.ts): it links to a main that exists and is not itself an alt.
    return main && !main.mainId ? { uid, character, mainName: main.name } : { uid, character }
  }
  const accepted = new Map<Role, BoardEntry[]>(boardColumns.map(({ role }) => [role, []]))
  const listed = new Map<BoardSectionKey, BoardEntry[]>(boardSections.map(({ key }) => [key, []]))
  let unshown = 0
  for (const response of responses) {
    const character = characters.get(response.characterId)
    const list = response.status === 'accept' ? character && accepted.get(character.role) : listed.get(response.status)
    if (!character || !list) { unshown += 1; continue }
    list.push(entry(response.id, character))
  }
  // An invitation names the member's account and their main. The main shown is the account's current linked main, as the workbench's available roster does.
  const responded = new Set(responses.map((response) => response.id))
  for (const invitation of invitations) {
    if (responded.has(invitation.uid)) continue
    const main = roster.find((character) => !character.mainId && character.linkedUid === invitation.uid) ?? characters.get(invitation.mainId)
    if (!main) { unshown += 1; continue }
    listed.get('unanswered')!.push(entry(invitation.uid, main))
  }
  const columns = boardColumns.map(({ role, label }): BoardColumn => {
    const entries = accepted.get(role)!
    const classes = new Map<string, BoardEntry[]>()
    for (const item of entries) classes.set(item.character.className, [...(classes.get(item.character.className) ?? []), item])
    return {
      role, label, count: entries.length,
      classes: [...classes].sort(([a], [b]) => a.localeCompare(b)).map(([className, members]) => ({ className, entries: members.sort(byName) })),
    }
  })
  return {
    accepted: columns.reduce((total, column) => total + column.count, 0),
    invited: invitations.length,
    columns,
    sections: boardSections.map(({ key, label }) => ({ key, label, entries: listed.get(key)!.sort(byName) })),
    unshown,
  }
}
