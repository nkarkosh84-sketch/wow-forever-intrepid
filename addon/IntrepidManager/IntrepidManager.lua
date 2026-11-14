-- Intrepid Manager: entry point. Everything that does not need the client lives in core/ and is unit tested.

local ADDON, ns = ...

local function out(text) print("|cff66ccffIntrepid Manager:|r " .. tostring(text)) end

local function addonVersion()
  local get = (C_AddOns and C_AddOns.GetAddOnMetadata) or GetAddOnMetadata
  if get then
    local ok, value = pcall(get, ADDON, "Version")
    if ok and value then return value end
  end
  return "unknown"
end
ns.version = addonVersion

-- /im selftest [label]: runs the exchange code (checksum, JSON, envelope) inside the game and times it. The result is
-- kept in IntrepidManagerDB.selftest and reaches the disk at the next /reload; tools/pull-results.sh then collects it,
-- with the label in the folder name.
local function runSelfTest(argument)
  if InCombatLockdown and InCombatLockdown() then
    out("Not in combat, please. Try again when the fight is over.")
    return
  end
  local label = string.match(argument or "", "^%s*(.-)%s*$")
  label = string.sub(string.gsub(label, "[^%w_-]+", "_"), 1, 24) -- it ends up in a folder name

  local env = { bit = bit, memory = function() return collectgarbage("count") end }
  if debugprofilestop then
    env.now, env.timer = debugprofilestop, "debugprofilestop"
  end
  out("Running the self-test. The game may pause for a second or two.")
  local result = ns.SelfTest.run(env)

  result.version = addonVersion()
  result.label = label ~= "" and label or nil
  result.ranAt = time and time() or nil
  result.serverTime = GetServerTime and GetServerTime() or nil
  if GetBuildInfo then
    local ok, version, build, _, interface = pcall(GetBuildInfo)
    if ok then result.client = { version = version, build = build, interface = interface } end
  end

  IntrepidManagerDB = IntrepidManagerDB or {}
  IntrepidManagerDB.selftest = result
  IntrepidManagerDB.run = label ~= "" and { label = label } or nil
  for _, line in ipairs(ns.SelfTest.summary(result)) do out(line) end
  out("Type /reload to save the results to a file.")
end

-- /im window [session|import|picker|confirm] [roomy] [flat]: the windows on sample data (ui/Demo.lua), to look at in the game
-- before the engine exists. Nothing is given or imported.
local demo
local function getDemo()
  if not demo then
    IntrepidManagerDB = IntrepidManagerDB or {}
    demo = ns.UI.Demo.new({ out = out, db = IntrepidManagerDB })
  end
  return demo
end

-- /im inspect: asks the game to inspect your target and records what came back (ui/Inspect.lua), for the test builds.
local inspect
local function getInspect()
  if not inspect then
    IntrepidManagerDB = IntrepidManagerDB or {}
    inspect = ns.UI.Inspect.new({ out = out, db = IntrepidManagerDB })
  end
  return inspect
end

-- /im loot [give <slot> <who>, sweep <who> [quality], stop]: reads the master loot window and gives items to a player, one at a time
-- (game/LootWindow.lua). A first slice for the test builds; nothing is wired to the session window yet.
local loot
local function getLoot()
  if not loot then
    IntrepidManagerDB = IntrepidManagerDB or {}
    loot = ns.Game.LootWindow.new({ out = out, db = IntrepidManagerDB })
  end
  return loot
end

-- Random whole numbers from 1 to n for ids. The ids of a load must differ from the ids of the loads before: the clock's milliseconds
-- are mixed into the random numbers.
local function random(n) return (math.floor(math.random() * n + (GetTime() % 1) * 1000) % n) + 1 end

-- The exchange with the Raid Desk (game/Exchange.lua): the night the loot master imported (/im import) and the awards the sessions make,
-- which /im export turns into the awards string to paste into the Raid Desk.
local council
local exchange
local exportEverything = false
local function getExchange()
  if not exchange then
    IntrepidManagerDB = IntrepidManagerDB or {}
    exchange = ns.Game.Exchange.new({
      db = IntrepidManagerDB, version = addonVersion(), random = random,
      sessionOpen = function() return council ~= nil and council.sessionOpen() end,
    })
  end
  return exchange
end

-- The view-model of the import window: the night the addon has, and whether a session blocks a new one.
local function importModel()
  return { current = getExchange().nightText(), sessionOpen = council ~= nil and council.sessionOpen() }
end

