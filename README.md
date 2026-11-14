# Intrepid Guild Raid Desk

A React, TypeScript, and Vite guild-operations app backed by Firebase Authentication and Cloud Firestore.

## Purpose

Intrepid Guild Raid Desk gives guild leaders, raid leaders, and members one shared place to maintain the roster, organize raid teams, prepare loot-council decisions, and review the log of every loot change. Guild data is shared through authenticated Firestore access; local browser data is not shared automatically.

## Working together

Start with the [canonical backlog](docs/backlog.json) and follow the [shared work process](CONTRIBUTING.md#shared-work-process) before coding. Every application feature or fix needs a backlog ID linked from its GitHub issue and PR; issue numbers, old lane labels and Discord posts are references, not separate backlogs. Check and claim work with the team to avoid duplicate implementations. Coding assistants must read [AGENTS.md](AGENTS.md). Only verified production delivery is marked released.

## Current functionality

- **My dashboard:** The landing tab. For members with a linked character, the panel toolbar (next to the character count) includes a Casual / Raider type switch (hover text explains each; stored per member in `raiderTypes`, readable by every member) and a Raid attendance placeholder (`--`, to be filled in when attendance tracking is built). Below are that character and its alts, raid team, upcoming raids (with time and description, flagging dates the member marked unavailable, and a "View on calendar" link that opens the Raid Calendar on that raid's month with the raid highlighted), upcoming absences (with an Add absence button, the same unavailable dates as the Raid Calendar), loot priorities, awarded loot, and a Comments section. A comment is the member's own short note (300 characters), either Public (every guild member can read it) or Leadership (only Guild and Raid Leaders and the author). Each member has one of each, stored in `publicComments` and `leaderComments` with the member's uid as the document id. Members without a linked character can request a first main for Guild Leader approval and retain access to the other tabs.
- **Guild roster:** Add and edit characters with a first name, an optional surname, class, specialization, and a raid role (the specialization sets the default; a Guild Leader can change it). A character can be linked to a main as an alt; alts are listed under their main and can be collapsed, or hidden entirely with the All characters / Hide alts toggle (not saved between visits). The roster shows only the first name (the full name appears on hover, and search matches the surname); long names are cut off with an ellipsis so the columns stay fixed. Teams, loot and the calendar use the first name. The complete guild roster remains separate from raid assignments. The Rogue spec is always **Combat**: anything called Rogue Outlaw (the name used by later game versions and some icon sets) is treated as Rogue Combat.
- **Character raid readiness (MEMBER-003; checklist enhancement MEMBER-011):** Members manage their linked main and owned direct alts independently on My dashboard; Guild Leaders use the same checklist for any character in the roster, with no readiness bypass. Progress follows stable character IDs through renames and main promotion. Firestore enforces ownership, exact boolean checklist fields, readiness consistency and authenticated timestamps in `characterReadiness`. Readiness never grants access, assigns a team, reserves a raid spot or restricts sign-ups.
  - Each character opens a nine-check form with a completion count, percentage and progress bar. Level 60 and required keys/attunements come first. Preparation groups gear effort, professions and talents/trained ranks; acknowledgments group keeping gear enchanted, understanding rotation/toolkit, having consumables ready and learning raids/fights. Group headings are not extra checks. Existing saved checks are preserved. This is self-attestation, not automatic game verification.
  - **Save progress** saves partial completion; all nine checked means ready, and unchecking a step and saving means not ready. Cancel discards unsaved edits. Concurrent updates require reopening rather than overwriting someone else's progress. Missing or legacy ready-only records mean not ready, with no assumed completed checks; previously ready characters must complete the checklist after rollout. Existing assignments, responses and invitations are retained; historical starting snapshots are unchanged.
  - My Characters has tap/keyboard-accessible help. Roles remain immediately before the readiness control; narrow screens keep them beneath the character. The base checklist was deployed in `3c7f377`; this client-only wording/layout follow-up needs Hosting after approval. Old pre-checklist tabs must refresh because legacy boolean-only writes are denied.
- **Leadership Overview (Guild Leaders only; MEMBER-003):** Between Loot priorities and Member access. Dashboard-style themed cards show summary counts, missing responses, the private character-request review queue (moved out of Member access) and current-assignment coverage for the selected raid's sizes. Members retain their own requests on My dashboard. Defaults to the next upcoming non-cancelled raid, with a selector for others. Count each active linked account once when any owned main or direct alt is ready; list ready characters under its current main. Any saved response counts, including Absent and Bench; Accept, Tentative or Late on an unready character gets a separate warning. Excluded/unlinked setup counts and coverage uncertainty remain explicit. This is not attendance or a starting snapshot.
- **Raid teams (RAID-011):** Four independent 10-player teams (Blue, Yellow, Red, White), two independent 20-player teams (Green, Pink), and one independent 40-player team (Brown). Keep existing 10-player assignments; larger teams start empty, with no copying or derivation from smaller teams. Settings retains custom names. Available characters are raid-ready mains and alts; Hide alts remains available, and existing unready assignments remain visible. Coverage and My dashboard use each size's own assignments.
- **Raid sign-ups and scheduled roster (RAID-011):** Open Sign-up / roster from the dashboard or click a raid on the calendar. Members select their linked main or direct alt and save Accept, Tentative, Absent, Late, or Bench (voluntary), one account-owned response per raid. Functions enforce ownership, start cutoff, cancellation and unavailable dates; direct response/availability writes remain denied. An Absent response or new unavailable event clears that player's scheduled positions, retaining the absence separately. Removing unavailable dates retains Absent and does not restore positions. All authenticated guild members can open the full scheduled roster, even before responding or when absent. Guild/Raid Leaders edit independent per-size teams and bench without changing standing assignments or the member response. After start or cancellation, planning is read-only; RAID-001 captures the immutable starting snapshot automatically.
  - The sign-up window retains its character dropdown and immediate response buttons. **View scheduled roster** opens the raid-specific working lineup with **Back to sign-up**. Older raids require a saved start time and explicit one-time leader initialization from current standing teams; past assignments cannot be reconstructed.
  - **Scheduled Raids** uses the same available-roster and team cards as Raid Teams, with a collapsible row per raid (open one for its independent saved lineup). Its pool contains that raid's invited characters, not the whole guild; a selected alt remains available for manual replacement of a copied main. Guild/Raid Leaders drag cards between teams, assigned bench and available roster, or use the add/move/remove controls. Absent/unavailable placements require explicit confirmation. Changes update the sign-up at-a-glance view live without changing standing teams or member responses. Members see read-only cards, response indicators and per-team summaries. Readiness/invitation/conflict warnings and editing controls appear only for leaders in the tool, never in the uncluttered popup. **Open Scheduled Raids** opens the correct raid. This UI policy does not change backend access to shared roster/readiness data.
  - Dashboard actions show the saved response (Accepted, Tentative, Absent, Late or Bench) above "Click to change or view details", using the matching response color. Before a response they show "Sign-up / roster". The compact action is centered beneath raid details and unavailable/cancelled badges; a divider separates the guidance below the raids.
- **Raid Calendar:** Guild members can add inclusive unavailable date ranges and remove their own entries. Guild and Raid Leaders can schedule raid nights with one or more configured zones, a date and start time (Eastern Time, 9:00 PM by default, changeable per raid, picked from hour, minute and AM/PM lists where the chosen item scrolls to the top; raids saved before times existed show 9:00 PM ET), and an optional description (up to 500 characters, shown in the raid's hover text and on members' dashboards). Each zone has a 10-, 20- or 40-player size; selected zone names and sizes are saved as a snapshot on the raid and shown on the calendar and dashboard. Availability and raids appear together on the shared monthly calendar. Guild and Raid Leaders can click a raid to correct its name, date, zones or description, cancel it with a reason, or restore it. A cancelled raid stays on the calendar (struck through, marked Cancelled, and listed as Cancelled on members' dashboards). Every change is saved with an audit entry (`auditLog`, entry id `raid_{id}_{rev}`) in the same batch; Firestore refuses a raid change without it.
- **Loot council:** Track items by encounter with ranked candidates and council notes. Authorized leaders can update the priority list and record awards.
- **Log (inside Loot priorities):** Every change to a loot priority or an award, and every loot phase started or reopened, newest first, with who made it and what it was before. Each award preserves a snapshot of the candidate order and council note at decision time. Nobody can edit or delete an entry.
- **Guild access:** Members authenticate and request access. Guild Leaders approve requests, assign roles, and link accounts to roster characters. Firestore rules enforce permissions independently of the UI.
- **Character-change requests (MEMBER-002):** Linked members submit requests on My dashboard to add a new alt, link an eligible unlinked roster character as an alt, rename a character, change class/spec or promote a direct alt to main. Members can withdraw pending requests and view their history. Guild Leaders approve or reject with an optional note in Leadership Overview. Requests and notes are private to their owner and Guild Leaders, not Raid Leaders. Server transactions recheck ownership and refuse stale requests. Approval retains character IDs and team assignments; a spec change applies its default raid role, and a main swap moves the account link and reparents the old main and its other direct alts. Historical snapshots and name-only loot entries are not rewritten; older name-based dashboard matches can be lost after a rename. Leaders retain manual roster editing and raid-role overrides. First-main requests for unlinked members are a separate workflow (MEMBER-009).
- **First-main requests (MEMBER-009):** An active unlinked member can submit a first name, optional surname, class, specialization and optional note from My dashboard. Guild Leader approval rechecks active/unlinked status, then atomically creates the main and reciprocal account link. One pending request is allowed per account; the owner can withdraw before resubmitting. Direct client writes remain denied, and this does not change MEMBER-002 linked-member requests.
- **Settings (Guild Leaders only):** Edit the sidebar's current and next phase, a status label and indicator color for each phase, the council status (Deliberating while priorities are being discussed, Live once they are set), the names of the 10-, 20- and 40-player teams, and the catalog of raid zones (name and 10-, 20- or 40-player size). General settings are stored in `settings/general`; zones are stored separately so scheduled raids can preserve their selected zone snapshots. Every member can read these settings and zones, while only a Guild Leader can write them.
- **Guild experience:** Use the app in light or dark theme, with WoW class and specialization artwork.
- **Hosting:** The production app is served from [Firebase Hosting](https://intrepid-wow-forever.web.app/).

## Code map

- **Application shell:** [src/App.tsx](src/App.tsx) owns shared state and lays out the frame; [src/shell/](src/shell/) holds the sidebar, top bar, page heading, stat strip, workspace panel, dialog host, and the tab registry ([src/shell/tabs.ts](src/shell/tabs.ts)); shared layout styling lives in [src/App.css](src/App.css).
- **Features:** each tab lives in its own folder under [src/features/](src/features/) (roster, teams, calendar, loot, access, settings) with its views, dialogs, and actions. Shared building blocks (UI pieces, class and team data, the tab and dialog contracts) live in [src/shared/](src/shared/). See [ARCHITECTURE.md](ARCHITECTURE.md) for how to add a tab and [CONTRIBUTING.md](CONTRIBUTING.md) for the contribution rules.
- **Raid Calendar:** [src/features/calendar/AfkCalendar.tsx](src/features/calendar/AfkCalendar.tsx) and [src/features/calendar/AfkCalendar.css](src/features/calendar/AfkCalendar.css) render the month, availability ranges, and scheduled raids. [src/guildApi.ts](src/guildApi.ts) defines and writes records, while [src/useGuildData.ts](src/useGuildData.ts) subscribes to live guild data.
- **Authentication and role checks:** [src/useGuildSession.ts](src/useGuildSession.ts) resolves sign-in and membership; [src/security.ts](src/security.ts) controls which actions the UI presents.
- **Authorization:** [firestore.rules](firestore.rules) is the backend permission boundary for guild records, raid scheduling, and member availability.
- **Firebase configuration and hosting:** [src/firebase.ts](src/firebase.ts) initializes the client from environment values; [firebase.json](firebase.json) configures Firestore rules, Cloud Storage rules ([storage.rules](storage.rules), for the zone artwork) and Hosting rewrites; [vite.config.ts](vite.config.ts) configures the frontend build.

## Discussed future work

Collaborators track actionable work in [the shared backlog](docs/backlog.json), verified member-facing releases in [the changelog](CHANGELOG.md), and maintenance/publishing responsibilities in [CONTRIBUTING.md](CONTRIBUTING.md#backlog-patch-notes-and-publishing). The roadmap supplies direction and milestone decisions; Discord is a published view of these shared records.

### Rollout milestones (2026)

- **November 4:** game launch, not a full-app deadline. Most core web functionality rolls out progressively between November 4 and December 9.
- **December 9, firm:** scheduled raids and sign-ups must be usable ahead of the first raid, and its first immutable starting roster/sign-up snapshot must be captured at the scheduled start. Scheduling, sign-ups and automatic starting snapshots are live; RAID-014 tracks capturing each snapshot within minutes of its raid's start.
- **December 9, loot target:** record awards from the first raid independently of priorities. Use need-before-greed rolls initially. If app loot recording is not ready, use a spreadsheet and build a later validated upload; that fallback upload is not implemented yet.
- **Around December 15:** start using priority listings.
- **December 22, full-rollout target:** all planned functionality, including loot audits, priorities, the production addon, Discord and advanced automation. Full adoption can begin December 9 if ready, or soft-open over the next one or two weeks. The December 9 raid/sign-up/snapshot requirements remain firm.

"Most core functionality" excludes the addon, Discord and advanced automation from the earlier window, not from the broader December 22 target. Dates are planning commitments/targets, not claims that planned features already exist. See [the roadmap](docs/ROADMAP.md) for dependencies and implementation status.

These ideas have been discussed but are not implemented as part of this app yet:

The raid-zone catalog, multi-zone scheduling, member sign-ups and live raid-team preview are implemented (see Current functionality). Still planned: a server-side snapshot of teams and sign-ups at the start, audited team changes during the raid, leader benching, reminders at creation and 24 and 1 hour before, and attendance against the locked snapshot. The decisions taken and the order of work are in [docs/ROADMAP.md](docs/ROADMAP.md).

- Loot Priorities and Award History: Reworking the existing [loot-council app](https://intrepid-reforged-p2-loot-tracker.netlify.app/) and selectively adapt useful workflows if its source repository becomes available. This project was started independently while waiting for that repository.
    - Interfacing loot from an outside source to populate the items in the loot priority list.
- Raid Optimziation: Add a raid optimization tool to evaluate buffs and debuffs by class to ensure raids (10/20/40) have the best use of classes/specs available.
- Attendance Tracker: Ability to discern benched (voluntary/involuntary) and attendance %
    - Interfacing with warcraft logs to evaluate who contributed to a raid
    - Manual input in case a log is missed


## Local setup

For on-request Discord backlog publishing from a developer terminal, see [the publisher guide](docs/discord-backlog.md). This is separate from planned raid-bot integration and stores its credential outside the repository.

Requires Node.js 24.12 or newer (`.nvmrc` selects Node 24; get it from nodejs.org or a version manager such as nvm or fnm). Node 22.12+ also builds, but npm prints unsupported-engine warnings for the Firebase packages.

```powershell
npm install
npm ci --prefix functions --ignore-scripts
Copy-Item .env.example .env.local
npm run dev
```

### Try changes locally without touching production

```powershell
npm run dev:emulator
```

Starts the Firebase Auth, Firestore, Functions and Cloud Storage emulators with your current rules and server code, seeds an invented guild, and runs the app against them (it ignores `.env.local`). Install the Functions dependencies above first. It needs Java 21, the same as `npm run test:rules`. Functions run on port 15001, Auth on 19099, Firestore on 18080 and Cloud Storage on 19199. Sign in as `leader@example.test` (Guild Leader), `raider@example.test` (Raid Leader), `member@example.test` (Member), or `firstmain@example.test` (unlinked Member) with the password `password123`. Data is discarded when you stop it and nothing reaches the live Firebase project, so rules and server changes can be tried here before they are deployed.

### Server-side sign-ups and unavailable dates

Production requires Firebase's **Blaze billing plan** for Node 24 Cloud Functions in `us-central1`. The separate [functions/](functions/) package uses Firebase Admin and Functions SDKs; no service-account files belong in the app or repository. Deployed Functions use their managed service identity.

The callables authenticate the real account and read its guild membership; VIEW AS never changes server permissions. Availability additions/removals and sign-up saves run in transactions sharing a server-only account lock. Adding unavailable dates sets overlapping upcoming raid responses to Absent (preserving a previously selected alt, otherwise using the linked main). Removing an event retains Absent. Other members' events have no effect on your response.

Firestore triggers synchronize newly scheduled/rescheduled/restored raids and newly linked members. These triggers may take a moment; the dialog immediately derives effective Absent from shared unavailable events, and the callable checks the actual events before allowing any response change. Already-started or cancelled raids are not rewritten by this synchronization.

For the first release, deploy **Firestore indexes, verify index readiness, then Functions, Firestore rules, Storage rules and hosting**. See [snapshot deployment prerequisites](CONTRIBUTING.md#snapshot-deployment-prerequisites) for the required index checks. Afterwards a Guild Leader must use **Settings > Synchronize raid absences** once to backfill existing upcoming raids/events; it is safe to repeat. Existing events already block the callable before backfill, and deleting a legacy event also persists Absent before removal. Old browser tabs cannot bypass the new rules; refresh them after release.

## Firebase Hosting

The Firebase Hosting target serves the Vite production build from `dist` and rewrites app routes to `index.html`. Configure the Firebase values in `.env.local`, then build and deploy the hosting target:

```powershell
npm run build
npx firebase-tools@15.31.0 deploy --only hosting --project intrepid-wow-forever
```

`npm run release -- --deploy` runs the build, lint, server/rules tests, Firestore index deploy, interactive index-readiness confirmation, Functions deploy, rules deploy and hosting deploy from a clean `main` (see CONTRIBUTING.md); use it only when a deploy was asked for. Verify every required index is ready in the Firebase console before typing `indexes-ready`; failed, missing or building indexes block Functions deployment. `npm run release` on its own only prints the plan and runs read-only checks. Do not use a hosting-only deploy for a server/rules change.

The deployed site is [intrepid-wow-forever.web.app](https://intrepid-wow-forever.web.app/). Hosting deployment does not deploy Firestore rules; deploy those separately when the rules change.

## Raid team building

The Raid Teams available list contains raid-ready mains and alts, grouped into collapsible Tank, Healer, Melee, and Ranged lists. Drag or use controls to add, move or remove a character at the selected size. Each size has its own assignments; 20- and 40-player teams start empty rather than inheriting smaller teams. Existing 10-player assignments are preserved. Team names/colors and the four/two/one counts are unchanged. These RAID-011 changes are deployed.

### Scheduled-raid workflow

Agreed October 19 and deployed under RAID-011. Standing teams are independent by size. New raids atomically copy them once into a working lineup; later standing edits do not update that raid. Guild and Raid Leaders adjust that raid without changing standing assignments.

- Invite each member whose **main is ready to raid**, regardless of team assignment. A ready alt alone does not qualify an invitation.
- The Raid Teams available roster includes **every ready character, mains and alts**. All are raiders; bench is a position for a particular scheduled raid and size, not a permanent identity. Unassigned invitees are not automatically benched.
- New eligible invitees are added until start. Loss of main readiness retains the invitation, response and position, with review warnings. Initially copied unready characters remain visible; a member's alt selection flags a mismatch rather than automatically replacing the main.
- Leaders may place the selected ready character (or ready main before a response), with hard capacity and same-player checks within each individual team. Placing an Absent/unavailable raider requires explicit acknowledgment and never changes their response. Pre-start position edits need no visible audit history.
- Keep a member's response separate from their leader-assigned position. At start, preserve an immutable snapshot of the scheduled raid's lineup, bench and responses; a sign-up or snapshot alone does not prove attendance.
- Later Discord automation announces raids, reminds unconfirmed invitees 24 hours and 1 hour before start, and asks assigned bench raiders to confirm readiness 30 minutes before start. Bench attendance credit requires that readiness confirmation.

Scheduled-raid planning and automatic immutable start snapshots are deployed. The five-minute sweep delivers the first step of RAID-014; event-log reconstruction and failure recovery remain in progress. The December 9 requirement remains unchanged. Team expansion and alternate team sets were scrapped. See the [agreed lifecycle and remaining decisions](docs/ROADMAP.md#scheduled-raid-lifecycle-agreed-2026-10-19) and [canonical backlog](docs/backlog.json). Leadership missing responses now use the scheduled invitation list, not the old any-ready-alt population; coverage remains standing-team coverage, not a scheduled-lineup estimate.

Set the Firebase web-app values and a stable guild document ID in `.env.local`. These public Firebase client settings identify the app; Firestore rules enforce data access. Never put service-account credentials in the web app or commit `.env.local`.

```text
VITE_FIREBASE_API_KEY=
VITE_FIREBASE_AUTH_DOMAIN=
VITE_FIREBASE_PROJECT_ID=
VITE_FIREBASE_APP_ID=
VITE_FIREBASE_STORAGE_BUCKET=
VITE_GUILD_ID=
```

`VITE_FIREBASE_STORAGE_BUCKET` is only needed when the project's bucket is not `<project-id>.firebasestorage.app` (a project made before late 2024 has `<project-id>.appspot.com`). Cloud Storage holds the zone artwork.

## Firebase project setup

1. Create a Firebase project and register a web app.
2. Enable Email/Password under Authentication sign-in providers.
3. Create a Cloud Firestore database, and turn on Cloud Storage (Build > Storage > Get started, same location; it needs the Blaze plan) for the zone artwork; for the live project also see "Cloud Storage" in [CONTRIBUTING.md](CONTRIBUTING.md).
4. Deploy the rules in `firestore.rules` and `storage.rules` using `npx firebase-tools@latest deploy --only firestore:rules,storage --project <project-id>`.
5. Create the first user in Firebase Authentication. Copy that user's UID and create `guilds/<VITE_GUILD_ID>/members/<UID>` in Firestore with `email`, `displayName`, and `role: "Guild Leader"` fields.
6. Sign in with that account. Guild Leaders can review access requests and assign roles in Member Access.

If a Guild Leader is shown "Request guild access" after signing in, `VITE_GUILD_ID` or the UID in `guilds/<VITE_GUILD_ID>/members/<UID>` is wrong. If the access check fails outright, the "Could not verify access" screen shows the Firestore error code and the guild ID the build is using.

When approving a join request, a Guild Leader can optionally connect the account to an existing roster character. Existing accounts can also be linked or reassigned from Member Access. Links use stable roster document IDs, and Firestore rules require the roster and membership references to agree. A roster character can be linked to at most one account through the Guild Leader workflow. Only main characters are offered for linking; alts cannot be linked to an account (this is a UI filter, not a rules check).

Without Firebase configuration, the app intentionally shows a setup-required screen. There is no client-side role selector that grants access.

## Roles

- **Guild Leader:** manage guild roster, raid teams, loot priorities, awards, member access, and role assignments; schedule raids and manage their own unavailable dates.
- **Raid Leader:** manage raid teams, loot priorities, and awards; view the guild roster and history; schedule raids and manage their own unavailable dates.
- **Member:** read guild data and add or remove their own AFK date ranges.

Guild Leader impersonation only narrows the visible UI to preview a role. It does not change the authenticated identity or the permissions enforced by Firestore.

## Existing local preview data

A Guild Leader can import this browser's prior local preview records from Member Access when the shared guild collections are empty. The import carries roster assignments and award-time priority snapshots. Local browser data is not uploaded automatically.

## License and credits

This is an unofficial fan project for a World of Warcraft guild. It is not affiliated with or endorsed by Blizzard Entertainment. World of Warcraft and the names, class and specialization artwork it refers to are trademarks or property of Blizzard Entertainment.

- **Code:** [MIT](LICENSE). The license covers the source code only, not the artwork below.
- **Specialization icons** (`wowspecsemojis-master/`): from [danetch/wowspecsemojis](https://github.com/danetch/wowspecsemojis), which shares the original Blizzard specialization icons as PNGs. They remain Blizzard artwork; they are used here for a non-commercial guild app and must not be used commercially.
- **Guild crest and interface artwork** (`Art/`): generated with ChatGPT (OpenAI). They are not Blizzard artwork.

## Checks

```powershell
npm run build
npm run lint
```

`npm run lint` treats warnings as errors. GitHub Actions (`.github/workflows/ci.yml`) runs both commands on every pull request and on pushes to `main`.

The Firestore and Cloud Storage rules have their own tests, which run against the local emulators and need JDK 21 (see [CONTRIBUTING.md](CONTRIBUTING.md#testing-the-firestore-rules)):

```powershell
npm run test:rules
```

CI runs them in a separate job.

The same command also runs [tests/raid-preview.test.ts](tests/raid-preview.test.ts), which checks Eastern start-time conversion (including daylight-saving transitions), character choices, own-team preview and effective unavailable responses, plus [functions/raids.test.js](functions/raids.test.js) for server authorization, persistence and concurrency. Pure checks can also run without Java: `node --test tests/raid-preview.test.ts`.
