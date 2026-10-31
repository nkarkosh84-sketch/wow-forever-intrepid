# Contributing

Thanks for helping. This is a guild tool with real data in production, so the rules are about keeping that safe and keeping changes easy to review. Read `ARCHITECTURE.md` for how the code is laid out.

## Set up

Use the Node.js version given in the README.

```bash
npm install
npm ci --prefix functions --ignore-scripts
cp .env.example .env.local   # then fill in your own Firebase values
npm run dev
```

Prefer `npm run dev:emulator` for local work: Auth, Firestore, Functions and Cloud Storage run against `demo-intrepid` without billing. For cloud development use your **own** Firebase project with Email/Password sign-in, Firestore, rules, Functions and your own `VITE_GUILD_ID`. Cloud Functions requires the Blaze plan; Spark no longer supports the complete sign-up/availability write flow. Follow "Firebase project setup" in the README. Never point `.env.local` at the production project, and never commit `.env.local`.

Awards and raids cannot be deleted from the app (unavailable dates can only be removed by their owner), so test on your own project and not on the live guild.

## Before you open a pull request

### Scheduled-raid local review (RAID-011)

Run `npm run dev:emulator` with JDK 21 and existing root/Functions dependencies. It starts only the `demo-intrepid` emulators and Vite at localhost:5173, then seeds invented data. Never run the seeder against a cloud project or a review instance already containing changes; it refuses non-review emulator hosts and does not clear existing data. Stop the previous review instance before starting a fresh one. Unit/rules tests must use their own emulator ports, not the review Firestore at 18080.

Sign in with `leader@example.test` (Guild Leader), `raider@example.test` (Raid Leader), `member@example.test` (Member), or `reserve@example.test` (unassigned ready main); each uses the invented local password `password123`. The seed has independent 10-player assignments, empty 20/40 teams, a ready main/alt pair, an alt whose main is unready, unready assigned characters, a ready unassigned reserve, and scheduled/legacy/cancelled/started raid examples. No production names or data are copied. The old UX-001 comparison panel has been discarded, not shipped.

Review Raid Teams at all three sizes (larger teams start empty), then open **Test raid night** from Dashboard or Raid Calendar and **View scheduled roster**. Check leader moves/bench/unassignment, independent sizes, unchanged standing teams, alt mismatch resolution, main-ready invitations and readiness-loss flags. As a Member check full read-only visibility, signup character changes, Absent clearing positions and unavailable-date enforcement. Test late explicit leader placement with its acknowledgment, cancellation/start refusal and a narrow viewport in both themes. New raids copy standing teams atomically; older raids require explicit one-time initialization after saving a start time.

Use **Scheduled Raids** for management: open a raid's row, then use the shared Raid Teams-style available roster, team cards and assigned bench. Test drag/drop and keyboard add/move/remove controls; confirm changes appear live in another sign-up roster window and never affect standing teams or another raid. The size/filter controls sit at the right of the action row and wrap on narrow screens. Empty role sections collapse automatically and reopen when populated; manual toggles remain available. Coverage results have a consistent separate row in both tabs. Guild/Raid Leaders see red ! buttons for character review warnings and editing/initialization controls; verify the warning popovers by tap, keyboard and Escape in both themes. Members see read-only cards and response summaries, without review-warning buttons. The popup is read-only and hides review details for everyone. Check its **Open Scheduled Raids** link preserves the selected raid, switching raids does not retain another raid's responses, and started/cancelled raids cannot be edited. This hides derived review details, not the underlying shared readiness/roster documents. Check actual Guild Leader, Raid Leader and Member sign-ins as well as VIEW AS.

Team cards in both Raid Teams and Scheduled Raids display assigned characters by their saved role: Tank, Healer, Ranged (including Hunters), then Melee, alphabetically within each role. Check subtle gaps/dividers between populated groups, without added headings, in both themes and on narrow screens. This is display-only: moves/removals must still target the correct character and never reorder saved scheduled placements.