-- The optional addon DungeonJournal (game/DungeonJournal.lua): read only, and only when the player has it. It tells the loot master's
-- window where an item drops, and /im dj checks what it holds.
local journal
local function getJournal()
  if not journal then journal = ns.Game.DungeonJournal.new() end
  return journal
end
local function journalSource(itemId)
  local source = getJournal().sourceOf(itemId)
  return source and (source.boss .. ", " .. source.dungeon) or nil
end

-- The drop log (core/DropLog.lua, game/DropWatch.lua): inside dungeons and raids it counts which creature or encounter dropped which
-- items, never who looted them, for the Raid Desk's drop lists. It listens from the moment the addon loads (ADDON_LOADED below).
local dropLog, dropWatch
local function getDropLog()
  if not dropLog then
    IntrepidManagerDB = IntrepidManagerDB or {}
    dropLog = ns.DropLog.new(IntrepidManagerDB)
  end
  return dropLog
end
local function getDropWatch()
  if not dropWatch then dropWatch = ns.Game.DropWatch.new({ log = getDropLog() }) end
  return dropWatch
end

-- Where an item drops, for the loot master's window: what this client's own loot windows saw, else DungeonJournal.
local function itemSource(itemId)
  local ok, seen = pcall(function() return getDropLog().sourceOf(itemId) end)
  if ok and seen then return seen end
  return journalSource(itemId)
end

-- /im dj [list]: what DungeonJournal holds. The check is kept in IntrepidManagerDB.dj (counts and true or false only) and reaches the
-- disk at the next /reload; "list" prints its dungeons.
local function runJournal(argument)
  local word = string.lower(string.match(argument or "", "^%s*(.-)%s*$"))
  local dj = getJournal()
  if word == "list" then
    local list = dj.dungeons()
    if #list == 0 then out("DungeonJournal isn't installed or isn't loaded.") return end
    for i, entry in ipairs(list) do
      out(i .. ". " .. entry.name .. ": " .. entry.bosses .. " bosses, " .. entry.items .. " items" .. (entry.partial and " (its list is incomplete)" or ""))
    end
    return
  end
  local result = dj.check(debugprofilestop)
  result.ranAt = time and time() or nil
  result.addonVersion = addonVersion()
  IntrepidManagerDB = IntrepidManagerDB or {}
  IntrepidManagerDB.dj = result
  if not result.present then
    out("DungeonJournal isn't installed or isn't loaded." .. (result.version and (" (version " .. result.version .. " is installed)") or ""))
  else
    out("DungeonJournal " .. (result.version or "?") .. ": " .. result.dungeons .. " dungeons, " .. result.bosses .. " bosses, " .. result.items
      .. " items (" .. result.partial .. " dungeons with an incomplete list). Read in " .. string.format("%.1f", result.ms or 0) .. " ms.")
    out("/im dj list shows them.")
  end
  out("Type /reload to save the check to a file.")
end

-- /im session [add, bags, bag, list, remove, start, results, end], /im respond <item> <bis, up, os or pass> [note], /im offers: the council
-- session (game/CouncilSession.lua). Every client listens for offers from the moment the addon loads (see ADDON_LOADED below).
local function getCouncil()
  if not council then
    IntrepidManagerDB = IntrepidManagerDB or {}
    council = ns.Game.CouncilSession.new({
      out = out, db = IntrepidManagerDB, version = addonVersion(), exchange = getExchange(), sourceOf = itemSource,
    })
  end
  return council
end

