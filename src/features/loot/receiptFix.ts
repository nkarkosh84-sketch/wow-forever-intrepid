import type { AwardChanges } from '../../guildApi'

// Fixing a receipt (LOOT-004): a leader unlocks an item, and a received line has an x next to it. The x moves the award to someone else or, for a mistake,
// removes it. Pure, so Node tests it; the dialog only lays it out. The rules have the last word (validAwardEdit): the recipient has to be a roster
// character whose name the award carries, and a removal needs a reason. The candidate order and council note saved with the award never change.
export const FIX_REASON_MAX = 300

type Roster = { player: (id: string) => { id: string; name: string } | undefined }
type Receipt = { recipient: string; recipientId?: string }

/** What moving the receipt to this roster character changes (the name and the id together), or why it cannot be done. */
export function moveChanges(receipt: Receipt, toId: string, roster: Roster): { changes: AwardChanges; problem?: string } {
  const player = roster.player(toId)
  if (!player) return { changes: {}, problem: 'Choose a character from the roster.' }
  // The same person: an award with an id goes by the id (a renamed character is still the same person), an older one by the name it carries.
  if (receipt.recipientId !== undefined ? receipt.recipientId === player.id : receipt.recipient === player.name) return { changes: {}, problem: 'That is who has it already.' }
  return { changes: { recipient: player.name, recipientId: player.id } }
}

/** Whether the award changed since the dialog showed it (another leader fixed it, or it was removed): the fix is then not made on what the leader decided from. */
export function receiptChanged(shown: { rev?: number; status?: unknown }, current: { rev?: number; status?: unknown }): boolean {
  return (shown.rev ?? 0) !== (current.rev ?? 0) || shown.status !== current.status
}

/** Why a reason cannot be used, or undefined when it can. Removing a receipt needs one; moving one does not. */
export function reasonProblem(reason: string, required: boolean): string | undefined {
  const trimmed = reason.trim()
  if (required && !trimmed) return 'Give a reason for removing the receipt.'
  if (trimmed.length > FIX_REASON_MAX) return `The reason can be up to ${FIX_REASON_MAX} characters.`
  return undefined
}
