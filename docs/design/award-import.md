# Design: importing awards (LOOT-005)

Status: design for review, 2026-10-30. Nothing is built. The proposals in GitHub issue #165 were approved by the maintainer ("As proposed", 2026-10-27). The loot owner approved the spreadsheet columns on 2026-10-30; the maintainer's approval of them is pending. The importer itself is planned for 2026-12-22. This document doesn't change any code or rules: section 9 lists the rules changes a later importer needs.

## Why

- **The December 9 fallback.** If the app can't be used to record loot on the first raid night, leaders write the night's awards in a spreadsheet, and a later upload brings them into the app (`docs/ROADMAP.md`, "First-raid loot"). Leaders need the spreadsheet's columns before that night.
- **The addon later.** Once the loot master's addon exists (ADDON-002), it exports a pasted awards string, and the same importer reads it.
- **History must stay honest.** An award typed into a spreadsheet on December 9 and uploaded a week later must still read as decided on December 9, by the people who decided it. It must not look like a decision made at upload time.

| Question | Answer |
| --- | --- |
| Who is it for? | Guild and Raid Leaders, the only roles the rules let write awards. The loot owner decides the formats. |
| What can they do afterward? | Bring a night's awards into the app from a spreadsheet, later from the addon, after a preview that shows what will be saved and what's wrong. |
| What must not break? | Award snapshots stay immutable. Awards are never deleted. Each award is written with its Log entry in one batch. The raid date stays apart from the upload time. Recipients are roster ids. Record loot keeps working without any import or lookup. No real names or exports in this public repository. |
| What evidence shows it works? | For this document: the maintainer and loot owner approve it on #165. For the importer later: unit tests built from the worked examples in section 6, rules tests for every change in section 9, and a dry run with an invented spreadsheet on the emulators. |

## 1. Inputs, in order

| Order | Input | Status | How it arrives |
| --- | --- | --- | --- |
| 1 | **The guild's spreadsheet** | Columns agreed (section 2). This is the December 9 fallback and the only input the guild controls. | Paste the cells copied from the sheet, or pick a `.csv` file. |
| 2 | **The addon's awards string** | The format is drafted (section 7); confirm after launch, when it can be tested in the game. | Paste only. |
| 3 | **An RCLootCouncil-style CSV export** | Confirm after launch, and only if the guild uses that addon on Forever (section 8). | Pick a `.csv` file. |

**Paste or file.** Every input can be pasted. A CSV can also be picked as a file. Either way the browser reads the text itself. Nothing is uploaded to Cloud Storage, and the text is never stored, only the awards that come out of it.

