# In-game addon work

This folder holds the guild's in-game addons for **WoW: Forever** (Lua 5.1, interface 16001). They are not part of the web build: `npm run build` and `npm run lint` do not touch this folder; the CI job "Addon lint and tests" checks it. The plan and the measured facts are in `docs/design/loot-addon.md`. The strings the addon and the Raid Desk exchange are defined in `docs/spec/exchange-v0.md`, and `docs/design/award-import.md` wins wherever the two differ.

| Path | What |
| --- | --- |
| `IntrepidManager/` | **Intrepid Manager**, the loot addon, build 0.0.19 (TOC, entry point, `core/` pure logic, `game/` the loot window, the bags, the trade and the council session, `net/` messages between players, `ui/` windows) |
| `IntrepidProbe/` | **IntrepidProbe** 0.6.3, a developer tool that records what the client offers. Not for players. See `IntrepidProbe/README.md`. |
| `tests/` | Lua 5.1 tests, their stand-ins for the game, and the window storyboards |
| `tools/` | Python tools: the exchange-string fixtures, invented test data, the API-name list and its check. See `tools/README.md`. |

## Intrepid Manager

The app holds the roster, the priority lists and the permanent record; the addon runs the loot council in the game and carries the result back as a pasted string.

- **Built:** import the night from the Raid Desk ("Copy for addon"), a council session (items offered, raiders answer within a countdown, with a note), award then trade (several items per trade, only what was won), a version check, the awards log and its export, a loot test and a message test. When the player has the community addon DungeonJournal (an optional dependency, read only), the session window says where an item drops and `/im dj` checks what the journal holds. Inside dungeons and raids the **drop log** counts which creature dropped which items (never who looted them), and `/im drops` turns it into a drops string for the Raid Desk's drop list import (the import is not built yet; `docs/design/drop-list-import.md`).
- **Not built yet:** council voting, priorities and marks in the council windows, resending after a reconnect, autopass, settings, a debug log.
- **Checked in the game:** the self-test passes on the live client (2026-11-12, Windows, build 70888). Award then trade, the version window, the import and export windows with a real paste and a session on the live client have not run yet; they need two players.

### Install (testers)

1. Copy the `IntrepidManager` folder into the live game's addons folder: the `_forever_` folder of the World of Warcraft install, then `Interface/AddOns/` (create it if it is missing).
2. Restart the game. On the character screen open **AddOns** and make sure **Intrepid Manager** is ticked.
3. In the game, `/im` lists the commands and `/im version` shows the build. A new build needs only `/reload`, unless it adds a file: then restart the game.

The game writes `WTF/Account/<account>/SavedVariables/IntrepidManager.lua` at `/reload`, logout or exit. **It contains character and guild names. Never commit it or paste it into an issue.** Report the facts instead.

## Develop

- **The client's Lua is 5.1**, without `io`, `os`, `require` or `debug`. No `goto`, no integer division, no bitwise operators. Interface number `16001`. Never set `AllowLoadGameType: classic` in a TOC: the client then hides the addon or loads it as a Classic addon.
- **Pure logic in `core/`, with tests.** Everything that does not need the game (priority order, name matching, strings) is a plain module; client calls sit in a thin layer on top.
- **Run the checks from this folder** (`cd addon`):

  ```
  lua5.1 tests/run.lua
  luacheck IntrepidManager tests
  lua5.1 tests/storyboards.lua                # draws the windows into build/pictures
  python3 -B tools/api_lint.py check
  python3 -B tools/exchange_fixtures.py check
  python3 -B tools/synthetic.py selftest
  ```

  The tests read the shared fixtures in `../docs/spec/fixtures/` (the `SPEC` path in `tests/run.lua`).
- **Lua 5.1 on a Mac.** Homebrew has no Lua 5.1 package. Build a private copy with [hererocks](https://github.com/luarocks/hererocks) (nothing is installed system-wide; deleting the folder removes it):

  ```
  python3 -m venv ~/.local/hererocks-venv
  ~/.local/hererocks-venv/bin/pip install hererocks
  ~/.local/hererocks-venv/bin/hererocks ~/.local/lua51 -l 5.1 -r latest
  ~/.local/lua51/bin/luarocks install luacheck
  export PATH="$HOME/.local/lua51/bin:$PATH"   # then lua tests/run.lua and luacheck IntrepidManager tests
  ```

  CI runs Linux Lua 5.1, which differs from the Mac in small ways (`tostring(0/0)` is `-nan` there): never assert on a printed NaN.
- **Client names need evidence.** Every name the client provides (a function, a namespace member, an event, a template, a font) needs an entry in `tools/api-known.json` naming its evidence, or an `unverified` entry that says why and what to test. Add a client global to `read_globals` in `.luacheckrc` too. The window tests use the strict stand-ins in `tests/support/strict_ui.lua`, which refuse any name that is not on the list.
- **Windows** live in `IntrepidManager/ui/`: they read a view-model and call the callbacks they are given, and never touch the loot API. Build them with `ui/Kit` and give each one a storyboard in `tests/storyboards/`; CI keeps the pictures as the `window-pictures` artifact.
- **In the game,** test with two clients when you change messaging, master loot or trading, and say in the pull request what you tried. The pattern is always: a person runs a test, the addon writes its file, someone reads the file afterwards. There is no live, automated probing of the game.

## License

MIT, like the repository. The code is our own. Do not copy code from RCLootCouncil (GPL-3.0), Gargul (All Rights Reserved) or DungeonJournal (All Rights Reserved), nor DungeonJournal's data; reading how they work to understand an idea is fine. Embedded libraries keep their own licenses.