Scheduled team response totals use compact colored icon/count badges in the workbench and sign-up roster. In workbench cards, responses share the role-count row on the right and wrap together onto the next row when space is insufficient. Check Accepted, Tentative, Absent and Not Responded at zero and nonzero counts; Late and voluntary Bench appear only when nonzero. Each badge has a full accessible status/count label. Counts and individual response controls remain unchanged.

In Scheduled Raids, available-roster warnings and assigned-bench move controls align immediately before the response, with the warning before the move control when both are present. Narrow pool cards with move dropdowns place controls and response together below the identity; cards without move dropdowns retain the compact identity/response row. Verify long names, both controls, popover keyboard/Escape, bench moves, busy/closed states and actual Member read-only visibility; standing Raid Teams cards retain their layout.

RAID-001 captures automatic immutable start snapshots with a daily server-side schedule at 9:00 PM in `America/New_York`. The local `npm run dev:emulator` workflow does not emulate Cloud Scheduler; snapshot worker tests invoke the sweep directly against Firestore Emulator and verify its retry, lifecycle, publication and failure behavior. This does not verify deployed scheduled delivery. Do not present an unfinished/failed capture or a read-only working roster as a historical snapshot. Discord reminders, bench-ready confirmation and attendance calculations remain out of scope. See the data contract and Raid History read path in `ARCHITECTURE.md`.

Snapshot capture accepts older raids with an omitted `time` as 21:00 Eastern, matching the app contract; `startsAt` remains authoritative. Explicit invalid times still fail. This does not reconstruct missing working rosters or migrate historical mock raids.

### Zone pictures on My dashboard (RAID-017)

As a Member, open **My dashboard** with upcoming raids that have 1, 2, 3 and 10 zones, a zone with no picture (it shows its color), and a raid with no zones listed (a single tint). Each of the (up to five) raids shows a strip above its details; check that the sign-up button, its Accepted, Absent and closed states, the "You marked unavailable" and Cancelled tags and **View on calendar** work as before, that the text never sits on a picture, and that the strip is 40px tall in light and dark and at 375px and 320px with no sideways scroll.

### Snapshot deployment prerequisites

After explicit deployment approval, run `npm run release -- --deploy` in an interactive terminal. The release deploys `firestore:indexes` before Functions, then stops at a readiness checkpoint. In the target project's Firebase console, Firestore > Indexes, verify both composite indexes (`auditLog`: `targetType`/`at`; `raidSnapshotJobs`: `state`/`nextAttemptAt`) and the single-field ascending **collection-group** index on `raids.startsAt` have finished building and are ready. Collection-scoped indexes alone are insufficient. Preserve the existing collection-scoped field indexes.

Type `indexes-ready` only after that verification. Failed, missing or still-building indexes must not be acknowledged. Noninteractive runs or any other response stop before Functions deploy; rerun after resolving the problem. Index deployment success does not mean backfill is finished. The default `npm run release` remains read-only and never prompts. Direct service deployments must follow the same index-first/readiness order. Emulator tests do not validate production index provisioning or Scheduler delivery; verify both after the approved deployment.

### Showing and hiding raids and absences (UX-007)

On **Guild Calendar**, use the **Show:** buttons in the heading row as a Guild Leader, a Raid Leader and a Member. Turn Raids off, Absences off and then both off: the grid keeps its month, weekdays and day numbers, one line says both are hidden, the heading and footer counts do not change, and a day's accessible name lists only what is shown. With Absences off, add, edit and remove a range (the sidebar list and the dialog still show it). Open the calendar from **Leadership Overview** and from a raid in **Scheduled Raids** with Raids off and check that Raids turn on. A reload shows both again; nothing is stored.

### Editing unavailable dates (MEMBER-005)

The edit dialog also provides **Delete absence**, using the existing owner-only removal callable. Check that it closes on success, reports failures inline, remains disabled while busy or after external deletion, and does not appear in the add dialog. Deletion retains Absent responses and never restores placements; unsaved date-field changes do not alter which saved entry is deleted.

