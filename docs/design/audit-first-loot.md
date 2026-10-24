# Design: audit-first loot (issue A2)

Status: stage 1 and stage 3 of the rules are implemented. Awards can be edited only with an audit entry, a new award and every priority create, edit and delete need one too (`validPriorityAward`, `validManualAward`, `validPriorityCreate`, `validPriorityEdit`, `validPriorityDelete`), and audit entries are append-only. The client side (the audited helpers, the audit log screen inside Loot priorities, and fixing a mistaken receipt from the item on Loot priorities, LOOT-004) is built.

Rollout follows [the roadmap](../ROADMAP.md): target recording loot from the first raid on December 9, 2026, independently of priority listings; adopt priorities around December 15; target full audits and all remaining functionality by December 22. If recording is not ready for December 9, use need-before-greed rolls and a spreadsheet, followed by a validated upload. That upload and priority-independent recording path still need implementation; do not fabricate a candidate-order or council-note snapshot for an award decided by rolls. Preserve the actual raid/award date separately from later entry/audit timestamps.

## What it must do

- Guild Leaders and Raid Leaders can correct awards and priorities after the fact.
- Every change is recorded in a log nobody can edit or delete from the app; every guild member can read it.
- The as-awarded snapshot (candidate order and council note at decision time) never changes.
- Awards are never deleted; "removing" one is an edit that marks it removed, with a reason.
- A modified browser cannot skip the log: the rules enforce it.

## Data model

**`awards/{awardId}`** keeps its fields and gains:

| Field | Meaning |
| --- | --- |
| `rev` | integer, 1 on create, +1 on every edit |
| `createdBy`, `createdAt` | uid and server time of the award; never change |
| `updatedBy`, `updatedAt` | uid and server time of the last edit |
| `status` | `active` (default) or `removed`; `removedReason` is required when removed |
| `recipientId` | optional roster id (filled in by issue A3; included now so the allowed keys are written once) |

`prioritySnapshot` and `councilNoteSnapshot` are immutable after create. Old awards without these fields still load and can be edited; the first edit sets `rev` to 1 and they show as "recorder unknown".

**`priorities`** (`lootPriorities/{id}`) gain `rev`, `updatedBy`, `updatedAt` and are audited the same way, including reorders and deletes.

**`auditLog/{entryId}`** (new, per guild), entry id = `{type}_{targetId}_{rev}` (for example `award_Xk3f_2`):

| Field | Meaning |
| --- | --- |
| `at`, `by`, `byName` | server time, uid, display name at the time |
| `targetType`, `targetId`, `rev` | `award` or `priority`, which document, which revision; `phase` (target id `settings`) for starting or reopening a loot phase; `raid` for raid edits |
| `action` | `create`, `edit`, `remove`, `reorder`, `delete` |
| `item` | the item name as it was before the change (as created, for a create), so the log reads without joins |
| `changed` | list of changed field names |
| `before`, `after` | the old and new values of the changed fields; a create has no `before`, a delete no `after` |
| `reason` | optional text, up to 300 characters (required for `remove`) |

The id comes from the target type, the target and its revision, so it needs no random ids, cannot be reused, and the rules can compute it. The type keeps an award and a priority that share an id from sharing entry ids (otherwise a leader could permanently block corrections to an award by filing a priority entry under its next id). The revision has to be a whole number.

## Manual awards (LOOT-002)

Priorities are not adopted until around December 15, so the first raid is decided by need-before-greed rolls and the council. A **manual award** records such a decision without a priority list. It is an award with no `priorityId`, no `prioritySnapshot` and no `councilNoteSnapshot`: nothing pretends that a candidate order existed, and the snapshot rule is not weakened for awards that have one.

| Field | Meaning |
| --- | --- |
| `item`, `encounter`, `awardNote` | as for any award; `encounter` and `awardNote` may be empty text |
| `recipientId` | the roster character's id (required) |
| `recipient` | that character's name as the roster has it when the award is made; a later rename does not rewrite the award |
| `awardedAt` | the raid date, `YYYY-MM-DD`. It is kept apart from `createdAt`, the time the award was entered, so a spreadsheet upload or a late entry never looks like a decision made later |
| `decision` | how it was decided: `roll`, `council` or `other` |
| `phaseNo` | the loot phase it belongs to: a whole number from 0 to 30 (see "Loot phases" below). Required, so a phase can never be guessed later |
| `rev`, `createdBy`, `createdAt` | 1, the uid of the leader, and server time |

