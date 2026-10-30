# Patch notes

Member-facing changes, grouped by verified production release. See [contribution rules](CONTRIBUTING.md#backlog-patch-notes-and-publishing) for maintenance and [the backlog](docs/backlog.json) for remaining work.

Earlier releases have not been reconstructed here. These entries do not assert that Discord patch notes were published.

## Unreleased

- The Guild Calendar has a **Show:** choice in its heading row (UX-007): turn Raids or Absences (unavailable dates) off to read the other alone, or both off for a bare month. Both are on when you open the page and the choice lasts until you reload; it changes only what you see. The counts in the heading and footer still count every raid and date range, and opening the calendar from a raid turns Raids back on.
- Raid Teams and Scheduled Raids list Faerie Fire and Curse of Recklessness separately from Sunder Armor / Expose Armor.
- Coverage uses consistent status labels and icons, with details about eligible providers, talents, party limits and conflicting effects.
- Each upcoming raid on My dashboard now has a strip of its zone pictures above its details, the same pictures as on Scheduled Raids (RAID-017). A zone with no picture shows its color.
- On a desktop window (1101px wide or more), Loot priorities puts the item first (UX-008): the item is twice as large, with its icon, alone at the left; where it drops and the council note come next, then the council order with the Award loot and Edit Prio buttons under it. The boss heading is a little larger. Narrower windows and phones look as before.
- An opened raid on Scheduled Raids has two tabs (RAID-018): **Signups** shows who is coming in Tanks, Healers, Ranged and Melee columns, by class, with Bench, Tentative, Late, Absent and Not responded below, and **Groups** shows the team lineups as before. Members start on Signups; Guild and Raid Leaders start on Groups.
- Scheduled Raids is now a list of collapsed rows (RAID-016): each shows a banner of the raid's zone pictures side by side, each fading into the next, with its name, date, time and zones. Open a row to see that raid's roster, sign-ups and buff coverage; a raid stays in the list for 5 hours after it starts and then leaves it (Raid History keeps it). Add Raid and Edit Raid show each zone's picture and a preview of the banner.
- My dashboard can look back at earlier phases (MEMBER-008). Once a loot phase has finished, My loot priorities and My awarded loot each get a **Phase** choice. Each starts on the current phase; pick a finished one to see that phase's priorities (with what you received) or all the loot awarded to your characters in it, and the two cards can show different phases. The choices are only yours and start again from the current phase when you reload or when the guild starts a new phase.

## 2026-10-25 - ce1a288

Updates since the October 19 announcement. Refresh open tabs to load them.

- Guild and Raid Leaders can use **Record loot** without a priority list, recording the recipient, raid date, dungeon, boss and how the drop was decided.

- **Record and add another** keeps the night's details ready for the next drop, with a warning when a drop looks already recorded.

- Leaders can fix a mistaken receipt by unlocking its priority and clicking the x beside RECEIVED to move or remove it; the Log keeps the history.

- The Log shows each entry's loot phase and filters by phase and raid date, alongside its existing player and encounter filters.

- My dashboard shows loot priorities and awarded loot for the current phase only; earlier phases remain available in Loot priorities and the Log.

- The second raider type is now called **Raider** instead of Hardcore; existing selections are unchanged.

- Members can edit or delete their unavailable dates from My dashboard or by clicking their entry in the calendar.

- Editing or deleting unavailable dates does not restore raid spots or change an existing Absent response automatically.

- **Raid Calendar** is now **Guild Calendar**.

- Starting raid rosters are captured automatically at 9 PM Eastern; members can browse published snapshots in **Raid History**.

- Raid History preserves starting teams, benches, invitations and responses; it is not an attendance record.

- Raid Teams and Scheduled Raids group characters by role and show compact response badges on scheduled rosters.

- Scheduled roster warning and bench controls now line up beside responses.

- Pages, cards and loot dialogs have more consistent spacing, with clearer team-name fields in Settings.

Verified cumulative production release. Source PRs: #128, #131, #132, #134, #135, #137, #139, #140, #143, #144, #148, #153 and #156; deployment evidence is recorded in the backlog and source PR receipts.

## 2026-10-19 - 567a689

- Scheduled raid response totals now use colored icon badges for a quicker overview.

- Raid Teams and Scheduled Raids group team members by role: tanks, healers, ranged, then melee, with subtle dividers.

## 2026-10-19 - 8665779

Refresh open tabs to load the update.

- Raid Teams now has separate lineups for 10-, 20- and 40-player raids.

- Guild and Raid Leaders can adjust each scheduled raid's teams and bench without changing regular Raid Teams.

- Raid sign-ups show the full roster and a quick breakdown of responses.

- Marking yourself absent or adding unavailable dates clears your scheduled raid spots.

- Team views are tidier, with aligned buff coverage, collapsible empty sections and warnings behind a red ! button for leaders.

- Editing loot priorities is quicker: tick characters to add them, untick to remove them, or use + to list one again.

- Browse drops now filters by creature and item slot.

- Carry over now filters by dungeon, boss and item slot without losing your selections.

- Guild Leaders can add zone artwork in Settings to display in Loot priorities and Browse drops.

## 2026-10-18 - d0ef75d

Production deployments through d0ef75d verified, including matching live HTML, JavaScript and CSS on intrepidwow.com and the Firebase Hosting domain. This summarizes changes since 92dbc71. Source PRs: #98, #99, #102, #103, #104 (including #100/#101), #105, #107, #108, #110 and #111; MEMBER-003 scope approved in #106. Refresh open tabs to load the update.

- Raid Teams prevents assigning a main and its alt, or two alts belonging to the same main, to the same 10-player team. A conflict dialog explains which character is already assigned; existing conflicts are highlighted for review. This is a client-side assignment check, not a raid sign-up restriction (RAID-010; issue #95 / B10, PR #110).

- Changing Raid ready now asks for confirmation on My Dashboard and the roster. Confirm saves the change; Cancel leaves the flag unchanged (MEMBER-003).

- My Characters adds tap-accessible character-management and raid-readiness help, with a fixed role column immediately before Raid ready. Headings use title capitalization while existing all-caps headings stay uppercase.

- Members can mark their main and each direct alt independently **Raid ready** on My dashboard; Guild Leaders can manage flags in the roster. Characters start not ready, and flags follow character IDs through renames and main changes. This is a planning flag, not a reserved raid spot or sign-up restriction (MEMBER-003).
- A Guild Leader-only **Leadership Overview** tab, between Loot priorities and Member access, brings together selected-raid missing responses, private character-request review and live team coverage in dashboard-style themed cards. Leader character-request review moves out of Member access; members keep their own requests on My dashboard. Any ready main or alt includes its account once; all saved responses count, with separate review warnings for attending responses on unready characters. Excluded/setup counts and coverage uncertainty remain visible (MEMBER-003).

- Coverage Gaps in Leadership Overview has a compact 10/20/40 raid-size selector beside the heading. Sizes not used by the selected raid are disabled; coverage still reflects current assignments, not sign-ups or readiness. Dashboard card headings, help-button sizing and selector alignment are more consistent across themes.

- Zones: Settings now has one Zones catalog for dungeons and 10/20/40-player raids, replacing Raid zones. Guild Leaders add zones with a name, kind, size and color; the catalog supplies both raid scheduling and phase drop lists. Zone colors appear as bars/tints in Loot priorities and dots in Browse drops and the editor, with readable text in both themes. Colors can be chosen individually or spread automatically (LOOT-007, LOOT-008).

- Drop lists: leaders choose each phase's zones in grouped, collapsible checklists. A phase starts empty unless its Follows setting explicitly selects an earlier phase; it inherits that phase's zones, creatures and items with its own changes on top. This replaces the old per-zone/creature Follow controls. **Phase 1 needs its zones selected once** if not already configured; until then Browse drops says it has none (LOOT-008).

- Loot priorities: the pencil is now a labelled Edit Prio button, with guidance for missing council notes. Received candidates are faded rather than crossed out, retaining their class colors and green Received tag. The drop-list editor labels Creature ID and explains where to find it in a Wowhead address.

- Loot priorities: pick candidates from a searchable roster, sorted by class or name, and add several at once. Reorder or remove characters, including repeated listings, and add editable note lines for non-character instructions; notes can be marked finished (LOOT-003, LOOT-009).

- Awards through an open priority note put the chosen roster character where the note was and move the note down for the next recipient. The award dialog offers listed candidates and, under each open note, the rest of the roster. This is not a standalone no-priority award form (LOOT-009; standalone recording remains LOOT-002).

- Edit Prio keeps Save and Cancel visible and asks before closing with unsaved changes: Save priority, Discard changes or Keep editing. Candidate ordering is locked per item by default; leaders unlock COUNCIL ORDER to move candidates, and all items lock again on page load (LOOT-009).

- Carried-over priorities show their source phase. Carry over offers confirmed, logged removal of the carried-over copy without changing the earlier phase; it can be carried over again. The phase picker sits beside the page title with current/next/finished labels and a consistent violet accent across loot dialogs (LOOT-009).

- Browse drops keeps the phase picker visible when a phase has no zones and explains how to configure them. Manually typed priorities appear in their own Typed by hand group with confirmed Take off controls. Counts appear only when filters narrow the list (LOOT-009).

- Characters keep their loot when renamed: priorities, completion, the filters, the Log's player filter and My dashboard follow stable character IDs where recorded, while award rows and Log lines keep the name they were written with. An older priority is converted to roster characters the next time a leader edits it (a name the roster does not have stays as a note). Older name-only awards are not retroactively rewritten (LOOT-003).
- My dashboard shows the priorities and awards of every phase up to the current one, the latest first, with a received mark and the phase for earlier ones.

## 2026-10-17 - 92dbc71

Production deployments through 92dbc71 and matching live HTML/assets verified. This summarizes changes since the f42a14d announcement. Refresh open tabs before using the updated loot workflow.

- Members can submit and withdraw private character-change requests on My dashboard: new/existing alt links, renames, class/spec changes and main promotion. Guild Leaders review with optional notes in Member access. Approval preserves character IDs, teams and historical snapshots; spec changes apply the default raid role. Decisions appear in resolved request history, without automatic notifications (MEMBER-002).
- Character requests use class-colored character cards and specialization icons, defined current/requested sections, highlighted field changes and separate member-note and leader-review areas in light and dark themes (MEMBER-002).
- Character-request lists identify the member by their main character, with the affected character shown underneath, including requests for new alts (MEMBER-002).

- Guild Leaders can remove and restore guild access with confirmation. Removal unlinks and blocks the account without deleting characters or history; restoration grants unlinked Member access. Removed accounts see a dedicated no-access screen (MEMBER-001).
- Right-aligned the My dashboard raider-type, help and attendance controls on mobile, including when they wrap.
- Fixed ten-zone raid edits being rejected by Firestore's expression limit while preserving complete zone validation and truthful, atomic audit entries (RAID-008).

- **Browse drops** shows dungeon/creature drops with item names, icons and full tooltips from Wowhead, accessible by mouse, tap or selection. Bundled dungeon lists remain beta practice data, not a verified Forever database (LOOT-007).
- Guild and Raid Leaders build priorities by ticking items in Browse drops, including a creature's drops or a whole dungeon. New items show **Needs players** and **Assign players**. Candidates are still typed; stable roster selection remains planned. Each item is listed once per phase (LOOT-009).
- Loot priorities is now grouped by dungeon and then by boss, in the order the bosses are met, with a count on each heading. Switch to One list for the plain list. Priorities typed by hand are grouped too, by their "dungeon · boss" text (LOOT-009).

- Loot priorities can now be filtered by item slot (Head, Chest, 1H Weapon, Trinket and so on, with Other for bags and recipes) and by dungeon or a single boss: the encounter list shows each dungeon with its bosses beneath it. The class filter and the Needs players button are gone; an item with no players still shows Needs players on its row (LOOT-009).
- A **Phase** selector opens current priorities and read-only earlier lists. Leaders can prepare next-phase lists; awards wait until that phase starts. Dashboard counts and received marks follow the phase, and older records belong to the first phase. Guild Leaders start phases from **Settings > Loot phases** with typed confirmation, or reopen the previous phase when eligible.

- **Log** replaces Award history and is readable by all members. It shows awards (including legacy records), priority and phase changes, actors and before/after details, with search, player/slot/encounter filters and sort order. Priority/award writes and phase changes require truthful, atomic audit entries; entries cannot be edited or deleted. The old local-data import is removed (LOOT-001).
- Loot priorities has a **Carry over** button for leaders. Pick an earlier phase and tick the items to bring into the phase you are looking at (the current one, or the next one you are preparing). Each becomes a new priority with the same item, boss, note and the whole candidate list: players who already got it show as received, and the ones who still need it stay on it. The earlier phase is not changed, and each carried item is in the Change log. An item already on the list cannot be carried twice.

- Loot priorities no longer has an **Add priority** button: new items are added by ticking them in **Browse drops** (or carried over from an earlier phase). A priority that exists can still be edited with its pencil.
- Browse drops changes one phase at a time. Taking an item with assigned players off the list asks for confirmation and **keeps** its priorities, note and awards; putting it back restores that work. An item without players is removed. Both actions are logged.
- Guild and Raid Leaders can **Edit the drop lists** by phase: paste item IDs or Wowhead links with name previews, add/reorder creatures, and add/remove/restore zones or items. Earlier phases keep their lists, later phases inherit changes, and edits are logged under **Drop lists**. Bundled files are unchanged. Full capture-file import remains planned (LOOT-008).

Sources: PRs #72-#76, #78-#89 and catch-ups #90-#93. RAID-008, MEMBER-001, MEMBER-002 and LOOT-001 are delivered. LOOT-007/008/009 and LOOT-004 have partial delivery with remaining scope in the backlog. Manual-award rules are live, but the standalone recording form is not delivered (LOOT-002). Stable-ID loot selection/migration remains LOOT-003.

## 2026-10-16 - f42a14d

Production deployments through f42a14d and live release assets verified. This summarizes changes since the ec45641 Discord announcement.

- Guild roster now supports sorting by name, class, role or team, in either direction. Keep alts under their mains or mix them into the sorted list. Sort choices last for the browser session.
- Raid Teams has All characters / Hide alts for the available roster and Add from guild roster lists. Assigned alts remain visible; assignments, assigned counts and buff/debuff coverage are unchanged.
- Class-colored character styling now extends to Raid Teams, loot candidate and recipient names, dashboard characters, Member Access and sign-up team previews.

- Dashboard Casual/Hardcore descriptions now have a separate tap-accessible help button; reading help does not change your selection. Tap the attendance chip for its explanation.
- Roster comment panels and coverage details use shared tap/click/keyboard-accessible popovers. Coverage spell details now open by explicit activation rather than hover.
- Help panels close on outside interaction, Escape, focus leaving, navigation, surrounding page/table scrolling and viewport changes. Long panel content remains scrollable without changing roster row heights.
- Fixed sideways scrolling into blank space on mobile, and prevented narrow header text from pushing account controls off-screen. Wide tables and the mobile tab bar still scroll independently.

Sources: PRs #58-#65, #68 and #70. RAID-009 is delivered. UX-002/UX-003 have deployed improvements; physical-device checks and the broader mobile workflow pass remain open. RAID-007 game-data verification is still outstanding.

Developer progress, not new live app functionality: PRs #67/#69 add validated practice loot captures for nine dungeons; loot-table selection/import UI is not delivered. The on-request two-channel Discord publisher (PRs #51/#52) has been adopted and verified with live posting and editing; it is not a raid bot.

## 2026-10-16 - ec45641

Production deployment and live release assets verified. This update also summarizes the roster improvements deployed since the previous Discord announcement.

- Raid Teams now includes a buff and debuff coverage checklist for 10-, 20- and 40-player teams, with spell icons, descriptions and a detailed provider/source panel.
- Coverage distinguishes estimated results, talent-dependent possibilities and unknown party coverage. Game data is provisional or unverified, not a guarantee that buffs are active; in-game verification remains outstanding.
- Guild roster now has a Show Comments toggle: review Public comments, plus Leadership comments for Guild and Raid Leaders. Authors still edit comments on their dashboard. Read comment opens a floating panel without expanding the row.
- Roster rows now have class-colored stripes, shading and character names.

Sources: PRs #53, #54 and #57. MEMBER-004 is delivered; RAID-007's checklist is deployed, but game-data verification remains in progress. Mobile tooltip access and consistent dismissal on scroll remain planned November 4 improvements (UX-002 and UX-003).

## 2026-10-16 - bbefbc2

Production deployment verified and confirmed by the maintainer.

- Dashboard raid actions now show your saved response, with matching response colors and a compact centered layout.
- Sign-up actions stay in a consistent location relative to unavailable/cancelled badges.
- A divider separates raid instructions from the last sign-up action.

Source: PR #49. This predates backlog IDs; no IDs were invented retroactively.

## 2026-10-16 - 9d609e3

Production deployment verified and confirmed by the maintainer.

- Unavailable dates force Absent and prevent response changes until all covering events are removed. Removing those events retains Absent until you choose another response.
- Fixed raid saves incorrectly rejecting unchanged selected zones because of field ordering.
- Loot priorities now track repeated candidate listings one receipt at a time, show received/completed progress, and offer encounter, player, class and completion filters.

Sources: PRs #46 and #47. This predates backlog IDs. Automatic starting roster snapshots are not included.