Use an invented Member account to add a range, then use the pencil beside it in **My dashboard > Upcoming absences** and **Guild Calendar > Your date ranges**, or click the owned entry directly on a calendar day. All open the same prefilled dialog, whose body text matches the raid sign-up dialog. Check calendar entry activation by keyboard as well as click, cancel, invalid/reversed dates, saving, narrow screens and both themes. Other members' calendar entries stay read-only; leaders cannot edit another account's ranges. Busy state must disable saving and calendar edit buttons; a deleted entry must show an error rather than recreate it. The visible calendar name is Guild Calendar; retain the internal `afk` tab ID and data names.

Move, shrink and expand a range across future raids, including another overlapping unavailable entry. Previously covered raids retain Absent; newly covered raids become Absent and lose that account's main/alt scheduled placements. Once no unavailable entry overlaps, the member may explicitly change their response; old placements are never restored. Started/cancelled raids and published snapshots remain unchanged. Server tests cover authorization, ranges, concurrency and transactional rollback. Deploy the `updateUnavailableDates` Function before Hosting after explicit release approval; existing add/remove clients remain compatible. No data migration is required.

```bash
npm run build
npm run lint
npm run test:unit
```

If you changed `firestore.rules` or `storage.rules`, also run `npm run test:rules` (see "Testing the Firestore rules" below).

Then click through every tab as each role (use VIEW AS as a Guild Leader to preview Raid Leader and Member), open each dialog you touched, and make sure the browser console is clean. Automated checks cover the Firestore rules, the pure raid-preview helpers and the pure functions in `tests/unit/` and `tests/raid-coverage/` (`npm run test:unit`, run directly by Node, no emulator), not the rendered UI, so say in the PR what you checked in the app.

