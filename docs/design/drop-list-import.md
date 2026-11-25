# Design: drop lists from the game (LOOT-008)

Status: the maintainer approved #202 as proposed (2026-11-14). The addon side, the drop log and its `drops` string, merged in #203 (2026-11-14). The app import is `features/loot/dropImport.ts` and the Import a drop list panel of Edit the drop lists, reading with `shared/lib/exchangeString.ts` and `shared/game/dropsString.ts`.

This design covers:
- the import LOOT-008 still lists as remaining ("full capture-file import with validated preview"). It doesn't cover LOOT-008's other remaining item, moving or replacing an item.
- the addon side that feeds it: what the addon records in the game, and the `drops` string it exports.

The backlog mapping is decided ([section 12](#12-backlog-pull-requests-and-order)). Every name and number in the examples is invented.

## Why

- **The December 9 raids have no drop lists.** Barrow Deeps, Hyjal Summit and Onyxia unlock that night (`docs/ROADMAP.md`). `data/loot/` holds nine five-player dungeons from the beta and no raid.
  - **Zones.** Leaders add the three raid zones in Settings anyway, because a raid can only be scheduled in a listed zone.
  - **What's left is typing.** After each raid night, a leader types each boss and its items into **Edit the drop lists**, one boss and one paste at a time. For 8 bosses that's 8 creature forms and 8 pastes. Each paste is a list of item ids gathered from Wowhead.
- **The lists matter from about December 15.** That's when priorities start (`docs/ROADMAP.md`). A priority is made from an item in Browse drops, so an item that's not in the drop lists can't get a priority.
  - Record loot doesn't need the lists: the boss and item are free text there. The first raid night is recorded by hand either way.
- **The game knows some of it.** The client of whoever opens a corpse can read the creature the loot window belongs to, the items, the encounter that just ended and the instance. With rolls (group loot, or master loot's Request Roll), every client in the group learns the item and the encounter.
- **It's only part of a list.** One kill shows the 1 to 5 items that dropped, out of a boss's dozen or more, so observed lists fill over weeks, not in one night.
  - Whole tables on day one can only come from the game's own **Encounter Journal**, if it lists raid loot at level 60 ([section 3](#3-the-encounter-journal)), or from a capture typed in from Wowhead.
- **A community addon knows the dungeons.** DungeonJournal (folder `ForeverDungeonJournal`) lists boss loot for 35 five-player dungeons, and many players have it installed.
  - It has no raids yet: its Raids button says "coming soon".
  - It compiles fan sites and mixes Forever's drops with older Classic ones, so it's a hint, never a fact ([section 4](#4-dungeonjournal-hints)).

| Question | Answer |
| --- | --- |
| Who is it for? | Guild and Raid Leaders, who keep the drop lists. Loot masters, whose addon records what drops. |
| What can they do afterward? | After a raid night, paste one string from the addon, see every boss and item the app would add and why, answer what's unclear, and save it in one confirm. They no longer type each list. The same import reads a capture file made from Wowhead. |
| What must not break? | Every write is an audited `lootTables` document, except a new zone's suggested color, which goes to `settings/zoneColors` as Settings does. Nothing is ever deleted, and the bundled captures are never rewritten. Nothing a leader took out comes back unless a leader ticks it: an item, a creature, or a zone in a phase. No zone is created unless a Guild Leader asks for one. A retried import never makes a second zone or creature. Manual editing keeps working with no addon and no Wowhead. No player's name leaves the game in this string. Nothing derived from DungeonJournal enters this public repository. The VIEW AS preview never saves. |
| What evidence shows it works? | For this document: the loot owner's and maintainer's approval on the claim issue. For the code: unit tests built from the worked examples in [section 8](#8-worked-examples-fixtures-for-the-unit-tests), reference fixtures for the `drops` string, and an emulator dry run with an invented string. In the game: a dungeon run's string first, then the first raid night's. |

### December 9 and after

1. **Before December 9:**
   - Probes check the facts this design relies on ([section 12](#12-backlog-pull-requests-and-order)).
   - The drop log is installed on every loot master's client.
2. **December 9:** awards are recorded by hand (Record loot, or the spreadsheet fallback). The drop log records what drops.
3. **After the night:**
   - The loot master exports the `drops` string out of combat, or types `/reload` so the game saves the log.
   - A leader imports it, and the lists hold the night's drops by about December 12 to 15, ready for priorities.
4. **The weeks after:** each night adds what's new. Items never seen yet reach the lists by hand, by a Wowhead capture, or from the Encounter Journal if it lists raid loot.

## 1. Inputs

| Order | Input | How it arrives |
| --- | --- | --- |
| 1 | **The addon's drops string** (`IM1:drops:…`, [section 5](#5-the-drops-string)). It holds what the addon saw in the game, and any hints it read from the Encounter Journal or DungeonJournal, each marked by where it came from. | Paste. Several strings can be pasted at once. |
| 2 | **A capture file**, format 1, as in `data/loot/` and its README: a hand-made capture from Wowhead. | Paste the JSON, or pick the `.json` file. |

- **One preview for both.** The importer turns both inputs into the same candidate zones (a zone, its creatures, their items, and each item's evidence) and shows one preview.
- **What's kept.** As with the award import, the browser reads the text itself and never stores it. Only the documents the leader saves are kept.

## 2. What the addon records: the drop log

The drop log is a new addon module. It runs on every client that has the addon, and only inside a dungeon or raid (`IsInInstance()` says `party` or `raid`).

It keeps counts, not a history, and answers one question: in this instance, which creature or encounter dropped which items, and how often? Every handler runs in `pcall` with an error count, like the loot window code, so a failure never reaches the player mid-raid.

### 2.1 Where the facts come from

| Fact | From | Checked in the game? |
| --- | --- | --- |
| The instance: name, type, difficulty, size, instance id | `GetInstanceInfo()` at `ZONE_CHANGED_NEW_AREA` and `ENCOUNTER_START`. At `PLAYER_ENTERING_WORLD` the difficulty and size can still read 0. | Beta, in a dungeon. Not yet on live, not yet in a raid. |
| The loot method and threshold | `C_PartyInfo.GetLootMethod()`, `GetLootThreshold()`, kept per zone visit, so the evidence can explain a gap. | Beta. |
| The creature a loot window belongs to | `GetLootSourceInfo(slot)`, read at the first `LOOT_READY` (autoloot can empty the window before `LOOT_OPENED`). A `Creature-…` GUID carries the npc id in field 6. | Beta (286 windows). Live, 2026-11-12: one 5-player dungeon with group loot, 160 windows, 44 corpses. |
| The items | `GetLootSlotType`, `GetLootSlotInfo` (name, quality, and whether it's a quest item), `GetLootSlotLink` (the item id). Money and currency slots are ignored. | Beta. On live, only the player's own loot lines so far. The quest-item returns haven't been probed. |
| The boss | `ENCOUNTER_START` and `ENCOUNTER_END` (encounter id, name, success). During the fight, the npc ids of the `boss1` to `boss5` units when `INSTANCE_ENCOUNTER_ENGAGE_UNIT` fires, kept only when they aren't secret values. | Beta: encounter events at 3 kills. Live, 2026-11-12: 7 of 7 encounters won with their ids and names, but **the boss units gave nothing** in that dungeon (none read, none secret), so 2.2 step 2 matches the corpse to the rolls instead. Not yet in a raid. |
| Rolls | `START_LOOT_ROLL`: the item id from `GetLootRollItemLink`. Then `C_LootHistory.GetSortedDropsForEncounter(encounterId)`: only each drop's item id and the encounter id, never `rollInfos` or `winner`. | Beta: a client that never opened the boss corpse had the boss's item under its encounter id. Live, 2026-11-12: all 11 boss rolls were found in the loot history; the trash rolls were not, as expected. |
| A creature's name and class | The encounter name for a boss. For other creatures, the target or mouseover unit when its GUID is a creature and the name isn't secret, and `UnitClassification` (`rare`, `rareelite`). | Live, 2026-11-12: no creature name was recorded in one dungeon run. The drop log now counts the creatures it saw and the units it couldn't read (`unitsSeen`, `unitsSecret`), so the next run says why. |

### 2.2 How a loot window is classified

1. **One window per corpse.** Only the first window of a corpse counts. Later windows on the same corpse are hand-outs, skinning or pick-pocketing, never new drops. The last 200 corpses are kept as short hashes of their GUID (never the GUID itself) in the saved data, so a `/reload` between the kill and the hand-out doesn't count a corpse twice.
2. **A boss** is a creature whose npc id was a `boss1`–`boss5` unit of an encounter that ended in success. Its name is the unit's name (the encounter's name when there is one boss). The encounter id is kept.
   - **A matched boss (any loot method).** The live client gave no boss units in a dungeon, and group loot has no master looter, so the rolls decide. A corpse opened within 5 minutes of a won encounter is that encounter's boss when it holds an item the loot history filed under that win's rolls (the item and the encounter come from the game, so one match is sure). A rare never is.
   - **The order doesn't matter.** When another player opened the corpse first, the roll is filed before the window, and the corpse matches at once. When this client opened it first, the corpse waits up to 15 seconds for the loot history (the watcher asks 2 and 10 seconds after a roll starts) and only then counts as a creature on its own. The waiting corpse is kept in the saved data, so a `/reload` loses nothing.
   - **One drop, counted once.** The roll and the window of the same item in one kill count once, under the boss.
   - **Only its own items.** A boss learned this way takes only the items its own corpse held in that kill. The encounter may have more bosses, so its other rolls stay under the encounter until another corpse claims them.
3. **A guessed boss.**
   - **When it applies:** the boss units couldn't be read, or they were read but the corpse's npc isn't one of them; no corpse matched a roll (master loot has no rolls); and **this client is the master looter**, and the window has master-loot candidates and an item at or above the threshold. Then the first such corpse opened within 5 minutes of a successful `ENCOUNTER_END` in the same instance is that encounter's boss.
   - **Confirmation:** one guess never decides what an npc id is. It needs the same npc on 2 kills of that encounter, or a match with a bundled capture, the night string's bosses or DungeonJournal's npc id. Until then it stays "guessed".
   - **Surviving a `/reload`:** the last successful encounter (its id, name, time and instance) is kept in the saved data.
4. **A chest.** A `GameObject` window counts only inside the instance, with master-loot candidates, within 5 minutes after a successful encounter: it's that encounter's chest, and its items go to that boss. Every other `GameObject` (ore, herbs, lockboxes) and every other source type is ignored.
5. **A rare** is a creature whose classification was `rare` or `rareelite`.
6. **Trash** is every other creature. Trash creatures are kept as creatures, as the bundled captures do. The preview decides what goes to the zone-wide list ([section 7](#7-the-preview-and-saving)).
7. **A roll with no corpse** (the item and encounter came from a roll or the loot history) is filed under the encounter, as a creature named after it, with no npc id.

### 2.3 What it keeps

**Per zone** (instance id plus difficulty):
- name, kind, size, first and last dates seen;
- the loot methods seen;
- **per creature or encounter:** npc id, name, kind (with `guessed` when it applies), encounter id, distinct corpses opened, and, per item:
  - times seen, last date;
  - name and quality from the loot window;
  - whether it binds on equip or is a quest item;
  - how it was seen (`window` or `roll`).

**Filters:**
- Boss and rare items of quality Uncommon (2) or better are kept.
- Trash items of quality Rare (3) or better are kept.
- Quest items from bosses and rares are kept, flagged, because some are council items. The preview labels them "starts a quest" and starts them unticked. Quest items below the quality floor are dropped.

**Caps:**
- 20,000 item entries in all, 80 per creature, 100 creatures per zone, 60 zones.
- A full list keeps the items seen most.
- A full log drops the zone not seen for the longest time.
- The real saved size after a raid night is measured, not assumed.

**Never kept:**
- a player's name or GUID;
- the server and spawn fields of a creature's GUID;
- chat text;
- master loot candidates;
- roll results and winners.

The module writes only its own allow-listed fields.

**Saving.** The game writes saved data only at `/reload`, logout or exit, so a crash loses the night. After the last boss, out of combat, the loot master exports the string or types `/reload`. The export window reads the log in memory, so exporting needs no `/reload`.

## 3. The Encounter Journal

**Forever has none to read (checked 2026-11-24).** The journal's functions (`C_EncounterJournal`, `EJ_GetInstanceInfo`, `EJ_GetEncounterInfo`) exist on the live client, and listed no instances at level 18. That isn't a level gate: the client (1.60.1, build 71037) ships none of the journal's data tables (wago.tools lists no `Journal*` table for that build), and Blizzard's journal window is not built to load on Forever (its TOC allows only the standard and classic game types).
- **So the game gives no whole tables before a kill.** Whole lists come from DungeonJournal (section 4, under D6) or a capture typed in from Wowhead; what drops comes from the drop log.
- **The `ej` field stays reserved.** If a later client adds the tables, the export adds those items with the evidence `ej`, under the encounter, and the import already ticks them as items the game itself lists.

## 4. DungeonJournal hints

- **How it's read.** The addon reads DungeonJournal only when the player has it installed: it's an optional dependency (`## OptionalDeps: ForeverDungeonJournal`).
  - The reader is original code. It reads the global table the journal publishes (`ForeverDungeonJournal_NS`): its dungeons, their bosses and npc ids, and their item ids, including the shared items the journal moves off its boss lists at load.
  - It calls nothing that changes the journal, and if the journal's shape changes, the hints are simply missing.
  - It's read for the export, and for the source line in the loot master's window ([section 10](#10-the-source-line-in-the-loot-masters-window)).
- **What a paste carries.** A paste can carry the journal's lists for the dungeons the loot master picks: that is an export of the journal's compiled data.
  - Its item ids outside 1 to 100,000,000 (rows the journal hasn't learned yet) are skipped and counted.
  - The version sent is the one its TOC states, which can lag its data releases.
- **License.**
  - DungeonJournal is All Rights Reserved.
  - Its code and data never enter this repository. Fixtures and examples are invented, and DungeonJournal joins the no-copy list in `AGENTS.md`.
  - Storing a journal list in the guild's Firestore, where every member reads it, is more than one player reading it on their own screen. Whether it may be saved at all is decision [D6](#open-questions).
- **Saving (D6, changed by the loot owner, 2026-11-24).** Journal items can be saved. The maintainer's first answer (2026-11-14) kept them as information in the preview; the loot owner changed it so the site's dungeons can be made from the journal.
  - They start unticked, and are ticked one creature at a time, never for a whole paste.
  - A creature's "Tick DungeonJournal's items" ticks its new ones only, never one a leader took off. It isn't offered under a creature a leader took out: Bring back comes first.
  - An item the game saw under another creature of the zone stays with that creature, whatever the order and the ticks: the journal's listing names the creature that saves it (else the first that saw it) and can't be ticked. Under one creature, the items the game saw take the room first, so ticking the journal's never leaves one without room.
  - They're saved in their own write with the Log reason "From DungeonJournal <version>, not seen in the game", so the Log keeps where they came from.
  - Each item keeps the version of the string that listed it. They're saved in one call per version, and an item two versions list is saved with both in its reason ("From DungeonJournal 2.0.3 and 2.1.0, not seen in the game").
  - A dungeon the journal calls incomplete shows that note in the preview.
  - Switched off (`JOURNAL_ITEMS_SAVED` in `dropImport.ts`), they show as information ("DungeonJournal lists it, not seen in the game") and can't be ticked.
- **Names.** The journal's names can differ from the game's ("Hall of Thanes" against "The Hall of Thanes"), and it splits one dungeon into wings ("Scarlet Monastery: Library"). See [section 6](#6-matching).

## 5. The drops string

**Envelope.** A new kind, `drops`, schema 1: `IM1:drops:j:<length>:<payload>:<crc>`. The full definition is [section 14 of `docs/spec/exchange-v0.md`](../spec/exchange-v0.md#14-the-drops-string-addon-to-app). The existing sections keep their numbers, because other documents link to them. The envelope gives three things raw JSON can't:
- the checksum and length catch a truncated or retyped paste;
- the `|` character and non-ASCII names pass safely through the game's edit box;
- a string pasted into the wrong box gets a clear message.

**Top level:**

| Field | Required | Meaning |
| --- | --- | --- |
| `schema` | yes | `1` |
| `id` | yes | `d-<base36 time>-<4 random>`. |
| `at` | yes | When it was made, in seconds UTC. |
| `by` | yes | `IntrepidManager/<version>`. Never a person. |
| `journal` | no | `ForeverDungeonJournal/<TOC version>` when any journal hint is in the string. |
| `zones` | yes | 1 to 100 zones. |

**A zone:**

| Field | Required | Meaning |
| --- | --- | --- |
| `zoneId` | no | The app's zone id. Left out until the app's "Copy for addon" exists and the night string carries zones (D5). |
| `name` | yes | 1 to 100 characters, as the game or the journal names it. |
| `kind`, `players` | yes | `dungeon` or `raid`; 1 to 40. |
| `instanceId`, `difficultyId` | no | The game's numbers. They're not app zone ids. |
| `journalPartial` | no | `true` when the journal calls its list for this dungeon incomplete. |
| `journalSkipped` | no | How many journal item ids were skipped as invalid. |
| `sources` | yes | 0 to 100 creatures or encounters. |

**A source:**

| Field | Required | Meaning |
| --- | --- | --- |
| `npcId` | no | Missing for an encounter known only from rolls, and for some journal entries. |
| `encounterId` | no | |
| `name` | yes | 1 to 100 characters. |
| `kind` | yes | `boss`, `rare` or `trash`. |
| `guessed` | no | `true` for a boss guessed from the encounter (2.2, step 3). |
| `kills`, `first`, `last` | no | Distinct corpses on this client; dates, with `first` on or before `last`. |
| `itemIds` | yes | 0 to 80 item ids, no repeats. |
| `seen` | no | Per item seen in the game: `{itemId, n, last, via, name, quality, boe, quest}`. Only `itemId`, `n` and `last` are required. `via` is `window` or `roll`. |
| `journal`, `ej` | no | The item ids DungeonJournal or the Encounter Journal lists. |

**Content rules:**
- **Evidence.** Every id in `itemIds` has evidence in `seen`, `journal` or `ej`, and every id there is in `itemIds`.
- **Duplicates.** Rows with the same key are merged, as several strings are (below). A repeated key is not a row error.
  - A zone's key is `zoneId`, else `instanceId` plus `difficultyId`, else the name key.
  - A source's key is `npcId`, else `encounterId`, else the name key.
- **Several strings in one paste.** They're merged by those keys before the preview. A count seen by two clients is taken as the larger one, never the sum.
  - A source known only by its encounter (from rolls) joins a source of the same zone with the same `encounterId` and an `npcId` (the loot master's corpse). One boss seen both ways is one creature.
- **Row errors.** A zone that fails is dropped as `zone:N`, and a source that fails as `zone:N/source:M`. An item listed under two creatures of a zone is not an error; the preview reports it.

**Size.** One raid zone after a night is about 2,000 to 7,000 characters; a journal dungeon is at most about 4,000. The export window makes one string for the zones picked. Copying a long string out of the game hasn't been measured; it's a probe step.

**Where the code differs (2026-11-14).** `addon/IntrepidManager/core/Drops.lua` (#203) makes the string, and the spec follows the code:
- **Repeated keys.** A second zone or source with the same key is not a row error, so the importer merges it as it merges several strings. This draft said the first row wins, as spec section 2 says for the other strings.
- **Order.** Sources come by kind (bosses, rares, trash; trash with the most kills first), then by `first`, which is a date, then by name. The bosses of one night are in name order, not kill order, so section 6's "encounter order" is this order.
- **Dates.** `first`, `last` and a seen item's `last` are UTC dates: a raid on a US evening has the next day's date.
- **Journal.** `journal` is `ForeverDungeonJournal/unknown` when DungeonJournal gives no version. Its zone-wide list is never sent.
- **Kills** count kills known from rolls too, not only corpses opened.

## 6. Matching

**Zones** are matched against every listed zone (`listZones`: the current and next phase, and the older raid list), not only the phase picked. In this order:
1. A capture file's `zoneId`, only when it equals a bundled capture's zone id. A Wowhead zone id is never written as an app zone id.
2. The stored instance id of a guild zone ([D2](#open-questions)), and the deterministic id of a zone the import made (below).
3. The name. The key is Settings' duplicate key (`zoneNameKey`) with a leading "The " dropped, and after that the name before a colon ("Scarlet Monastery: Library" finds "Scarlet Monastery").

**Ties and misses** go to **Unmatched**, for every role.
- **The answer.** The leader picks an existing zone, with zones of the same kind and size offered first. A Guild Leader can also choose "make a new zone" ([D1](#open-questions)), which warns that the zone is permanent and, for a 10, 20 or 40-player raid, schedulable.
  - Under D2, picking a guild zone also stores its instance id in an audited edit, so the next import matches by itself.
- **Zones that can't hold lists.** A zone of the older raid list (`raidZones`) can't hold drop lists. Matching one says so and offers to pick the drop-list zone that replaces it.

**A zone the import makes:**
- **Its id** is fixed before the first write: `50,000,000 + instanceId`, when the instance id is known, is at most 49,999,999 and that id is free. Otherwise it's a new random id. Difficulties don't matter: one app zone stands for every difficulty of an instance.
- **Its first write** creates the zone document with its name, kind and size, but **without** `removed`, so it isn't in the phase yet.
- **A blank name.** The string allows a name of only tabs or no-break spaces, but the rules refuse it. Such a zone is written as "Unnamed zone", and such a new creature as "NPC <id>", "Encounter <id>" or "Unnamed creature". A Differs row never offers a blank name.
- **Its tick** comes after the creatures ([section 7](#7-the-preview-and-saving)).
- **Its color.** A Guild Leader's import also saves a suggested color (`suggestColor`) to `settings/zoneColors`, as Settings does, once the zone document has landed, also when a later batch of the first call fails. On Save again, a zone the import made that still has no color chosen gets one. A zone that has a color chosen keeps it. If saving the color fails, the zone keeps the automatic color, the drop lists still save, and the message says so, whether the save finished or stopped.
- **A retry** (Save again, with the answers still in the panel) finds it in the raw documents: by the fixed id, or by the id its "make" answer carries, whatever the zone is named ("Unnamed zone" for a blank name, a raid's name cut to 80 characters). Both work because the zone document is written first. Names are matched only as pasted, so a different blank-named zone in a later paste never lands in an "Unnamed zone" by itself: it's asked about again.

**A zone matched in another phase.** `listZones` also lists zones first named in the next phase. When the matched guild zone has no named document at or before the picked phase, the zone write in the picked phase repeats its name, kind and size, so the merge sees it there.

**Several candidates for one app zone** (two wings of one bundled dungeon, or two strings) are grouped before anything is built. The difficulties of one instance take one answer. A DungeonJournal list, which has no instance id, joins a zone of the same paste that has one and the same name key, so a dungeon pasted from both is made once.

**Creatures in a matched zone**, removed ones included (when two fit, the one in the lists wins over one a leader took out):
1. The npc id: a bundled creature `npc{id}`, or a guild creature with that `npcId`.
2. The encounter id, through the key `e{encounterId}` of a creature the import made from rolls. When the source also has an npc id, the same write stores it on that creature.
   - A corpse joins it only when that creature has no npc id or the same one, and the zone's paste has no other corpse of that encounter (a fight of several bosses). Otherwise the corpse goes on to step 3.
   - Rolls (no npc id) always join it, also after it has learned its npc id or been renamed.
3. The name key. A source known only by its name is also found by the key `t{hash}` the import made its creature with (see Saving), so Save again finds it when it was written under another name ("Unnamed creature" for a blank one, or cut to 100 characters) or a leader renamed it.
4. **A near name.** A guild creature of the same kind, with no npc id, whose name key starts or ends with the source's name key at a word boundary, or the other way round ("Grimtooth" and "Grimtooth the Test Boss"). The creature is **Unmatched**, and the leader picks "same as …" (the write stores the npc id on that creature) or "new".
5. Otherwise it's new.

**Differs.** A matched guild creature whose name or kind differs from the source's gets a **Differs** row, unanswered: keep the app's, or rename it in an audited edit. Bundled creatures keep their names (decision 2a).

**Order.** New creatures follow the string's order among themselves (spec section 14.3: by kind, then by first date and name). A new creature that comes right after a matched creature in the string is placed right after it. Otherwise it goes after the zone's last creature. The preview shows the proposed order; the editor's arrows change it later.

**A boss with no items yet** (its kill was seen, nothing passed the filters) is offered as an opt-in row, unticked. Saved, it exists, but Browse drops and the boss order only show creatures that have items.

**Items under a creature:**

| Case | What the preview says |
| --- | --- |
| Already on this creature in the phase | Already listed. |
| On another creature of the zone, or on the zone-wide list (a creature's document with no name that the import names included) | Listed there, and not added. The app keeps one creature per item in a zone and has no move. |
| On a creature a leader took out | Listed there, and not added. The check includes removed creatures, so bringing one back never puts an item on two creatures. |
| Taken off by a leader, in this phase or an earlier phase of its follow chain | Taken off, unticked. |
| More than this creature's remaining room for the phase (80 minus what its document already added, minus the items ticked before it; the items the game saw count first, then DungeonJournal's) | Error: "the next phase can add it". |
| Listed by DungeonJournal alone, while another creature of this import has it from the game (seen, rolled for, a capture, the game's journal) | Listed under the creature that saves it, else the first that has it from the game, whatever the order and the ticks. Can't be ticked. |
| Saved by an earlier row of this import | Listed under that row, also when a leader took it off this creature, so one item is never written on two creatures. Only a ticked item under a creature that is saved holds it: an unticked item, or one under a guessed, taken out, unanswered or unticked creature, holds nothing and takes no room. |
| Anything else | New. |

**Remembering what was taken off.** An item a leader adds and takes off within one phase leaves no trace in the documents today. Once the importer exists:
- taking an item off writes it to the document's hidden list even when this phase added it;
- the builders stop dropping such an item from the hidden list. That means `takeOffItem`, `addItems` and `restoreItem`, and `applyItems` in the merge, which today keep only hidden items that were there before the phase.
- the importer reads the hidden lists from the raw documents.

Restoring such an item then works from the hidden list as for any other. These are builder changes, not rules changes. `ARCHITECTURE.md`'s note that hidden items "were there before" changes with them.

**What remembering costs (found in review, 2026-11-24).** A take-off is now the same whether it undoes the phase's own add or takes off an item it inherited, so two cases change:
- **An undone typo in a following phase.** Phase 2 follows phase 1. A leader adds an item in phase 2, takes it off again, and later the same item is added in phase 1. Phase 2 then hides it, where it used to inherit it. It shows in phase 2 as taken off, and Bring back restores it.
- **A follow link taken away.** A take-off of an inherited item stays in the phase's hidden list. The editor then offers Bring back for an item the phase no longer has, which adds it.

Both are rare and visible in the editor, and keeping every take-off is what lets an import tell a leader's choice from a new drop. A finer record (which take-offs undo an add) would need a new field and a rules change.

## 7. The preview and saving

**Where.** The import is an **Import a drop list** panel in Browse drops, under **Edit the drop lists**, above the zones. Guild and Raid Leaders see it. It writes into the phase picked there (current or next).
- The current phase is live, so the panel suggests the next phase when the import is large: at 20 items or more, the confirm step says the phase is live and points to the next one.
- The Save button is disabled while VIEW AS previews another role.

**Layout.** The preview groups rows by zone, then by creature. Each item row shows:
- the item: its live Wowhead name, or the name and quality from the game when Wowhead doesn't know it yet ("not on Wowhead yet");
- its category;
- its evidence: "seen 3 times, last Dec 16", "rolled for", "the game's Encounter Journal lists it", "DungeonJournal lists it". A bind-on-equip trash item adds "may be a world drop".

A Wowhead answer of "unreachable" or "busy" is shown as that, with a retry. It's never "unknown item".

| Category | Default |
| --- | --- |
| **Unmatched zone** | Unanswered. Pick a zone, or (Guild Leader) make a new one. |
| **Zone never in this phase** | Ticked into the phase only if something under it is saved. |
| **Zone a leader took out of this phase** | Unticked, opt-in. Ticked, it's put back even when nothing under it is saved. It starts open, marked "taken out of <phase>", and the counts line says how many such zones are left out. |
| **New creature** | Ticked. A guessed boss is unticked, and says so. |
| **Unmatched creature** | Unanswered: "same as …" or "new". |
| **Differs** (a matched guild creature's name or kind) | Unanswered: keep the app's, or rename. |
| **Boss with no items yet** | Unticked, opt-in. |
| **Creature a leader took out** | Unticked, opt-in. Ticking it brings it back with the items, in one write. |
| **New item: seen in the game, or in the Encounter Journal** | Ticked, also when Wowhead doesn't know it yet. A quest item ("starts a quest") is unticked. |
| **New item: from trash** | Unticked. Offered for the zone-wide list instead when 2 or more different trash creatures dropped it. |
| **New item: DungeonJournal only** | Unticked, ticked per creature (D6). |
| **Already listed**, **On another creature** | Can't be ticked. |
| **Taken off by a leader** | Unticked, opt-in. |
| **Error** | Can't be ticked. Shows the reason. |
| **Not in the paste** | Information only. Nothing is ever removed. |

**Ticking an item** under a creature that isn't saved (a guessed boss, a new one a leader unticked, one a leader took out) ticks the creature too, with that item only: every other item of it that a leader hasn't answered stays unticked until a leader ticks it, also one that had no room before the click. Unticking an item never changes the creature: a new one with no item ticked is then unticked again by default.

**Answers** are kept by what they're about, never by which pasted zone heads a block or by the paste's order:
- **A pasted zone's pick, or "make a new zone"**, is kept by that pasted zone (its instance id, else its name's key). "Make a new zone" fixes the new zone's id when it's chosen. The panel keeps that id with the answers, so choosing "make" again after a pick or Choose gives the same id back; a new text starts afresh.
- **Ticks, Put it back and renames are about the app zone they land in**, once that zone is decided (matched by itself, picked, or made), and is kept under that zone's id. A made zone's id is the one its answer carries, so it's the same before the save and after a first call that made the zone. A zone that isn't decided has nothing to tick or answer under it.
  - Put it back is kept by the zone.
  - A creature row's tick and rename are kept by the zone and the key of the creature the row writes to: the creature it found (by npc id, encounter, name, or "same as …"), or the key a new creature will be made with (`n{npcId}`, else `e{encounterId}`, else `t` and a hash of its name, the same on every build; see Saving).
  - An item's tick is kept by its creature row and the item. The zone-wide list's ticks are kept by the zone.
- **"Same as …" and "A new creature"** are about the pasted creature. The answer is written under every pasted creature the row asks about (each pasted zone of the block that lists it, rolls the block joined to their encounter's corpse, and every source an earlier answer already put on the row), and read from the first of them whose answer applies. An answer that names a creature that isn't a near name in the zone it lands in is ignored. A creature with an npc id isn't a near name, except one whose npc id a "same as …" answer of this paste put there (this import's own first call), so Save again asks and answers as before. A "same as …" answer applies before a name match, so on Save again a creature the first call made with the same name doesn't take the source.
- **Sources that land on one creature** share its row. It shows a source that found the creature by itself before one placed by "same as …", and keeps the "same as …" question, so it can be changed.
- **Sources of one name are one new creature.** A source that finds no creature and isn't answered "same as …" joins the new creature of the same name in the block (the merge's name key), as it would join that creature once it's in the lists: two difficulties of a new boss, or a corpse and DungeonJournal's entry without an npc id, make one creature, are asked about once, and Save again finds the same one. The row is the first corpse's or rolls' in the paste, whichever string came first. Two blank names are never joined.

Once its zone is decided, a row keeps its id, and so its answers:
- when another pick joins the block or is taken back;
- when another source lands on its creature, by a pick or by a "same as …" answered on another row (the two rows become one);
- after a save whose first call landed: a creature found then by the npc id that call stored, or a new creature that call made, has the same key.

A "same as …" answer given while two pasted zones of the block list the creature holds when either pick is taken back. Answers stay with their zone: changing a pick to another zone (or from "make" to a pick) shows that zone's own answers, and changing it back shows these again, except a "same as …" answered again there (see the limits).

Answering "same as …" on an unanswered row moves the row to the key of the creature it names. Nothing under an unanswered row can be ticked, brought back or renamed, so no answer is lost. The creature's block keeps its React key (the question's first answer key), so focus stays on the select, unless the answer puts it on a row that is already shown: the select then moves into that row's block. Changing "A new creature" to "same as …", or back, moves the row between the two creatures in the same way, and each keeps its own ticks.

A zone picked into a zone that another pasted zone matched by itself lists the pick. Every pick has its own Zone select there, named for the pasted zone, so it can be changed or taken back (Choose). Answering keeps the block it's asked in open, so keyboard focus stays on the select.

**Known limits** of these keys:
- **Rolls and a corpse of one encounter on two pasted zones** become one creature only while a pick puts them in one block. A new creature made from the rolls (`e{encounterId}`) then becomes the corpse's (`n{npcId}`), so the ticks given under the rolls' row start over; taking the pick back brings them back. When the rolls had found a creature by its name and the corpse has another name, the joined rolls no longer find it, and a new creature is offered with the rolls' items, ticked by default. A "same as …" answer given to the rolls holds.
- **A "same as …" answered again in another zone replaces the first.** It's kept by the pasted creature, not by the zone, so after the pick is changed back the question is asked again. Not answered again there, the first answer comes back with the pick.
- **An answer given before another pasted zone that lists the creature joined the block** is kept only by the pasted zone it was given in. Taking that pick back asks the question again for the one that joined.
- **A new creature from same-named sources of two picks** is keyed by the first corpse or rolls in the paste. Taking that pick back keys it by the next one, so its ticks start over; putting the pick back brings them back.
- **A block is keyed by the pasted zone that heads it**, so a pick into a zone another pasted zone is in already (matched by itself or picked) moves the rows and the select into that zone's block, and focus is lost.

A counts line shows zones, creatures and items. Saving takes one confirm that names the phase and repeats the counts ("Save to Phase 4: 1 zone, 2 creatures, 3 items"). Picking another phase or loading a file closes it, and it's off when there's nothing to save.

**Saving.** The builder (`importZone`) works from the raw `lootTables` documents, not only the merged view. It never creates a document that already exists. Writes go through `writeLootTables` in chunks of 10. A batch can't hold two writes to one document: the rules check each edit against the document as it was before the batch. So saving is **two calls**, and in each call every document gets exactly one write, with all its changes merged into it:

1. **First call:**
   - **A zone the import makes:** its zone document, not in the phase yet.
   - **A matched zone** that needs its name repeated in this phase, or (under D2) its instance id stored, and is already in the phase: one edit carrying both.
   - **Creatures:**
     - **A new creature** is one create with its name, kind, npc id, order and items. Its key is `n{npcId}`, or `e{encounterId}` for a creature from rolls, or `t` and a hash of its name's key when there's neither (at most 13 more letters and digits). It's the same on every build, so the preview's rows keep their ids and Save again finds the creature. When that key is another creature's, or its document exists, the key gets `x2` added (else `x3`, up to `x99`, and only then a random key). The key avoids the `npc` prefix, because the rules never let an `npc…` creature be removed.
     - **A creature whose document is there with no name** (a leader changed its items while the phase followed another, and the link was then taken away) keeps its key, and gets one edit of that document instead of a create: its name, kind, npc id and order, `removed:false` if it was taken out, and the new items added to what the document holds. Those count toward its room, and what it takes off shows as Taken off. The items it holds are that creature's, so no other creature of the import gets one of them. It's saved by default (a guessed boss still waits for a tick), also when every pasted item is on that document already: those items show as Already listed, and naming the creature is what makes them show.
     - **An existing creature** gets one edit of its document for this phase, or one create when the phase has none yet, carrying everything at once: new items, `removed:false` for a creature a leader took out, the npc id from "same as …", a rename from Differs.
     - **The zone-wide list** is the source document with the key `zonewide`, with no npc id or order. It's created or edited the same way, at most 80 items per phase. A creature beats the zone-wide list when both would hold an item in this import.
2. **Second call, after the first has landed**, built from the stored documents:
   - **The zone's tick**, for a zone that isn't in the phase, merged with its D2 instance id when both apply.
   - **Journal items** (D6): their own edit of each creature's document, with their own reason, in one call per version (or set of versions) that lists them. Each call is built from the documents as the calls before it left them.

If the second call fails, the zone stays out of the phase (nothing shows), and a retry ticks it.

**Provenance.** Every Log entry carries a `reason`: "Imported from the addon (d-…)", "Imported from a capture file" or the journal reason above. The rules already allow `reason` on table entries. The Log is changed to show it on drop list entries.

**After saving.** The result lists:
- what was saved (from `writeLootTables`' progress);
- what wasn't sent;
- the one reason the refused batch gives.

The text and the answers stay in the panel, so pressing Save again finishes the job: the preview is built again from the stored documents, and what was saved shows as Already listed. Pasting the same string again later works the same way:
- **Fixed ids:** an `n…` creature is found by its npc id, an `e…` one by its encounter, a `t…` one by its name or its key, and a fixed zone id by id.
- **Random ids:** a random zone id, or a creature's random key (only when its own key and `x2` to `x99` are all taken), is found by name. A zone made by the import has its name from its first write. A zone written as "Unnamed zone", or with its raid name cut, isn't found by name in a later paste: the leader picks it.

For a zone already in a live phase, the creatures saved before a failure are visible at once.

## 8. Worked examples (fixtures for the unit tests)

Every name and id is invented. "The phase" is the one picked in the editor.

1. **A raid zone made in Settings, first import.**
   - **Setup.** "Test Barrow" (raid, 10) exists. The paste: zone "Hollow Test Barrow", instance 9901, boss A (npc 990001: items 900001, 900002 seen) and boss B (990002: 900003).
   - **Preview.** Unmatched zone. The leader picks "Test Barrow" (under D2 that stores 9901). Then 2 New creatures and 3 New items, ticked.
   - **Saved.**
     - First call: 2 creature creates (keys `n990001`, `n990002`).
     - Second call: one edit of the zone's document for the phase, carrying the tick (if it wasn't in the phase) and, under D2, the instance id.
     - If the zone was already in the phase, the D2 edit goes in the first call instead.
2. **The same paste again.** The zone matches by stored instance id (D2) or by the pick being asked again; creatures match by npc id; items show as Already listed. Nothing to save.
3. **A second night.** Boss A again, with 900001 and a new item 900004. Saved: 1 edit of boss A's document for the phase.
4. **A Guild Leader makes a zone.** The paste has "Hollow Test Barrow" and nothing matches. The Guild Leader chooses "make a new zone".
   - **Saved.**
     - First call: zone `50009901`, created with its name and not in the phase, and 2 creature creates. That's 3 writes in one batch, each to its own document.
     - Second call: the tick, an edit of the zone document at rev 2.
     - A color goes to `settings/zoneColors`.
   - **A retry.** The first attempt stops after the first call. The retry finds zone `50009901` and both creatures in the raw documents, so it only ticks the zone in.
5. **Taken off within one phase.** Night 1 imported 900002 and 900005. In the same phase:
   - a leader took both off;
   - a leader added 900006 by hand.

   Night 2 lists all three: 900002 and 900005 are Taken off, unticked, and 900006 is Already listed. Both take-offs survive in the hidden list.
6. **On another creature.** 900003 is on boss A; the paste lists it under boss B. Shown as listed under boss A, not added.
7. **A creature a leader took out.** Boss C (`n990003`) was a wrong guess and a leader removed it. The next paste lists it: Creature a leader took out, unticked. Ticking writes `removed:false` and the items in one edit.
8. **A guessed boss.** The paste marks boss D `guessed`. Shown as "boss (guessed from the encounter)", unticked.
9. **Trash.** Item 900050 was dropped by two different trash creatures and is bind on equip. Offered for the zone-wide list, unticked, "may be a world drop".
10. **The room left.** Boss A's document already added 70 items this phase. The paste has 15 new ones: 10 New, 5 Errors.
11. **Two wings of one bundled dungeon.** "Test Abbey: Library" and "Test Abbey: Chapel" both resolve to the bundled "Test Abbey". They're grouped into one zone: one presence write at most, one write per creature.
12. **A zone a leader took out of the phase.** The paste includes a bundled dungeon a leader unticked this phase. Shown as taken out, unticked; nothing under it is ticked.
13. **A capture file for a raid.** A format-1 capture with Wowhead zone id 5555, not bundled. The id isn't used: the zone is matched by name, or Unmatched.
14. **Not on Wowhead yet.** 900099 was seen twice; Wowhead doesn't know it. Shown with the game's name and quality, "not on Wowhead yet", ticked.
15. **An unmatched creature.** "Test Barrow" has a hand-made "Grimtooth" with no npc id. The paste has "Grimtooth the Test Boss" (990001). Unmatched creature: "same as Grimtooth" writes the npc id onto it in an audited edit.
16. **Journal hints.** A dungeon from DungeonJournal, all journal only. Unticked; ticking a creature's items makes the creature, and the items follow in the second call with the journal reason. Switched off: information only, nothing tickable.
17. **A broken paste.** A changed character: the whole paste is refused with the checksum message.
18. **The loot master and a raider paste together.**
    - The loot master's string has boss A (npc 990001, encounter 9101: 900001 from the corpse).
    - A raider's string has encounter 9101 with no npc id (900001 and 900007 from rolls).
    - **Result:** one creature `n990001` with 900001 (seen 1, the larger count) and 900007. There's no second creature `e9101`.
19. **An `e…` creature learns its npc id.** An earlier import made `e9102` from rolls. Tonight's string has a corpse for npc 990002 under encounter 9102. It matches `e9102`, and the same write stores npc 990002 on it.
20. **A zone first named in the next phase.**
    - "Test Barrow" was made for the next phase.
    - Importing into the current phase matches it through `listZones`, but no document names it at or before the current phase.
    - **Saved.** The zone write in the current phase repeats its name, kind and size, so the zone shows there.
21. **On a creature a leader took out.** 900008 is on boss C, which a leader took out. The paste lists 900008 under boss A. It's listed on boss C and isn't added to boss A.

## 9. Rules and client changes

**Rules.**
- **The import itself needs none.** Every document it writes already fits. The batch budget measured 16 table documents per batch, and the app sends 10.
- **D2** adds an optional `instanceId` to guild zone documents.
  - It touches `firestore.rules` (zone keys, field checks, the audit field list, `tableFieldsLogged`), with rules tests showing the widest documents still fit.
  - On the client: `tableAuditFields` in `lootAudit.ts`, `readTableDoc` (which drops unknown fields), the zone document type, merge, `TableChange` and `writeZone` in `guildTables.ts`, and the field labels in `auditText.ts`.
  - **A limit:** `listZones` prefers the current phase's merge, so an instance id stored only in a next-phase document isn't seen by a current-phase import until that phase starts.
- **D7**, if chosen, adds a stored fallback item name. That's a rules and data change.

**Client changes.** Shared files get their own commit.
- `src/shared/game/guildTables.ts` (shared):
  - the `importZone` builder: two calls, one write per document id in each, built from raw documents, with explicit orders, items added once across the import, and the zone-wide list;
  - same-phase take-offs kept in the hidden list: `takeOffItem`, `addItems`, `restoreItem` and the merge's `applyItems`;
  - `parseItemIds` also reads `item:12345` and in-game links;
  - under D2, the zone document type, merge, `TableChange` and `writeZone`.
- `src/shared/game/dropsString.ts` (new, shared): reads `IM1:drops:` and capture files into candidate zones. `checkLootCapture` stays the final gate for capture files.
  - It reads strings with the envelope reader LOOT-005 needs too; whichever of LOOT-005 or LOOT-008 lands first builds it, in its own commit.
- `src/guildApi.ts` (shared): `writeLootTables` takes an optional `reason`. A new zone's color is saved with the existing `saveZoneColors`.
- `src/shared/lib/itemInfo.ts` (shared): tells "Wowhead has no such item" apart from "unreachable" and "busy", which today are one error status.
- `src/features/loot/auditText.ts`: drop list entries show their reason.
- `src/features/loot/TablesEditor.tsx` and a new import panel. Save is disabled while previewing; "make a new zone" checks the Guild Leader (`canEditRoster`).
- `ARCHITECTURE.md`:
  - the `n{npcId}` and `e{encounterId}` keys and why they avoid the `npc` prefix;
  - zones made from the import (D1);
  - the ROADMAP "zones in Settings" decision, amended by D1.

## 10. The source line in the loot master's window

The loot master's session window shows, above the answers to the picked item, where it drops ("From Boss, Dungeon"). The source is the first that answers:
1. **This client's loot windows.** The loot master opened the corpse, so the drop log knows: item id, then the corpse's npc id or encounter, then the name.
2. **DungeonJournal's source text**, when the player has it.

The raider's answer frame is out of scope here: carrying a source to raiders changes the message format (ADDON-002). DungeonJournal also adds its own line to every item tooltip, ours included.

The DungeonJournal part was built at the loot owner's request (build 0.0.18) and came into this repository with the addon (#198). The drop log part comes with the drop log.

## 11. What stays manual

- Removing items, and moving an item from one creature to another (LOOT-008's other remaining item).
- Zone colors and artwork beyond the suggested color (Guild Leader, Settings).
- Merging two zones that turn out to be the same raid.
- Renaming a bundled creature (decision 2a keeps bundled names).
- Items nobody has seen drop and no journal lists: typed in by hand, or from a Wowhead capture.

## 12. Backlog, pull requests and order

**Mapping, decided by the maintainer (#202, 2026-11-14):**
- The `drops` format and the probe steps: ADDON-001 (#193), whose spec this is and whose live research is open.
- The drop log and the export: ADDON-002.
- The app import: part of LOOT-008, with move and replace still open. It feeds LOOT-007's "confirmation of complete Forever loot data".
- **The claim:** issue #202, since LOOT-008's issue #97 is superseded.

**Order, with proposed targets:**
0. **The claim** (this repository's process comes first): a work-item issue for LOOT-008, and a note on #193 for the format and probes.
1. **Probes, now, by the loot owner in the game** (result files read privately, facts reported):
   - DungeonJournal's check (`/im dj`);
   - **a five-player dungeon run:**
     - the instance facts at entry;
     - slots at `LOOT_READY` with autoloot on;
     - `GetLootSourceInfo`;
     - boss units and whether they're secret;
     - `UnitClassification`;
     - `GetLootSlotInfo`'s quest returns;
     - rolls and `C_LootHistory`;
     - copying a long string out of the game;
   - **the Encounter Journal** at the loot owner's level, then at level 60;
   - **later, with a second player under master loot:** the guessed-boss and chest rules. They apply only to the master looter, so a group-loot dungeon run doesn't test them.

   Target: the dungeon run by November 20.
2. **The addon work, under ADDON-002, in this repository's `addon/`** (it moved here in #198):
   - the DungeonJournal reader and the source line, built at the loot owner's request as build 0.0.18;
   - the drop log and the export: merged in #203 (2026-11-14).

   It follows the addon's rules (`addon/AGENTS.md`): every new client name listed as unverified in `tools/api-known.json` until a probe confirms it; the test stand-in `FakeLoot` extended with `GetLootSourceInfo`, `GetInstanceInfo` and the encounter events; the beta's timelines replayed as shapes in Lua tests; a storyboard for the export window.

   Installed on every loot master's client before December 9 (D8). Target: November 30.
3. **The docs PR:** this document, section 14 of `exchange-v0.md`, invented fixtures, and the `drops` kind in `addon/tools/exchange_fixtures.py` and `synthetic.py`. DungeonJournal is already on the no-copy list in `AGENTS.md`. Target: November 22.
4. **The app import** (an app PR with unit tests from section 8, and rules tests for D2). Target: December 12, so the lists are ready for priorities around December 15.
5. **The Encounter Journal again on December 9.** If it lists raid loot, the export adds it.

**Tracking.** The addon's builds count as installed, not deployed. The app PR gets an Unreleased line, and the status follows the usual in-progress, awaiting deployment and released steps.

## Open questions

- **D1.** May a Guild Leader make a new zone from the import, as an explicit choice that's never the default? This amends the ROADMAP decision that zones are kept in Settings. **Decided (the maintainer, 2026-11-14, as proposed): yes.**
- **D2.** Store the game's instance id on a guild zone, so later imports match it even when its name differs from the game's? The December 9 raids are made in Settings with names the leaders chose. It's a rules change with tests. **Decided (the maintainer, 2026-11-14, as proposed): yes.**
- **D3.** Trash items start unticked, and only items from 2 or more trash creatures are offered for the zone-wide list. **Decided (the loot owner, 2026-11-12): yes.**
- **D4.** The backlog mapping in section 12. **Decided (the maintainer, 2026-11-14, as proposed):** the format and probes under ADDON-001, the drop log and export under ADDON-002, the app import under LOOT-008.
- **D5.** Should the night string carry the app's zones, so the addon can put `zoneId` in the string? Proposed: when "Copy for addon" is built, not before. Open: "Copy for addon" isn't built yet (ADDON-002).
- **D6.** May items from DungeonJournal (All Rights Reserved) be saved in the guild's drop lists at all, one creature at a time, with their own Log reason? Or should they stay information in the preview? The maintainer's call for this public repository. **Decided (the maintainer, 2026-11-14, as proposed): information in the preview, until decided otherwise. Changed (the loot owner, 2026-11-24): saved, unticked by default, one creature at a time, in their own write with the journal reason (section 4).**
- **D7.** An item Wowhead doesn't know yet can be saved to a drop list, but Browse drops can't make a priority for it, because a priority stores the item's name. Proposed options: wait for Wowhead, or store the game's name as a fallback (a rules and data change). Open: #202 had no single proposal to approve.
- **D8.** Which loot masters run the drop log on December 9, and how they get the build before the production addon (ADDON-002, target December 22)? **Decided (the loot owner, 2026-11-12): every team's loot master, from a zip with install steps the loot owner hands out before November 30.**