-- The council windows (ui/SessionPanel, ui/BagPicker, ui/ResponseFrame) sit on the session above. They are made when first needed:
-- the session tells them through its hooks, an offer from the loot master opens the raider's frame by itself, and /im session
-- (with no word) opens the loot master's window.
local councilWindows
local dropsChoice, dropsModel -- the drops window's choice and view-model (/im drops, below)
local function getCouncilWindows()
  if councilWindows then return councilWindows end
  IntrepidManagerDB = IntrepidManagerDB or {}
  IntrepidManagerDB.positions = IntrepidManagerDB.positions or {}
  local session = getCouncil()
  local kit = ns.UI.Kit.new({
    density = "compact", chrome = "stock", positions = IntrepidManagerDB.positions,
    onError = function(err) out("window error: " .. tostring(err)) end,
  })
  local windows = {}
  windows.picker = ns.UI.BagPicker.new(kit, {
    rows = function(all) return session.scanBags(all) end,
    add = function(rows) session.addRows(rows) end,
  })
  windows.panel = ns.UI.SessionPanel.new(kit, {
    model = session.masterModel, rows = session.rowsModel,
    bags = function() windows.picker.show() end,
    remove = session.removeItem, start = function(seconds) session.start(tostring(seconds)) end,
    finish = session.finish, reset = session.reset, award = session.award, unaward = session.unaward, trade = session.trade,
    versions = session.versions,
    importNight = function() windows.import.open(importModel()) end,
    exportAwards = function() windows.export.open(getExchange().exportModel(exportEverything)) end,
  })
  windows.versions = ns.UI.VersionWindow.new(kit, { model = session.versionsModel, check = session.checkVersions })
  -- The night from the Raid Desk, and the awards back to it (docs/spec/exchange-v0.md). The import window shows the new night at once.
  windows.import = ns.UI.ImportWindow.new(kit, {
    import = function(_, result)
      local answer = getExchange().importNight(result)
      windows.import.update(importModel())
      return answer
    end,
  })
  windows.export = ns.UI.ExportWindow.new(kit, {
    everything = function(on)
      exportEverything = on
      windows.export.update(getExchange().exportModel(on))
    end,
    done = function()
      out(InCombatLockdown and InCombatLockdown() and "Type /reload when the fight is over, so the game writes your awards to its file."
        or "Type /reload so the game writes your awards to its file.")
    end,
  })
  windows.drops = ns.UI.DropsWindow.new(kit, {
    journal = function(on)
      dropsChoice.includeJournal = on
      windows.drops.update(dropsModel())
    end,
  })
  windows.offers = ns.UI.ResponseFrame.new(kit, {
    model = session.offerModel,
    answer = function(sid, n, code, note) session.answer(n, code, note, sid) end,
  })
  councilWindows = windows
  return windows
end

-- What the session tells the windows. They are only made when something needs one, and only repainted when they are on screen.
local function wireCouncilWindows()
  local session = getCouncil()
  local function repaintPanel()
    if councilWindows and councilWindows.panel.isShown() then councilWindows.panel.update(session.masterModel()) end
  end
  local function repaintOffers()
    if councilWindows and councilWindows.offers.isShown() then councilWindows.offers.update(session.offerModel()) end
  end
  local hooks = session.hooks
  hooks.onOffer = function()
    local windows = getCouncilWindows()
    windows.offers.update(session.offerModel())
    windows.offers.show()
  end
  hooks.onOfferChanged = repaintOffers
  hooks.onQueueChanged = repaintPanel
  hooks.onSessionStarted = repaintPanel
  hooks.onResponse = repaintPanel
  hooks.onHello = repaintPanel
  -- An award or a delivery changes the awards string: the export window, when it is on screen, shows the new one.
  local function repaintExport()
    if councilWindows and councilWindows.export.isShown() then councilWindows.export.update(getExchange().exportModel(exportEverything)) end
  end
  hooks.onAwarded = function()
    repaintPanel()
    repaintExport()
  end
  hooks.onGiven = hooks.onAwarded
  hooks.onEnd = function()
    repaintPanel()
    repaintOffers()
  end
  -- Every offer is over (the time ran out or the loot master ended the session): the answer window shows what was answered for a
  -- moment and closes by itself.
  hooks.onOffersClosed = function()
    if not councilWindows then return end
    councilWindows.offers.update(session.offerModel())
    C_Timer.After(2, function()
      if councilWindows and session.openOffers() == 0 then councilWindows.offers.hide() end
    end)
  end
  hooks.onOpen = function()
    local windows = getCouncilWindows()
    windows.panel.update(session.masterModel())
    windows.panel.show()
  end
  -- The versions heard changed (an announce, an answer to the check, the group): repaint the version window when it is on screen.
  hooks.onVersions = function()
    if councilWindows and councilWindows.versions.isShown() then councilWindows.versions.update(session.versionsModel()) end
  end
  hooks.onVersionsOpen = function()
    local windows = getCouncilWindows()
    windows.versions.update(session.versionsModel())
    windows.versions.show()
  end
end

-- /im drops [list, all, <numbers> or dj <dungeon>]: the drops string for the Raid Desk's drop list import (core/Drops.lua), in the drops
-- window. Which zones it holds is remembered until the next /im drops.
local DROPS_NOTICE = "The Raid Desk cannot import drops strings yet (LOOT-008): this one is for testing."
local DAY = 86400
dropsChoice = { days = 7, scope = "seen in the last 7 days", includeJournal = false }

local function journalOptions(dj)
  return { version = dj.version(), zoneFor = function(name)
    local found = dj.find(name)
    return found and dj.zone(found) or nil
  end }
end