**The unit of an import** (#165 decision 2) is one paste or one file. It may hold several nights, raids and bosses. The app stores no session or raid id: an award keeps its raid date and its "dungeon · boss" text, as Record loot does today (`encounterOf` in `src/features/loot/manualAward.ts`). Each row's source id (section 6) is the only link back to where it came from.

## 2. The spreadsheet

One row per item handed out. If two copies go to one person, that's two rows. The first row holds these headers, in this order:

| Column | Required | What to write |
| --- | --- | --- |
| Raid date | Yes | The date the raid **started**, Eastern time, written `2026-12-09`. Use the start date even if the item dropped after midnight. |
| Character | Yes | Who received it, spelled as on the roster: first name and surname. |
| Item | Yes | The item's name as the game shows it. |
| Item ID | No | The number in the item's Wowhead link. |
| Dungeon or raid | No | The place. |
| Boss | No | The boss that dropped it. |
| Decided by | Yes | `Roll`, `Council` or `Other`. Rolls until priorities are adopted. |
| Note | No | Anything worth keeping. |
| Recorded by | No | The leader who wrote the row. |

**Disenchanted and banked items.** Write `Disenchant` or `Guild bank` in Character. The preview lists those rows as Skipped, because the app has no award without a recipient yet (section 10). They stay in the sheet as the night's record.

**Reading the text.**
- **Two ways in.** Text copied from Google Sheets or Excel arrives tab-separated; a downloaded `.csv` is comma-separated. The reader tells them apart from the header line.
- **Quoting and encoding.** Quoted fields follow RFC 4180: a comma, a tab or a line break inside quotes is text, and `""` is one quote. A UTF-8 byte order mark is dropped.
- **Headers.** They match ignoring case and surrounding spaces. A missing required column, an unknown column or a repeated column refuses the whole import and names the columns. Blank rows are ignored.
- **Spaces.** Leading and trailing spaces are trimmed from every cell.

**Advice for the sheet.** Format the Raid date column as plain text, so the sheet doesn't turn `2026-12-09` into `12/9/2026`. Upload before the guild starts the next loot phase: until the rules change in section 9, the app only accepts awards into the current phase.

A sample with invented names is in [`award-import-samples/spreadsheet.csv`](award-import-samples/spreadsheet.csv).

## 3. Row to award

Each row becomes a **manual award**: the same fields Record loot writes (`manualAwardCreateFields` in `src/shared/game/lootAudit.ts`), checked by the same rules (`validManualAward` in `firestore.rules`), plus the import fields of section 4. A row with any problem below is an Error row and is never saved. The error text is what the preview shows, worded like Record loot's own messages.

| Award field | From | Check | Error text |
| --- | --- | --- | --- |
| `recipientId` | Character, matched to one roster character (below) | A match, or the leader's pick in the preview | (Unmatched, not an error) "No roster character is called *name*. Pick one." or "Two roster characters are called *name*. Pick one." |
| `recipient` | **The roster character's current `name`**, not the typed text. The rules require it. | | |
| `item` | Item | 1 to 120 characters | "Enter the item." / "The item can be up to 120 characters." |
| `encounter` | Dungeon or raid, and Boss, joined as "dungeon · boss" | 120 characters together. The dungeon has no "·". | "The dungeon and boss can be up to 120 characters together." / "The dungeon's name cannot contain “·”." |
| `awardedAt` | Raid date | A real calendar date written `YYYY-MM-DD`, not after the upload day. **Never filled in with today's date.** | "Write the raid date as 2026-12-09." / "The raid date is in the future." |
| `decision` | Decided by | `Roll`, `Council` or `Other`, any case | "Write Roll, Council or Other in Decided by." |
| `awardNote` | Note | Up to 500 characters | "The note can be up to 500 characters." |
| `phaseNo` | Today: the current phase. After the section 9 change: the phase the raid date falls in (RAID-019, PR #177, gives phases start dates). | Today: the current phase only | Once phases have start dates: "This raid date is before the current phase started. It can be imported when saving into a finished phase is allowed." |
| `itemId` (new) | Item ID | A whole number from 1 to 100,000,000 (`validGameId`) | "The item ID must be a whole number." |
| `recordedBy` (new) | Recorded by | Up to 60 characters | "Recorded by can be up to 60 characters." |

**Matching a character** follows the addon's rule (`exchange-v0` section 2), so the spreadsheet and the addon agree:
- **Full name only.** Compare first name plus surname after trimming, collapsing spaces and lowercasing ASCII letters only. Never match on the first name alone. A roster entry with no surname matches nothing, so the leader picks.
- **No guessing on a tie.** Two roster entries with the same full name match nobody, as the app's `makeWho` does.
- **The pick is remembered** for that row's source id, so uploading the sheet again doesn't ask again.

**An unknown item** is saved as typed (#165 decision 9). An Item ID helps duplicate checks. It isn't looked up, because Record loot works without Wowhead.

## 4. Provenance (#165 decision 4)

The rules stamp `createdBy` and `createdAt` with whoever saves and when (`validManualAward`). An import would therefore read "By *uploader* · Award · *upload time*" in the Log (`src/features/loot/AuditLogModal.tsx`). That's true, but it's not the decision.

- **`awardedAt` stays the raid night.** The Log already files award entries under it (`src/features/loot/entryDate.ts`).
- **The award stores where it came from:**
  - `sourceKind` (`sheet` or `addon`);
  - `sourceId` (section 6);
  - `recordedBy` (sheet only), when the row has one.
- **The Log and the award both say so**, for example: "Imported from the spreadsheet by *uploader* · decided 2026-12-09 · recorded by *name*."
- `createdBy` and `createdAt` keep meaning who saved it and when, as they do now.

These are new fields, so the rules must change (section 9).

## 5. Snapshots (#165 decision 5)

**Imports are manual awards: no `priorityId` and no snapshot.**
- **Why:** a snapshot is the candidate order and council note at the moment of the decision, and the rules require it to equal the priority as it stands when the award is written. An import a week later would freeze an order that didn't exist that night.
- **A priority named in the source** (the addon string's `priority`) is shown in the preview and stored as reference text, `sourcePriority`. It never marks a line.
- **Completion** still counts the award by item name and phase, as it does for every manual award (`docs/design/audit-first-loot.md`).

This differs from the addon draft (`exchange-v0` section 6.3), which fills the snapshot from the app's own priority. That draft must be changed to match before the addon is built.

## 6. Ids and duplicates (#165 decision 6)

**Every imported row has a source id, and the award's document id is that source id.** Writing the same row twice therefore hits an existing document, and the rules refuse it: a write to an existing award is an update, and an update has to be a valid audited edit. A rules test will pin this when the importer is built.

- **Addon rows:** `addon-` plus the award's own id (`exchange-v0` section 6.1). The addon makes ids that are unique for good.
- **Spreadsheet rows:**
  - **The id:** `sheet-`, then the first 20 hex digits of the SHA-256 of `raid date|character|item|item id` (each normalized as in section 3), then `-`, then *n*.
  - ***n* counts copies:** it counts the identical keys up to and including this row in the same paste or file (1, 2, …). Two real copies to one person on one night, written as two rows, get `-1` and `-2`.
  - **The same sheet uploaded again** gives the same ids, so every row shows as already imported.
  - **Note and Recorded by aren't in the key**, so editing them after an import doesn't make a new award. The preview says the note differs, and an import never changes a saved award. The rules allow a leader to edit a note (`awardEditFields`), but the app has no button for it yet.
  - **Uploading only part of a sheet** can give a second copy *n* = 1. It then shows "already imported", and the leader can choose "It's another copy", which saves it with the next free *n*.

**The existing look-alike test** (`possibleDuplicate` in `manualAward.ts`) still runs on every row that has no id match: same character, same item name, raid dates within one day, not removed. It only warns, because two copies of an item can truly drop to one person on one night.

**Rows are also compared with each other.** If the same text is pasted twice into one import, every row has a twin. The second of each pair is flagged as a Possible duplicate and unticked.

### Worked examples (fixtures for the importer's unit tests)

The roster has Mirelle Dunmore and Jorren Ashvale, both with surnames, and two entries called Garrick Vole. The app already holds the award shown in the second column.

| Case | Already in the app | Rows in this import | Expected |
| --- | --- | --- | --- |
| 1. New | Nothing | `2026-12-09, Jorren Ashvale, Example Helm, , Example Keep, First Boss, Roll` | New |
| 2. Same sheet twice | Case 1 saved from this sheet | The same row | Duplicate ("already imported") |
| 3. Two real copies | Nothing | `2026-12-09, Mirelle Dunmore, Example Band, 900002, …, Council` and the same with `Roll` | Both New: `-1` and `-2` |
| 4. Uploaded twice by two leaders | Leader A saved case 1 a minute ago | Leader B uploads the same row | Duplicate. If both click Save at once, one write wins and the other is refused and listed as already imported. |
| 5. Typed by hand, then imported | Record loot award: Jorren Ashvale, Example Helm, 2026-12-09 | Case 1's row | Possible duplicate (unticked): Skip, or "It's another copy" |
| 6. Spreadsheet and addon string for one night | An addon award: Jorren Ashvale, Example Helm, 2026-12-09 | Case 1's row | Possible duplicate |
| 7. Two loot masters (a 20- then a 10-player raid) | Nothing | Two different rows for different drops | Both New |
| 8. Same text pasted twice in one import | Nothing | Case 1's row, twice | First New, second Possible duplicate (unticked) |
| 9. Ambiguous name | Nothing | `…, Garrick Vole, …` | Unmatched: two roster characters have that name |
| 10. First name only | Nothing | `…, Mirelle, …` | Unmatched: never matched on a first name |
| 11. Bad date | Nothing | `12/9/2026, Jorren Ashvale, …` | Error: "Write the raid date as 2026-12-09." |
| 12. Disenchanted | Nothing | `…, Disenchant, Example Cloak, …` | Skipped |
| 13. Note changed after import | Case 1 saved with no note | Case 1's row with a note | Duplicate, "the note differs" |

## 7. The preview and saving (#165 decisions 7 and 8)

**Nothing is written before an explicit confirm.** The preview lists every row:

```
Import awards                                         12 rows read from the paste

  [x] New                 Row 2  Jorren Ashvale        Example Helm      2026-12-09  Roll     Phase 1
  [x] New                 Row 3  Mirelle Dunmore       Example Band      2026-12-09  Council  Phase 1
  [x] New                 Row 4  Mirelle Dunmore       Example Band      2026-12-09  Roll     Phase 1   second copy
  [ ] Possible duplicate  Row 5  Jorren Ashvale        Example Ring      2026-12-09  Roll     Phase 1   Recorded by hand on 2026-12-09 [Skip] [It's another copy]
  [ ] Unmatched           Row 6  "Garrick Vole"  →  [ pick a character ▾ ]          2026-12-09  Roll   two roster characters have that name
  --- Skipped             Row 7  Disenchant            Example Cloak                not recorded in the app yet
  --- Error               Row 8  Jorren Ashvale        Example Boots     12/9/2026        Write the raid date as 2026-12-09.
  --- Duplicate           Row 9  Mirelle Dunmore       Example Gloves    2026-12-09        already imported

                                                [Cancel]  [Save 3 awards]
```

- **Each row shows** its category, the row number, the source text beside the roster character it resolved to, the item, the raid date it will be saved under, how it was decided, the note, the phase, and why it's flagged.
- **What starts ticked:**
  - New rows start ticked.
  - Possible duplicate and Unmatched rows start unticked until a leader resolves them.
  - Error, Skipped, Duplicate and Stale rows can't be ticked.
- **The leader confirms once.** A dialog repeats the counts ("Save 3 awards; 5 rows will not be saved"), then the rows are saved one at a time.
- **Each saved row is one batch:** the award plus its `award_<id>_1` Log entry. A row the rules refuse never sinks the others, and a retry is safe because the ids are fixed.
- **The size is fine.** One award per batch is far inside the measured batch limits, and the entry's field list stays inside the rules' cap of 20 (section 9).
- **The result lists** what was saved, skipped, already imported and refused, with the reason for each refusal.

## 8. Other inputs (confirm after launch)

**The addon's awards string.**
- **Its format is drafted in the addon sandbox's `exchange-v0` specification.** That covers the envelope, the checksum, the errors in plain words, the award rows, and the importer's preview categories: Error, Conflict, Duplicate, Stale, Changed, Possible duplicate, Unmatched, New.
- **This importer takes it with two changes:**
  - It follows section 5: no snapshots.
  - Its pseudo recipients wait for section 10.
- **A sample** from the draft's test files is in [`award-import-samples/awards-string.txt`](award-import-samples/awards-string.txt). It's one line, and all its names are invented.
- **Proposed for the backlog:** ADDON-001 owns the string's format, and the draft moves into this repository with the addon work. LOOT-005 owns the importer and this document.

**An RCLootCouncil-style CSV.**
- **The format is from memory and unverified:** one row per award, with player, date, time, item name and id, response, instance, boss and note.
- **There's no sample** until it's checked against the live addon on Forever, and only if the guild uses that addon. No code from RCLootCouncil (GPL-3.0) may be copied.
- **Open question:** its "response" column describes what the player asked for (need, greed and so on), not how the item was decided. Proposal: the leader picks one `decision` for the whole file in the preview, Council by default.

## 9. Rules and client changes the importer needs

None of these are made here. Each needs its own commit and rules tests when the importer is built.

1. **New award fields:** `sourceKind`, `sourceId`, `sourcePriority`, `recordedBy` and `itemId`, all optional for a manual award. When `sourceId` is present, the document id must equal it, and it starts with `sheet-` or `addon-`.
2. **The Log entry's field list grows.** It lists the manual award's 8 fields plus the import fields it has, at most 13. That's inside the cap of 20 changed fields per entry (`validAuditEntry` in `firestore.rules`).
3. **Expression headroom.** A request may use 1,000 expressions, and the widest award entry has about 60 to spare (the comment above the award fields in `firestore.rules`). The new fields must re-run the widest tests in `roster-ids.test.ts`, `loot-tables.test.ts` and `batch-budget.test.ts`.
4. **Saving into a finished phase.** Today an award's `phaseNo` must be the current phase. The loot owner decided on 2026-10-19 that imports may go into a finished phase. Proposal: an award with a `sourceKind` may name any phase up to the current one, and its Log entry says it was imported.
5. **A rules test pins that a second import of a row is refused.** That's an update to an existing document, not a create.
6. **The Log and the award display show provenance** (section 4).
7. **Later, not in the first importer:**
   - pseudo recipients (`pseudo`, no `recipientId`) for disenchanted and banked items;
   - the addon's delivery fields;
   - "Copy for addon".

## 10. What stays manual (#165 decision 9)

- **Unknown characters.** A character the roster doesn't have stays Unmatched until a leader picks one. The import never creates a roster character.
- **Disenchanted and banked items** stay manual until pseudo recipients exist.
- **Items not yet received.** The addon tracks them, but the app doesn't yet.
- **Correcting an imported award** uses Fix receipt (LOOT-004), like any other award: move it to someone else, or remove it with a reason.
- **Skipped rows.** Any row the preview skipped, or a leader left unticked, can be recorded with Record loot.

## 11. Before December 9

- **Leaders get the columns in section 2** from the loot owner, with a link to the message recorded on #165. That's the last item on #165's acceptance list.
- **Record loot works today.** Leaders who are comfortable entering awards by hand after the raid don't need the spreadsheet at all.

## Open questions

1. The maintainer's approval of the columns, `recordedBy`, and saving into a finished phase.
2. Whether the guild will use RCLootCouncil on Forever at all, and how its "response" maps to `decision`.
3. Whether `sourcePriority` is worth a field, or the preview showing it is enough.