For explanatory help or expandable read-only text, use the shared `HelpPopover` and follow [its interaction and browser-check contract](ARCHITECTURE.md#help-and-popovers). Do not put essential help only in `title` or hover handlers. Reading help must never trigger a save or change a selection.

## Testing the Firestore rules

The rules are the authorization boundary, so they have tests that run against the local Firestore and Cloud Storage emulators (`storage.rules` holds the zone artwork files; it reads the members documents of Firestore to learn a person's role, so its tests, `zone-art-storage.test.ts` and `support/storage.ts`, start both). You need a JDK, version 21 or newer, because the emulator is a Java program (check with `java -version`; Temurin from adoptium.net is fine, or `brew install openjdk@21` on macOS, which also needs adding to your `PATH`). Then:

```bash
npm run test:rules
```

It takes under a minute and needs no Firebase login, no Firebase project and no `.env.local`: it uses the demo project `demo-intrepid`, and the tests talk only to the emulator on `127.0.0.1`. The script runs `firebase-tools` through a version-pinned `npx` call (it is deliberately not a dependency of this repo, with install scripts turned off), and the first run downloads the emulator jars (about 137 MB for Firestore and about 53 MB for Cloud Storage) into your user cache. The emulator ports are in `firebase.json` (`emulators.firestore.port` and `emulators.storage.port`); change them there if they clash with something on your machine.

The tests are in `tests/rules/`, written in TypeScript and run by Node's built-in test runner. `access-matrix.test.ts` lists, per collection, which role may get, list, create, update and delete; the other files cover the rules that depend on the data (join requests, the account-to-character link, award snapshots, availability, raid zones and raids, and how large a batch can be). A comment above each group says who may do what.

- Change a rule and its tests in the same pull request. Add a case for every new branch, and for the thing it must still refuse.
- Raid-rule changes must keep ten-zone creation and audited edits passing, including an edit of every mutable detail and cancellation/restore. Retain malformed-snapshot and dishonest-audit refusals; testing only a smaller zone list can hide Firestore's 1000-expression limit.
- Tests named "KNOWN GAP" record what the rules do today even though it is arguably wrong or weak. They are not approvals. When a rules change closes a gap, that test fails: flip it to expect a refusal and remove the label.
- `tests/rules/support/client.ts` repeats the multi-document batches from `src/guildApi.ts`. If you change how `approveJoinRequest` or `updateMembershipAccess` build their batches, change the copy too.
- Use invented names and uids in tests, as everywhere else in this repository.
- `npm run build` does not compile the tests and `npm run lint` only lints them; `npx tsc -p tests/rules` and `npx tsc -p tests/unit` type-check them (CI does not run that).
- `npm run test:rules` also runs pure raid-preview/availability checks in `tests/raid-preview.test.ts` and server-handler integration checks in `functions/raids.test.js`. Install `functions/` dependencies first. Server tests use the Admin SDK only against the local emulator and test authorization, ownership, inclusive/overlapping ranges, retained Absent after removal, concurrent mutations and idempotent synchronization. Run pure checks alone with `node --test tests/raid-preview.test.ts`.
- `functions/raidStartSnapshot.test.js` invokes the daily RAID-001 sweep worker against Firestore Emulator, covering Eastern-time boundaries, bounded checkpoint recovery, durable per-raid retries and audit-history reconstruction; it does not test Cloud Scheduler's delivery. The worker discovers raids through collection-group time-range queries on existing `startsAt` and raid-audit `at` fields. `firestore.indexes.json` supplies the required audit and pending-job composite indexes. `tests/rules/raid-start-snapshots.test.ts` verifies member read access, unpublished snapshot concealment, client write denial and cross-guild/unauthorized denial.
- The same runner includes `functions/characters.test.js`: request ownership, Guild Leader-only review, stale approvals, default roles, withdrawal/rejection and atomic main swaps. Request privacy and direct-write denials are tested in `tests/rules/character-requests.test.ts`. Client and server share `functions/characterClasses.json`; change it once and keep the role-default regressions passing.

## Pull requests

Character-readiness changes must keep `tests/rules/character-readiness.test.ts` passing: per-character owner/leader writes, reciprocal main/direct-alt ownership, removal, server stamps and field isolation. Leadership aggregation is covered in `tests/unit/leadership.test.ts`. Shared coverage changes are covered by `tests/raid-coverage/`, which `npm run test:unit` runs with `tests/unit/` (`node --test tests/raid-coverage/*.test.ts` runs them alone); the module is in `src/shared/raid-coverage/` and is reused by Teams and Leadership.

- Keep them small and about one thing. A refactor and a feature are separate PRs.
- Work in your feature's folder under `src/features/`. If you must change a shared file, do it in its own commit and call it out in the PR description. Shared files are: `src/shared/**`, `src/shell/**`, `src/App.tsx`, `src/App.css`, `src/guildApi.ts`, `src/useGuildData.ts`, `src/useGuildSession.ts`, `src/security.ts`, `firestore.rules`, `storage.rules`, `firebase.json`, `package.json`, `package-lock.json`, `.nvmrc` and everything under `.github/`.
- A change that adds or changes a Firestore collection or a rule needs the rules change in the same PR, reviewed on its own, tests for it in `tests/rules/`, and a note about deploy order: rules first, then hosting.
- Deploy only when you are asked to. For this server-side write transition deploy Functions first, then rules, then hosting. Functions requires Blaze billing and Node 24. After the first release a Guild Leader runs Settings > Synchronize raid absences to backfill existing unavailable dates. Old tabs must refresh: direct response/availability writes are now denied.
- Opening a PR: `gh pr create --fill` (GitHub CLI). The merge is done in GitHub.
- After the merge, a maintainer asks for the deploy. `npm run release` from a clean `main` that matches `origin/main` runs the read-only checks and prints the plan (and refuses if the build would use a Firebase project other than the live one). `npm run release -- --deploy` then builds, lints, runs server/rules tests, deploys Functions, Firestore rules, Storage rules, then hosting, then moves the `last-deploy` note. Any other argument is an error, so `--help` and typos cannot deploy. Cloud Storage has to be turned on once in the Firebase console (Build > Storage > Get started, same location as Firestore, which needs the Blaze plan) before the Storage rules can be deployed; until then `npm run release -- --deploy` stops at that step.
- Match the existing style. There is no formatter yet, so do not reformat code you are not changing; it makes the diff unreadable.

### Looking back on My dashboard (MEMBER-008)

In the local emulator, put the guild into a third phase (**Settings > Loot phases**, twice) with invented priorities and awards in each phase for a Member's characters, a removed award, and a list prepared for the next phase. As that Member, My dashboard shows a **Phase** choice in each of My loot priorities and My awarded loot only once a phase has finished (with one phase there is no choice). Pick each finished phase on each card, and check that the two cards are independent: priorities (with the received marks) and every award to the account's characters appear, and nothing from another phase, the next phase or a removed award. Reload, and start another phase as a Guild Leader while the page is open, and check that the dashboard returns to the current phase. Check the empty messages with an account that has no loot, and the control at 375px and 320px (44px tall, no sideways scroll).

### Branch cleanup after merge

The primary maintainer merges PRs and normally deletes their remote feature branches immediately afterward using GitHub's **Delete branch** button. Contributors must clearly mark **KEEP BRANCH: YES** in the PR's Branch retention section before merge if a branch is still needed, with the reason, owner and linked dependent work. Otherwise the maintainer will treat it as disposable after merge, subject to the safety checks below. Keep this field current and notify the maintainer if the requirement changes during review. Each contributor handles their own local branch cleanup separately.

Clean up one verified PR branch at a time, not unrelated branches. Coding assistants must surface any known reason to retain a branch prominently in the PR; they still need explicit approval naming the branch before performing deletion themselves. This maintainer-operated default is not permission for automated or bulk deletion.

1. **Verify the exact branch and merge.** Check that GitHub shows the PR as merged into the intended base, not merely closed. Confirm the head repository and branch name, fetch current refs, and compare the current remote branch tip with the PR's merged head commit. If more commits were pushed afterward, stop: those commits are not covered by the merge.
2. **Check retention and dependencies.** Read the PR's Branch retention section and check for dependent open/stacked PRs or known shared use. Honor **KEEP BRANCH: YES** until the named owner confirms it can be removed. Missing retention information on an older PR or conflicting evidence of ongoing use requires coordination with the owner before deletion; an explicit **KEEP BRANCH: NO** on a current PR needs no separate routine confirmation. A contributor's leftover local checkout alone does not require keeping the remote branch, but ongoing work depending on it does. Never delete `main`, another protected/long-lived branch, or deployment refs such as the `last-deploy` tag. Do not choose branches for deletion based only on age, naming or a bulk "merged" list.
3. **Delete only the approved remote branch.** Prefer the merged PR's **Delete branch** button after the checks above. For a branch in this repository, the equivalent command is `git push origin --delete <exact-branch-name>`; substitute only the verified branch, with no wildcards or bulk loops. A fork branch belongs to its owner; do not assume `origin` points to that fork. Recheck the remote tip immediately before deletion and stop if it changed.
4. **Clean your own local checkout separately.** Inspect `git status --short` and preserve any uncommitted work before switching. With a clean checkout, fetch/prune the approved remote, switch to `main`, and fast-forward it. Stop on any failure; never reset or discard changes to make cleanup succeed. Pruning removes stale local remote-tracking refs, not other people's remote branches. If `main` cannot fast-forward, ask for help rather than forcing it.

   ```powershell
   git fetch origin --prune
   git switch main
   git merge --ff-only origin/main
   git merge-base --is-ancestor <exact-local-branch-name> origin/main
   # Only if the ancestry check succeeds and the branch is no longer needed:
   git branch -d <exact-local-branch-name>
   ```

   Run each command separately and check its result. The explicit ancestry check guards against deleting local work just because its upstream contains it. `git branch -d` is an additional guard, not proof of the PR's status. If the branch is checked out in another worktree, stop and coordinate; do not remove the worktree to bypass the refusal.
5. **Treat squash/rebase merges specially.** Their original commits may not be ancestors of `main`, so the ancestry check or safe deletion can refuse even when the intended changes landed. Do not automatically substitute `git branch -D`. Verify the merged PR, compare its delivered changes with the current local branch, preserve any unique work, and request explicit approval for that exact local force-deletion if still necessary. Uncertainty means keep the branch.

Branch deletion does not deploy, mark a backlog item released, close unrelated issues or authorize Discord publication. Start subsequent work on a new branch from current `main`, rather than reusing the merged branch.

## Backlog, patch notes, and publishing

### Sources of truth

- [Roadmap](docs/ROADMAP.md): direction, policy decisions, milestones and dependencies. Do not maintain a second task-status list there.
- [Backlog](docs/backlog.json): canonical actionable work and status, including released/cancelled records retained for history.
- [Changelog](CHANGELOG.md): member-facing changes grouped by verified release.
- [Publisher guide](docs/discord-backlog.md): local credentials, message tracking, previews, publishing and recovery.

Discord is a published view, not the authoritative work tracker. Collaborators propose changes through PRs. The primary maintainer deploys and publishes from the designated Windows machine; collaborators do not need webhook credentials or local Discord tracking files. A merge, build or deployment does not itself authorize a Discord post.

### Shared work process

Everyone, including coding assistants, works from [docs/backlog.json](docs/backlog.json) on current `main`. GitHub issues hold discussion and acceptance criteria; PRs hold proposed implementation. Neither creates a separate priority or status list. Old lane labels such as B10 describe earlier work briefs, not canonical backlog IDs.

1. **Find the item before coding.** Sync current `main`, read the backlog and roadmap decisions, and identify the permanent ID (for example `RAID-010`). Search existing issues and open PRs for that outcome, not just its title. Check prerequisites and shared-file coordination.
2. **Reconcile gaps first.** If an issue has no backlog item, propose the mapping or a new item to the maintainer before implementation. Check current `main` and open PRs before allocating an ID. Do not force unrelated scope into an existing item, resurrect released work without explaining the new scope, or implement directly from an old list. Documentation/tooling-only maintenance can state `Backlog: N/A` with a reason; this is not an exemption for untracked application features or fixes.
3. **Claim the work visibly.** Comment on the linked issue with the backlog ID, owner, intended scope and branch/PR when available. If there is no issue, open one using the work-item template. Confirm no other collaborator is already doing it; coordinate overlapping work before coding. Include `in-progress` and the claim/issue reference in the backlog update proposed with the work. Agree priority, dates and scope changes with the maintainer rather than changing them silently.
4. **Keep the links together.** Use `Backlog: RAID-010` in the issue and PR body; use multiple IDs only when the change genuinely covers them. Link the GitHub issue from the PR and record its reference in the backlog item's `notes`. Add the PR number to `prs` once known. Do not add undeclared fields to the backlog schema. For example, `RAID-010` maps to issue #95 (old B10) and implementation PR #110.
5. **Submit the whole delivery record.** Use the PR template. Include acceptance results, remaining scope, backlog status/PR references and a member-facing Unreleased bullet when applicable. Partial delivery keeps the item open with explicit remaining work. Only use `Closes #...` when the issue's required scope is fully satisfied; optional follow-ups must be identified, not falsely checked off.
6. **Separate merge from release.** Implementation in an open PR is `in-progress`; merged but unverified application work is `awaiting-deployment`. The primary maintainer records `released` only after production verification, with the exact dated changelog heading. Update these transitions in the merge/release follow-up if they cannot be recorded in the implementation PR. A closed GitHub issue can mean implementation merged, not production availability; its discussion should make the distinction clear.
7. **Reconcile existing issues with evidence.** Link each issue to a backlog item or explain why it is a duplicate, superseded or no longer needed. Before proposing closure as resolved, check required acceptance criteria against merged code, validation and deployment evidence where required. Record the evidence and any remaining work. Do not bulk-close from titles, checked boxes or a PR reference alone; ask the maintainer when scope or resolution is uncertain.

Use the [GitHub work-item template](.github/ISSUE_TEMPLATE/work-item.md) and [PR checklist](.github/pull_request_template.md). Templates and assistant instructions are guidance, not an enforced gate: the contributor and reviewer must check the mapping and delivery record. Existing issues are not automatically migrated. After this process is merged, collaborators should pull current `main` and have their coding assistants reread `AGENTS.md` before starting the next task.

### Maintaining backlog items

Each item has these required fields:

| Field | Rule |
| --- | --- |
| `id` | Permanent unique identifier, such as `RAID-001`. Check current main and open PRs before allocating one; never reuse or rename an ID. |
| `title` | A concrete outcome, not an implementation diary. |
| `status` | `planned`, `in-progress`, `awaiting-deployment`, `released`, or `cancelled`. |
| `priority` | `critical`, `high`, or `normal`. Reserve critical for the firm first-raid path. |
| `target` | ISO date or `null` when unscheduled or externally blocked. Around December 15 remains approximate even though the sortable target is `2026-12-15`. |
| `commitment` | `required`, `target`, or `external-dependency`; a target is not a guaranteed delivery date. |
| `dependsOn` | Existing item IDs for actual prerequisites, with no self references or cycles. Unknown research outcomes belong in notes rather than guessed dependencies. |
| `prs` | Relevant PR numbers in this repository; an empty array means no PR is recorded. |
| `release` | `null` until verified adoption/release, then the exact changelog release heading. |
| `notes` | Remaining scope, acceptance conditions, policy questions, external risks and fallback behavior. Public-safe text only. |

Claim work as `in-progress` when implementation starts. A merged application change becomes `awaiting-deployment`, not `released`. After production deployment and verification, the primary maintainer records its release. Local tools require verified installation/adoption instead; they must not be described as deployed web features. Keep blocked items at their current status and explain the blocker in notes.

For partial delivery, keep the original item open with explicit remaining scope, or split the remaining outcome into a new ID and record the relationship. Only completed scope belongs in patch notes. Retain cancelled records with a reason; cancelling or reprioritizing work is not a shipped feature. Preserve released records and IDs, but omit them from the active Discord backlog. Removing a feature later is a new change, not erasure of the earlier release.

Initial priorities and dates are a working breakdown of the approved roadmap, not additional firm deadlines. The December 9 scheduled-raid/sign-up/starting-snapshot requirement remains firm; loot recording has a spreadsheet fallback, priorities start around December 15, and December 22 is the broad full-rollout target. Resolve conflicts with the maintainer rather than silently changing commitments.

### Maintaining patch notes

Include relevant backlog status/scope updates in implementation PRs and concise member-facing bullets under **Unreleased**. Keep backlog IDs, PR references and technical evidence in the backlog and PR delivery record, not in member-facing bullets. Internal-only tooling and documentation need not generate member-facing notes. Unreleased is not evidence of production availability.

Write patch notes for guild members, not developers. Use short, plain-language bullets focused on what members can do or what is easier now, usually one sentence and one change per bullet. Combine overlapping updates and omit implementation details, technical jargon, test results and development history. Mention role restrictions or required member actions when useful; keep release verification and source references separate from the bullets. Apply this style to new or unpublished notes without rewriting published entries.

After deployment and verification, the primary maintainer moves only the shipped bullets into a heading `YYYY-MM-DD - <full-or-short-commit>`, records source PRs, and updates completed backlog items with `status: "released"` and that exact heading in `release`. Leave merged-but-unshipped bullets under Unreleased. Preserve existing release entries; explicitly label corrections to published notes instead of silently rewriting history. Do not invent historical backlog IDs or retrospectively mark planned work complete.

### Publishing ownership and approval

1. Collaborators update the shared files in reviewed PRs.
2. The primary maintainer deploys the approved application changes and verifies production.
3. Finalize the release record and backlog statuses through the normal reviewed change process. Publishing does not require another Firebase deployment for documentation-only changes.
4. Preview the exact Discord content and destination; obtain explicit approval to publish.
5. Post a new patch-notes message for the verified release and update existing active-backlog messages. Record receipts locally and recover partial failures without duplicating posts.

The publisher renders shared sources with `.\scripts\discord-backlog.ps1 -Backlog` or `-Release '<exact dated changelog heading>'`; both default to preview. After explicit approval, add `-Publish`. Release mode publishes patch notes first, then updates the active backlog, saving receipts so known successful messages are skipped on retry. It does not verify Firebase deployment itself: the maintainer must first verify deployment and record it in the changelog. Configure patch notes using `-ConfigureFromClipboard -Destination patch-notes`; the existing backlog credential stays intact. See [publisher instructions](docs/discord-backlog.md) for setup, recovery and manual payload support. Neither merge nor deployment triggers Discord automatically.

Keep encrypted webhook credentials, Discord receipts/message IDs, locks and private guild content outside the repository. The primary machine owns publishing state; other machines must not publish independently using fresh state. Verify JSON syntax, unique IDs, field values, references, acyclic dependencies and release links when editing the backlog. Documentation-only changes need no app build unless behavior or tooling changes too.

## Cloud Storage

Cloud Storage holds the zone artwork (`storage.rules`; see "Zone artwork" in `ARCHITECTURE.md`). Before `npm run release -- --deploy` can deploy the Storage rules to the live project, two things have to be done once, in this order:

1. **Turn Storage on:** Firebase console, Build > Storage > Get started, in the same location as Firestore. It needs the Blaze plan.
2. **Let Storage read Firestore.** `storage.rules` learns a person's role from the members documents in Firestore (the same documents the Firestore rules use; Google calls this a cross-service rule), and for that the Cloud Storage service agent needs a role. The release script runs `firebase-tools` with `--non-interactive`, which skips the question that would grant it, so grant it once by hand: either run `npx firebase-tools@15.31.0 deploy --only storage --project <project-id>` in a terminal, without `--non-interactive`, and answer yes when it offers to grant the IAM role, or open IAM in the Google Cloud console and give `service-<project number>@gcp-sa-firebasestorage.iam.gserviceaccount.com` the role "Firebase Rules Firestore Service Agent". Without it every Storage request is refused, leaders included, and the release still prints Done.

A picture is shown through its download address, a link with an unguessable token that the app keeps in the members-only `settings/zoneArt` document. Storage does not check that kind of request against the rules, so the rules decide who may add, delete and list files and who can ask Storage for an address, not who can look at a link that was copied. Do not put anything private in this bucket.

## Rules that protect the guild

- Firestore security rules are the direct-client authorization boundary. Availability and raid-response writes are denied by the rules and go through authenticated server callables that enforce membership, ownership and availability. UI role checks only hide controls; never relax direct-write rules to work around a callable failure.
- The VIEW AS preview only changes what the UI shows. Do not pass a previewed role to data hooks or write helpers.
- Award snapshots (candidate order and council note at decision time) are immutable. Do not alter how they are built or stored without discussing it first.
- Do not imply that local browser data is shared. Only authenticated Firestore data is.
- This repository is public. Do not commit real character names, account emails, Firebase service-account files or keys, or anything from a private guild spreadsheet or tracker. Use invented names in examples and tests.
- The class and specialization icons are Blizzard artwork used under the fan-content note in the README. Do not add other Blizzard assets.

## Using an AI assistant

Assistants such as Copilot and Claude Code work well here if they read `ARCHITECTURE.md` first. Point them at it, keep them inside one feature folder, and review what they change in shared files line by line. Do not let one reformat `src/App.tsx`.