function dropsModel()
  local dj = getJournal()
  local at = GetServerTime()
  local options = {
    at = at, id = ns.Ids.dropsId(at, random), version = addonVersion(),
    dateOf = function(t) return date("!%Y-%m-%d", t) end,
    keys = dropsChoice.keys, extra = dropsChoice.extra,
  }
  if not options.keys and dropsChoice.days then options.since = at - dropsChoice.days * DAY end
  local journalOn = dj.available()
  if journalOn and (dropsChoice.includeJournal or dropsChoice.extra) then
    options.journal = journalOptions(dj)
    if not dropsChoice.includeJournal then options.journal.zoneFor = nil end
  end
  pcall(getDropLog().settle, at) -- the corpses held for their rolls longer than the wait count as creatures now
  local model, counts = ns.Drops.build(getDropLog().store(), options)
  local vm = {
    zones = counts.zones, sources = counts.sources, seen = counts.seen, journal = counts.journal, scope = dropsChoice.scope,
    journalAvailable = journalOn, includeJournal = dropsChoice.includeJournal and journalOn, notice = DROPS_NOTICE,
  }
  if counts.zones > 0 then vm.text = ns.Drops.encode(model) end
  return vm
end

local function openDrops()
  local vm = dropsModel()
  getCouncilWindows().drops.open(vm)
  return vm
end