The create rule (`validManualAward`) applies when the document has no `priorityId`. Guild and Raid Leaders may write it; it allows exactly the fields above (no status, no `updatedBy`/`updatedAt`: a new award is active), checks their types and sizes, requires the roster character to exist with that name, and requires the audit entry (type `award`, revision 1) in the same batch. The entry's own rule is unchanged: it has to describe the new document truthfully. `decision` is part of what an entry may list and must log, and it can be corrected later like any other field (with an entry); the snapshot fields can never be added to a manual award afterwards. A document with a `priorityId` follows the snapshot rule exactly as before.

Not changed here: the date check, which tests the format only (`2026-13-45` passes, as it does for every other date in the rules). The Guild Leader exception in the create rule is gone (stage 3): a Guild Leader's award follows the same rules as a Raid Leader's.

## Loot phases

The loot lists are kept per phase (a priority and an award carry `phaseNo`; none means phase 0). The current phase's number is the length of `phaseHistory` in the settings document, the names of the finished phases, oldest first. `validGuildSettings` accepts that list only when it is unchanged, grows by one name (the name the current phase had, with `currentPhase` becoming the new name) or shrinks by one (the last name becomes `currentPhase` again and the phase being left becomes `nextPhase`), at most 30 names, so a Guild Leader cannot quietly move the phase back or rewrite its history. The first save of a guild's settings (no document stored yet) may close only "Launch prep", the name the app shows until then. `phaseNo` (0 to 30) is checked wherever an award is created or edited, is part of what an award entry may list and must log, and can be corrected like any other field, with an entry (a correction cannot take it away). The rule that a closed phase cannot be written to comes with the priority rules in stage 3.

