import type { PlayerRecord } from '../../guildApi'
import type { RaidSignup } from '../../raidSignups'
import { classAccent, classText } from '../../shared/game/classes'
import type { RaidInvitation } from '../../shared/raids/planning'
import { ClassAvatar } from '../../shared/ui/ClassAvatar'
import { RoleIcon } from '../../shared/ui/RolePill'
import { signupBoard, type BoardEntry } from './signupGroups'
import './SignupBoard.css'

function Entry({ entry }: { entry: BoardEntry }) {
  return <li className={`signup-board-entry ${classAccent(entry.character.className)}`}>
    <ClassAvatar player={entry.character} />
    <span className="signup-board-name"><strong>{entry.character.name}</strong>{entry.mainName && <small>alt of {entry.mainName}</small>}</span>
  </li>
}

/**
 * The Signups tab (RAID-018): who is coming, by role and class, with the other responses below. Read-only, and it reads only what the opened row already has (the row's
 * responses and the raid's invitation list from its working roster), so showing it starts no listener.
 */
export function SignupBoard({ invitations, characters, responses }: { invitations: RaidInvitation[]; characters: PlayerRecord[]; responses: RaidSignup[] }) {
  const board = signupBoard(responses, invitations, characters)
  return <div className="signup-board">
    <p className="signup-board-total"><strong>{board.accepted}</strong> accepted · {board.invited} invited</p>
    <div className="signup-board-columns">
      {board.columns.map((column) => <section key={column.role} className={`signup-board-column role-${column.role.toLowerCase()}`}>
        <h4><RoleIcon role={column.role} size={14} />{column.label}<span className="signup-board-count">{column.count}</span></h4>
        {column.classes.length
          ? column.classes.map((group) => <div key={group.className} className="signup-board-class">
            <h5><span className={classText(group.className)}>{group.className}</span><span className="signup-board-count">{group.entries.length}</span></h5>
            <ul>{group.entries.map((entry) => <Entry key={entry.uid} entry={entry} />)}</ul>
          </div>)
          : <p className="signup-board-none">No one yet</p>}
      </section>)}
    </div>
    <div className="signup-board-statuses">
      {board.sections.map((section) => <section key={section.key} className={`signup-board-status response-${section.key}`}>
        <h4>{section.label}<span className="signup-board-count">{section.entries.length}</span></h4>
        {section.entries.length ? <ul>{section.entries.map((entry) => <Entry key={entry.uid} entry={entry} />)}</ul> : <p className="signup-board-none">None</p>}
      </section>)}
    </div>
    {board.unshown > 0 && <p className="signup-board-none">{board.unshown === 1 ? '1 response or invitation is' : `${board.unshown} responses or invitations are`} not shown: the character is no longer on the roster or has no raid role.</p>}
  </div>
}