local function runDrops(argument)
  local text = string.match(argument or "", "^%s*(.-)%s*$")
  local word, rest = string.match(text, "^(%S*)%s*(.-)$")
  word = string.lower(word or "")
  local zones = getDropLog().zones()
  if word == "list" then
    if #zones == 0 then
      out("The drop log is empty. It records loot windows inside dungeons and raids.")
      return
    end
    for i, zone in ipairs(zones) do
      out(i .. ". " .. zone.name .. " (" .. zone.kind .. (zone.players and (", " .. zone.players .. " players") or "") .. "): "
        .. zone.creatures .. (zone.creatures == 1 and " creature" or " creatures") .. ", " .. zone.bosses .. (zone.bosses == 1 and " boss" or " bosses")
        .. ", " .. zone.items .. (zone.items == 1 and " item" or " items") .. (zone.last and (", last seen " .. date("!%Y-%m-%d", zone.last)) or ""))
    end
    out("/im drops 1 3 exports those zones; /im drops all exports every zone.")
    return
  end
  if word == "" then
    dropsChoice.keys, dropsChoice.extra, dropsChoice.days, dropsChoice.scope = nil, nil, 7, "seen in the last 7 days"
  elseif word == "all" then
    dropsChoice.keys, dropsChoice.extra, dropsChoice.days, dropsChoice.scope = nil, nil, nil, "(all of them)"
  elseif word == "dj" then
    local dj = getJournal()
    if not dj.available() then
      out("DungeonJournal isn't installed or isn't loaded.")
      return
    end
    local found = dj.find(rest)
    local zone = found and dj.zone(found)
    if not zone then
      out("DungeonJournal has no dungeon called '" .. string.sub(string.gsub(rest, "|", ""), 1, 40) .. "'. /im dj list shows them.")
      return
    end
    dropsChoice.keys, dropsChoice.extra, dropsChoice.days, dropsChoice.scope = {}, { zone }, nil, "from DungeonJournal"
  elseif string.find(text, "^[%d%s,]+$") then
    local keys = {}
    for n in string.gmatch(text, "%d+") do
      local zone = zones[tonumber(n)]
      if not zone then
        out("There is no zone " .. n .. ". /im drops list shows them.")
        return
      end
      keys[#keys + 1] = zone.key
    end
    dropsChoice.keys, dropsChoice.extra, dropsChoice.days, dropsChoice.scope = keys, nil, nil, "picked"
  else
    out("/im drops exports the zones seen in the last 7 days; /im drops list numbers the zones; /im drops 1 3 exports those; /im drops all every zone; /im drops dj <dungeon> DungeonJournal's list of one dungeon.")
    return
  end
  local vm = openDrops()
  out(ns.UI.DropsWindow.summary(vm))
end

-- /im msgtest [run, stop or clear]: measures addon messages between two clients in a group (net/MsgTest.lua). The client that does
-- not run it still listens and answers from the start (see ADDON_LOADED below), so the second client needs no command.
local msgtest
local function getMsgTest()
  if not msgtest then
    IntrepidManagerDB = IntrepidManagerDB or {}
    msgtest = ns.Net.MsgTest.new({ out = function(text) out(text) end, db = IntrepidManagerDB })
  end
  return msgtest
end

-- /im facts [label]: opens the sample windows, measures what the game's own widgets and fonts and those windows really are
-- (ui/Facts.lua) and keeps the result in IntrepidManagerDB.facts. Like the self-test, it reaches the disk at the next /reload.
local function runFacts(argument)
  if InCombatLockdown and InCombatLockdown() then
    out("Not in combat, please. Try again when the fight is over.")
    return
  end
  local label = string.match(argument or "", "^%s*(.-)%s*$")
  label = string.sub(string.gsub(label, "[^%w_-]+", "_"), 1, 24) -- it ends up in a folder name
  local current = getDemo()
  local frames = current.showAll()
  out("Measuring the game's widgets and the sample windows. This takes a couple of seconds.")
  local result = ns.UI.Facts.run({
    windows = frames,
    done = function(finished)
      current.hideAll()
      for _, line in ipairs(ns.UI.Facts.summary(finished)) do out(line) end
      out("Type /reload to save the results to a file.")
    end,
  })
  result.version = addonVersion()
  result.label = label ~= "" and label or nil
  result.ranAt = time and time() or nil
  IntrepidManagerDB.facts = result
  IntrepidManagerDB.run = label ~= "" and { label = label } or nil
end

local function handle(input)
  local command, argument = string.match(input or "", "^%s*(%S*)%s*(.-)%s*$")
  command = string.lower(command or "")
  if command == "version" then
    out("version " .. addonVersion())
  elseif command == "selftest" then
    runSelfTest(argument)
  elseif command == "window" then
    getDemo().open(argument)
  elseif command == "facts" then
    runFacts(argument)
  elseif command == "inspect" then
    getInspect().run()
  elseif command == "msgtest" then
    getMsgTest().command(argument)
  elseif command == "loot" then
    getLoot().command(argument)
  elseif command == "session" then
    getCouncil().command(argument)
  elseif command == "versions" then
    getCouncil().versions()
  elseif command == "respond" then
    getCouncil().respond(argument)
  elseif command == "import" then
    getCouncilWindows().import.open(importModel())
  elseif command == "export" then
    local vm = getExchange().exportModel(exportEverything)
    out(vm.count == 0 and "No awards to export yet." or (vm.count .. (vm.count == 1 and " award" or " awards") .. " to export."))
    getCouncilWindows().export.open(vm)
  elseif command == "award" then
    getCouncil().awardCommand(argument)
  elseif command == "trade" then
    getCouncil().tradeCommand(argument)
  elseif command == "dj" then
    runJournal(argument)
  elseif command == "drops" then
    runDrops(argument)
  elseif command == "offers" then
    getCouncil().offers()
    local windows = getCouncilWindows()
    windows.offers.update(getCouncil().offerModel())
    windows.offers.show()
  else
    out("version " .. addonVersion() .. ". Commands: /im version, /im selftest [label], /im window [session, import, export, icons, picker or confirm] [roomy] [flat], /im facts [label], /im inspect, /im msgtest [run, stop or clear], /im loot [give, sweep or stop], /im session [add, bags, start, results or end], /im respond, /im offers, /im award <item> <name>, /im trade <name>, /im versions, /im import, /im export, /im dj [list], /im drops [list, all, <numbers> or dj <dungeon>]")
  end
end

SLASH_INTREPIDMANAGER1 = "/im"
SLASH_INTREPIDMANAGER2 = "/intrepidmanager"
SlashCmdList["INTREPIDMANAGER"] = function(input)
  -- Never let an error here reach the player mid-raid.
  local ok, err = pcall(handle, input)
  if not ok then out("error: " .. tostring(err)) end
end

local frame = CreateFrame("Frame")
frame:RegisterEvent("ADDON_LOADED")
frame:SetScript("OnEvent", function(_, event, name)
  if event == "ADDON_LOADED" and name == ADDON then
    IntrepidManagerDB = IntrepidManagerDB or {}
    IntrepidManagerDB.schema = IntrepidManagerDB.schema or 1
    IntrepidManagerDB.addonVersion = addonVersion() -- so a saved file says which build wrote it
    local ok, err = pcall(function() getMsgTest().listen() end)
    if not ok then out("message test could not start listening: " .. tostring(err)) end
    local lootOk, lootErr = pcall(function() getLoot().listen() end)
    if not lootOk then out("the loot test could not start listening: " .. tostring(lootErr)) end
    local dropsOk, dropsErr = pcall(function() getDropWatch().listen() end)
    if not dropsOk then out("the drop log could not start listening: " .. tostring(dropsErr)) end
    local councilOk, councilErr = pcall(function()
      getCouncil().listen()
      wireCouncilWindows()
    end)
    if not councilOk then out("the council session could not start listening: " .. tostring(councilErr)) end
  end
end)