**Starting or reopening a phase is logged.** The settings document carries `phaseRev`, how many times a phase has been started or reopened. A save that changes `phaseHistory` has to carry `phaseRev` one higher than before and its entry `phase_settings_{phaseRev}` (type `phase`, action `start` or `reopen`) in the same batch; a save that leaves the history alone, a rename of the current phase included, leaves `phaseRev` alone and needs none. The entry lists the phase fields (`currentPhase`, `nextPhase`, `phaseHistory`) that differ between what was stored and what the batch stores, with their old and new values (nothing before, for a guild's first save), and its item is the new current phase's name. Other settings saved at the same time, such as the status label, are not part of the entry.

## Roster ids on priorities and awards (LOOT-003)

A priority's candidates are names, and a rename (a character request keeps the roster id and changes the name) used to break the match between a name on a list and a name on an award. Ids now sit beside the names, additively: nothing is required, so old documents stay valid and an app from before this change keeps working on every priority that has no ids.

- **Priority:** an optional `rankedIds`, a list as long as `rankedPlayers` (at most 60). Element `i` says what line `i` is: a roster character's id, `''` for an open note (an idea such as "any warlock who didn't get X", not a person) or `'!'` for a finished note. The names stay as the snapshot of what each line said when it was written. The rules check the shape only (a list, as long as the names, only checked when either list changes); they do not check the elements or that each id is on the roster, which would need a lookup per candidate when a request may make 20. Ids are only compared, never used as paths.
- **Award from a priority:** an optional `recipientId` and `prioritySnapshotIds`. `recipientId` must be a roster character whose name is `recipient` (one lookup, as for a manual award), so a character renamed since the priority was written still receives it under the name the roster has now. When an award carries either field, `prioritySnapshotIds` must equal the priority's `rankedIds` as they stand (absent equals absent), so the snapshot of the council's order covers the ids too; an award with neither (an app from before this change) skips that comparison. Neither field can be edited later except `recipientId` through an audited correction, and a correction that changes `recipient` or `recipientId` has to leave them naming the same roster character (one more lookup), so an old award can get its id but not a wrong one.
- **Who can receive:** a recipient on the list by name (as before), or a `recipientId` on a character line, or any roster character when the priority has an open note. A finished note adds no way in by id; a name that is on the list by text still counts by name, as it always did.
- **A receipt through a note:** the app writes, in one batch, the award (whose snapshot is the list as the council saw it, note included) and a priority edit that puts the winner on a character line at the note's place and moves the note down, with an entry for each. The rules do not force the pair; the award's snapshot is read from the priority as it was before the batch.
- **Audit entries** list `rankedIds` for a priority and `recipientId` and `prioritySnapshotIds` for an award like any other field. An entry labelled `reorder` may list `rankedPlayers` and `rankedIds` and nothing else, and what it says before and after has to be the same lines in another order (as sets). The field checks of awards and priorities are written out like the table fields because a function call per field took the widest entry past the 1,000 expressions a request may use; the headroom is measured and written down above `awardFieldsLogged`.
- **Budgets:** an award that carries a recipient id looks the recipient up, so 13 awards to one character fit in one batch (14 by name) and 7 to different characters (8 are refused); a receipt through a note (an award and a priority edit) fits. The app records one award at a time.
- **An app from before this change** on a priority that has ids: it can award by name, and edit the note or hide the priority, but it cannot change the candidate list (the lists would no longer be as long as each other) or delete the priority (its entry does not list `rankedIds`) until it reloads. Every one of those fails closed.
- **Known gap** (pinned by tests): the rules cannot tell a reorder or a replacement of names from a change of a note's text, so an edit that changes names and leaves the ids alone is accepted when the lengths agree. Only an app that was open before this change does that. It can leave an open note where the list shows a person (any roster character can then receive through it), or leave a removed player's id on the list (they can still receive by id). Both are visible in the Log, which shows the true before and after, and a leader can already record an award to any roster character as a manual award; the fix is to reload the app after the release.

## Rules

- `auditLog`: read for every guild role; create only by a Guild or Raid Leader with `by == request.auth.uid`, `at == request.time`, an allowed key list and size caps; **update and delete are denied for everyone.**
- Awards: an update requires the audit entry in the same batch, checked with `getAfter()` (the entry must name this award and the next revision). The entry's own rule requires the award in the same batch to carry that revision, so each needs the other. Update also requires `rev == old rev + 1`, the immutable fields unchanged, and a reason when status becomes `removed`. Delete stays denied.
- The entry has to describe the change truthfully, and the rules check it against the stored document: the fields in `changed` are exactly the fields that differ, `before` and `after` hold the stored old and new values, `item` is the award's item, a `remove` is a change to `status: removed` with the same reason the award carries, and a `reorder` changes only `rankedPlayers`.
- Priorities: a create, edit or delete is accepted only with its entry (stage 3). A priority carries `rev`, `updatedBy` and `updatedAt` (stamped by the rules), its fields are bounded (item up to 120 characters, encounter 120, at most 60 candidates, note 500, item, dungeon and creature ids whole numbers up to 100 million), and it can be written only in the current loot phase or the next one; its phase and the priority it was carried from can never change. A field that is not changed is not checked again, so a priority written before these limits can still be reordered. A priority can be taken **off the list without losing it**: an edit may set `hidden` to `true` (never anything else, and never on creation) and take it away again; the priority keeps its candidates and the awards recorded from it, and no award can be made from one that is hidden. Entry ids are `{type}_{id}_{rev}` and an entry can never be written twice, so **the id of a deleted priority cannot be created again**: the app gives every new priority a fresh id. For the same reason the entry a write needs has to be **written in that very batch** (the rules compare its `at`, the server time of the request, with the request's time): an entry left from an earlier life of an id never stands in for a new one, which would otherwise let a priority be created, changed or deleted with no new entry.
- The Guild Leader exception in the award create rule is gone: every new award has exactly the expected fields, `rev` 1, `createdBy` and `createdAt` set by the rules, the current phase's number, a snapshot equal to the priority it copies (and that priority is in the current phase), and its entry in the same batch.
- Loot tables (the guild's own changes to the drop lists of Browse drops, collection `lootTables`) are written like priorities: only with their audit entry (target type `table`, actions `create` and `edit`) in the same batch, with `rev`, `updatedBy` and `updatedAt` stamped by the rules and the entry written in the same request (`writtenNow`). **They belong to a loot phase:** a document carries `phaseNo` and means "from this phase on, until a later phase's document says otherwise", so the app works out the lists of phase N from the built-in captures and every document of phase N or earlier. Like a priority, a document can be created in the current or the next phase and edited only while its phase is the current or the next one, and `phaseNo` never changes, so a finished phase's lists are a record. There are four kinds of document, with ids that carry the phase: a custom zone (`z{zone}_{phase}`, number 50 million or more so it cannot clash with the game's own), a presence document for a zone of the built-in captures (same id form, only `removed`), a creature (`s{zone}_{key}_{phase}`: `itemIds` added in the phase, `hiddenItemIds` taken off from it, which may not overlap, and optionally name, kind, number and place), and the document of a phase (`p{phase}`, type `phase`: only `follows`, the number of an earlier phase whose drop lists this phase has with its own documents on top, or no `follows` for a phase that follows nothing). `follows` has to be a whole number from 0 to below the phase's own number, so following never loops; the document is created and edited like the others (current or next phase, entry in the same batch, never deleted: taking the link away is an edit that removes `follows`). **A document says only what its phase changes** (optional fields appear only when that phase sets them). **A table is never deleted**, for the same reason a priority id is not reused: taking one away is an edit that sets `removed` to true, bringing it back sets it to false, and an edit can take the field away. Decision 2a is enforced here: a creature of the captures (key `npc{number}`) and the zone-wide list can never carry `removed: true`; only a whole built-in zone can be left out of a phase. The rules can check only the sizes of the lists (80 items added and 80 taken off per document), not each entry in a list, so the app reads them tolerantly. The 13 per-field checks of the entry live in one function because the entry rule is close to the 1000 expressions a request may use. 16 table documents with their entries fit in a batch on the emulator (17 with no settings stored); the app sends at most 10.
- What the rules still cannot prove: that a leader's `byName` is a real name (it is the member's stored display name, which a Guild Leader can change), and that `reorder` is a pure reordering (a candidate added or removed can be filed as a reorder; the before and after lists show it). The uid in `by` is always the real actor.

Each audited write is two documents in one atomic batch. The rules do a handful of document lookups per write, and a batch is limited to 20: on the emulator 18 audited edits fit in one batch and 19 do not. A bulk import has to chunk its batches. Measured on the emulator with the settings document stored (the phase rules read it): 16 audited priority creates, edits or deletes fit in one batch, 14 awards from one priority, 5 awards each from a different priority (`tests/rules/batch-budget.test.ts` pins these). The app sends at most 10 priority writes in a batch and records one award at a time.

## Client

- `guildApi.ts` gets audited helpers (`createPriorities`, `editPriority`, `deletePriorities`, `setPrioritiesHidden`, `recordAward`, `correctAward`, `removeAward`, `changePhase`) that build the batch; no other code writes these collections.
- **Fixing a receipt (LOOT-004)** happens on the item, not in the Log. A Guild or Raid Leader unlocks the item (the lock beside COUNCIL ORDER) and an x appears next to each RECEIVED line of a phase that is not closed (the rules allow nobody else to write it). It opens **Fix receipt** (`features/loot/ReceiptFixModal.tsx`): **move** the receipt to someone else (a roster character; the name and id are written together; a reason is optional), or **remove** it because it should not have been recorded (a reason is required; the award is marked `removed`). Each is one batch of the award's next revision and one entry (`award_{id}_{rev}`, action `edit` or `remove`) whose `before` and `after` say who had it and who has it now. The item, the priority, the date and the snapshot never change, so an award of the wrong item is removed and recorded again. An award from before the Log began has no revision, so its first fix is revision 1; its first row in the Log is rebuilt from the old values the entries keep (`awardAsRecorded`), so a fix never rewrites it. `listingProgress` says which award each received line stands on (`receipts`), so the x fixes the award the mark shows. There is no control to undo a removal: record the award again.
- **The Log is read-only.** It has no edit, delete, correct, remove or restore control: every change to an award reaches it as a new entry. The **Log** button on Loot priorities opens it for every role. It subscribes only while open (newest 100 entries, then "load more") so the global subscriptions and the read budget do not grow, and it also lists the awards recorded before the Log began. Its player filter finds a moved receipt under both people. (The design review's "removed awards are hidden by default" is not applied: the Log lists events, and the removal is one of them.)
- A removed award stops counting everywhere: completion of a list and the filters, the dashboard's "My loot", and the Awarded total in the header. (Reopening a phase still counts every award recorded in it, removed or not.)
- Order within one night: sort by `awardedAt`, then `createdAt`, then id.

## Rollout: expand, then client, then tighten

The rules are shipped in stages so nothing breaks while the client catches up:

1. **Stage 1, rules only (additive).** The `auditLog` collection and audited award edits are allowed. Creating an award and writing a priority still do not need an entry, so the current client keeps working and these rules can be deployed before any client change.
2. **Stage 2, client.** The client writes audited creates, edits, removals, reorders and deletes through the helpers in `guildApi.ts`, and the new History and Audit log screens.
3. **Stage 3, rules (tighten): done in the rules pull request "audited loot".** The rules require an entry for award create and for every priority write, constrain award create and the priority fields, and the Guild Leader exception is gone. An old cached client is refused after this stage until its page reloads.

- No migration: documents without the new fields keep working.
- Docs that say awards cannot be updated change in the same pull request as the rules (this one: `AGENTS.md`). The statements that award snapshots are immutable stay true.

## Plan (small pull requests, tests first)

1. Rules and tests: `auditLog`, audited award edits and truthful entries (stage 1), proven on the emulator before any client code.
2. Client helpers in `guildApi.ts` (shared file, own commit).
3. History edit and remove; priority audit.
4. Audit log tab.
5. Rules stage 3, then delete the local-preview import and update the remaining docs.

## Decisions from review

Answered by the guild leaders on the pull request that added this document:

1. Raid Leaders may edit awards too, not only Guild Leaders.
2. A reason is optional for edits and required only when removing an award.
3. Every priority reorder is one log entry.
4. Removed awards are hidden by default, with a toggle.
