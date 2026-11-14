-- The whole addon, loaded the way the game loads it: every file of the TOC in its order, against the strict stand-in widgets,
-- then the slash commands from the first line to the last. A file that fails to load, a name used before it is made, or a
-- command that cannot get through its first run shows here and not in the game. Invented names only.

local UI = dofile("tests/support/strict_ui.lua")
local StockTemplates = dofile("tests/support/stock_templates.lua")
local FakeChat = dofile("tests/support/fake_chat.lua")
local FakeLoot = dofile("tests/support/fake_loot.lua")
local FakeTrade = dofile("tests/support/fake_trade.lua")

local function tocFiles()
  local files = {}
  for line in string.gmatch(read_file("IntrepidManager/IntrepidManager.toc"), "[^\r\n]+") do
    if not string.find(line, "^#") and string.find(line, "%.lua$") then files[#files + 1] = (string.gsub(line, "\\", "/")) end
  end
  return files
end

-- A field of the TOC ("Version"), as the game's C_AddOns.GetAddOnMetadata gives it.
local function tocField(field)
  return string.match(read_file("IntrepidManager/IntrepidManager.toc"), "## " .. field .. ": *([^\r\n]*)")
end

-- The addon loaded, ADDON_LOADED sent; game.say("window") types /im window.
local function load(options)
  options = options or {}
  -- (the facts run asks the game for many things on purpose that no window calls, so the list is the full one here)
  local game = StockTemplates.install(UI.new({ known = UI.full_known() }))
  if options.chat then options.chat.join(game, "Jorren Ashvale") end
  if options.loot then options.loot(game) end
  if options.prepare then options.prepare(game) end
  local ns = {}
  game.env.GetBuildInfo = function() return "1.60.1", "70425", "Oct 15 2026", 16001 end
  game.env.InCombatLockdown = function() return false end
  game.env.C_AddOns = { GetAddOnMetadata = function(_, field) return tocField(field) end }
  for _, file in ipairs(tocFiles()) do game.load("IntrepidManager/" .. file, ns) end
  game.send("ADDON_LOADED", "IntrepidManager")
  function game.say(input) game.env.SlashCmdList.INTREPIDMANAGER(input) end
  function game.output() return table.concat(game.printed, "\n") end
  game.ns = ns
  return game
end

test("every file of the TOC exists, and the TOC lists the files of the folders", function()
  local listed = {}
  for _, file in ipairs(tocFiles()) do
    listed[file] = true
    is_true(io.open("IntrepidManager/" .. file, "rb") ~= nil)
  end
  local handle = io.popen("cd IntrepidManager && ls core/*.lua game/*.lua net/*.lua ui/*.lua IntrepidManager.lua")
  for file in handle:lines() do
    if not listed[file] then error(file .. " is not in the TOC") end
  end
  handle:close()
end)

test("the addon loads in the order of the TOC and sets up its saved variables", function()
  local game = load()
  is_true(game.env.SlashCmdList.INTREPIDMANAGER ~= nil)
  eq(game.env.IntrepidManagerDB.schema, 1)
  for _, name in ipairs({ "Kit", "Sample", "Confirm", "Picker", "SessionWindow", "ImportWindow", "ExportWindow", "IconWindow", "Inspect", "Demo", "Facts" }) do
    is_true(game.ns.UI[name] ~= nil)
  end
  game.say("")
  is_true(string.find(game.output(), "/im window", 1, true) ~= nil)
  is_true(string.find(game.output(), "/im facts", 1, true) ~= nil)
end)

test("/im window opens each window from the slash command on strict widgets, and nothing raises", function()
  local game = load()
  for _, words in ipairs({ "", "40", "unconfirmed", "failed", "observed", "warning", "roomy", "roomy flat", "import", "import sample",
      "import busy sample", "export", "export busy roomy", "icons", "roomy icons flat", "picker", "confirm", "flat", "compact" }) do
    game.say("window " .. words)
  end
  game.say("window sideways")
  eq(string.find(game.output(), "error: ", 1, true), nil)
  is_true(string.find(game.output(), "I do not know 'sideways'", 1, true) ~= nil)
  deep_eq(game.audit(), {})
end)

test("/im facts runs the whole measuring on strict widgets through the slash command and keeps the result", function()
  local game = load()
  game.say("facts first run")
  is_true(string.find(game.output(), "Measuring the game's widgets", 1, true) ~= nil)
  local facts = game.env.IntrepidManagerDB.facts
  eq(facts.done, nil)
  game.advance(3)
  eq(facts.done, true)
  eq(facts.label, "first_run")
  eq(facts.version, tocField("Version"))
  is_true(facts.version ~= "unknown")
  eq(game.env.IntrepidManagerDB.run.label, "first_run")
  eq(#facts.notes, 0)
  eq(#facts.edit.steps, 5)
  is_true(#facts.windows.session.labels > 20)
  is_true(#facts.windows.import.labels >= 4)
  is_true(#facts.windows.export.labels >= 4)
  eq(string.find(game.output(), "error: ", 1, true), nil)
  is_true(string.find(game.output(), "Type /reload to save the results to a file.", 1, true) ~= nil)
  -- the sample windows are closed again afterwards
  for _, frame in pairs(game.ns.UI.Demo and { game.named.IntrepidManagerSession, game.named.IntrepidManagerImport, game.named.IntrepidManagerPicker, game.named.IntrepidManagerConfirm, game.named.IntrepidManagerExport }) do
    eq(game.visible(frame), false)
  end
end)

test("/im inspect tells what to do without a target, and does not raise", function()
  local game = load()
  game.env.UnitExists = function() return false end
  game.say("inspect")
  is_true(string.find(game.output(), "Target a player first, then type /im inspect.", 1, true) ~= nil)
  eq(string.find(game.output(), "error: ", 1, true), nil)
end)

test("the chat lines of the commands have no pipe characters except the color codes in front", function()
  local game = load()
  game.say("")
  game.say("window")
  game.say("window import sample")
  game.say("window sideways")
  game.say("facts")
  game.advance(3)
  for _, line in ipairs(game.printed) do eq((string.gsub(line, "^|cff66ccffIntrepid Manager:|r ", "")):find("|", 1, true), nil) end
end)

test("the whole addon listens for the message test from the first moment, and /im msgtest answers and runs", function()
  local world = FakeChat.new()
  local game = load({ chat = world })
  eq(game.env.IntrepidManagerDB.msgtest.prefixResult, "Success")
  eq(game.env.IntrepidManagerDB.msgtest.prefixResult2, "Success")
  eq(string.find(game.output(), "could not start listening", 1, true), nil)
  game.say("msgtest")
  is_true(string.find(game.output(), "prefix registered, idle", 1, true) ~= nil)
  game.say("msgtest run") -- nobody else is in the group: the first ping stays unanswered
  game.advance(5)
  is_true(string.find(game.output(), "nobody answered", 1, true) ~= nil)
  is_true(string.find(game.output(), "/im msgtest [run, stop or clear]", 1, true) == nil) -- (that is the help line, not this output)
  game.say("")
  is_true(string.find(game.output(), "/im msgtest [run, stop or clear]", 1, true) ~= nil)
  eq(string.find(game.output(), "error: ", 1, true), nil)
end)

test("a client without the message API still loads and says why the message test cannot listen", function()
  local game = load()
  is_true(string.find(game.output(), "message test could not start listening", 1, true) ~= nil)
  eq(game.env.IntrepidManagerDB.schema, 1)
  game.say("msgtest run")
  game.say("msgtest") -- the slash command keeps answering after a failure: errors become a chat line
  is_true(string.find(game.output(), "error: ", 1, true) ~= nil)
end)

test("/im loot lists the loot window and sweeps it from the slash command, on the whole addon", function()
  local loot
  local game = load({ loot = function(g) loot = FakeLoot.install(g, { items = { { id = 41, name = "Ruined Pelt", quality = 0 }, { id = 42, name = "Odd Ring", quality = 2 } } }) end })
  game.say("loot")
  is_true(string.find(game.output(), "slot 1: ", 1, true) ~= nil)
  is_true(string.find(game.output(), "(Poor)", 1, true) ~= nil)
  game.say("loot sweep other")
  game.advance(2)
  is_true(string.find(game.output(), "done: 1 of 1 given", 1, true) ~= nil)
  eq(#loot.gives, 1)
  eq(loot.gives[1].slot, 1)
  eq(game.env.IntrepidManagerDB.loottest.sweeps[1].given, 1)
  game.say("loot dance")
  is_true(string.find(game.output(), "commands: /im loot (the slots)", 1, true) ~= nil)
  game.say("")
  is_true(string.find(game.output(), "/im loot [give, sweep or stop]", 1, true) ~= nil)
  eq(string.find(game.output(), "error: ", 1, true), nil)
end)

-- A visible button of the game with this text.
local function buttonWith(game, label)
  for _, widget in ipairs(game.frames) do
    local mine = game.state(widget)
    if mine.kind == "Button" and mine.text == label and game.visible(widget) then return widget end
  end
end

test("the council windows work through the slash commands on the whole addon: pick from the bags, start, answer in the frame, end", function()
  local world = FakeChat.new()
  local bags = { [0] = {
    [1] = { id = 401, name = "Crown of the Fallen", quality = 4, bound = true, trade = "3 |4hour:hrs; 59 min" },
    [2] = { id = 402, name = "Ruined Pelt", quality = 0, bound = false },
  } }
  local game = load({ chat = world, prepare = function(g)
    local env = g.env
    env.C_Container = {
      GetContainerNumSlots = function(bag) return bags[bag] and 4 or 0 end,
      GetContainerItemInfo = function(bag, slot)
        local entry = bags[bag] and bags[bag][slot]
        if not entry then return nil end
        return { hyperlink = "|cffa335ee|Hitem:" .. entry.id .. "::::::::70:::::|h[" .. entry.name .. "]|h|r", itemID = entry.id, quality = entry.quality, isBound = entry.bound }
      end,
    }
    env.C_TooltipInfo = { GetBagItem = function(bag, slot)
      local entry = bags[bag] and bags[bag][slot]
      if not entry or not entry.trade then return { lines = {} } end
      return { lines = { { leftText = "You may trade this item with players that were also eligible to loot this item for the next " .. entry.trade .. " (including time offline)." } } }
    end }
    env.C_Item = { GetItemIconByID = function(id) return 133000 + id end }
    env.GameTooltip = { SetOwner = function() end, SetHyperlink = function() end, Show = function() end, Hide = function() end }
    env.UnitClass = function() return "Mage", "MAGE" end
  end })
  eq(string.find(game.output(), "could not start listening", 1, true), nil)
  game.say("session") -- no word: the loot master's window
  local panel = game.named.IntrepidManagerLootSession
  is_true(game.visible(panel))
  is_true(buttonWith(game, "Start session") ~= nil)
  game.fire(buttonWith(game, "Add from bags"), "OnClick", "LeftButton")
  local picker = game.named.IntrepidManagerBags
  is_true(game.visible(picker))
  -- the better items first: only the Crown; nothing is ticked
  game.fire(buttonWith(game, "Add selected") or buttonWith(game, "Refresh"), "OnClick", "LeftButton")
  local pick
  for _, widget in ipairs(game.frames) do
    if game.state(widget).kind == "Button" and game.state(widget).parent and game.visible(widget) and game.state(widget).width > 300 and game.state(widget).height <= 40 then pick = pick or widget end
  end
  is_true(pick ~= nil)
  game.fire(pick, "OnClick", "LeftButton")
  game.fire(buttonWith(game, "Add selected (1)"), "OnClick", "LeftButton")
  eq(game.visible(picker), false)
  is_true(string.find(game.output(), "queued 1. ", 1, true) ~= nil)
  game.fire(buttonWith(game, "Start session"), "OnClick", "LeftButton")
  is_true(string.find(game.output(), "started: 1 item, 60 seconds.", 1, true) ~= nil)
  local offers = game.named.IntrepidManagerOffers
  is_true(game.visible(offers)) -- the loot master is offered too
  game.fire(buttonWith(game, "Upgrade"), "OnClick", "LeftButton")
  is_true(string.find(game.output(), "item 1: Upgrade", 1, true) ~= nil)
  is_true(buttonWith(game, "End session") ~= nil)
  game.fire(buttonWith(game, "End session"), "OnClick", "LeftButton")
  is_true(string.find(game.output(), "over (you ended it): 1 raider answered.", 1, true) ~= nil)
  is_true(game.visible(offers)) -- it stays a moment, showing what was answered
  game.advance(2.5)
  eq(game.visible(offers), false) -- and closes by itself once nothing is on offer
  is_true(buttonWith(game, "New session") ~= nil)
  game.fire(buttonWith(game, "New session"), "OnClick", "LeftButton")
  is_true(buttonWith(game, "Start session") ~= nil)
  eq(string.find(game.output(), "error: ", 1, true), nil)
  eq(string.find(game.output(), "window error", 1, true), nil)
  deep_eq(game.audit(), {})
end)

-- Every text shown in a widget and its children and regions.
local function shownTexts(game, widget, found)
  found = found or {}
  local mine = game.state(widget)
  if mine.kind == "FontString" and mine.text and game.visible(widget) then found[#found + 1] = mine.text end
  for _, region in ipairs(mine.regions) do shownTexts(game, region, found) end
  for _, child in ipairs(mine.children) do shownTexts(game, child, found) end
  return found
end

test("/im versions on the whole addon opens the version window, asks the group, and lists who answered and who has no addon", function()
  local world = FakeChat.new()
  local other = UI.new()
  world.join(other, "Mirelle Dunmore").class = "MAGE"
  local game = load({ chat = world, prepare = function(g) g.env.UnitClass = function() return "Warrior", "WARRIOR" end end })
  eq(string.find(game.output(), "could not start listening", 1, true), nil)
  game.say("versions")
  local window = game.named.IntrepidManagerVersions
  is_true(game.visible(window))
  local texts = table.concat(shownTexts(game, window), "|")
  is_true(string.find(texts, "Jorren Ashvale", 1, true) ~= nil)
  is_true(string.find(texts, "Mirelle Dunmore", 1, true) ~= nil)
  is_true(string.find(texts, "ASKING THE GROUP...", 1, true) ~= nil)
  is_true(string.find(texts, "waiting...", 1, true) ~= nil)
  game.advance(6)
  texts = table.concat(shownTexts(game, window), "|")
  is_true(string.find(texts, "not installed", 1, true) ~= nil)
  is_true(string.find(texts, "YOUR GROUP", 1, true) ~= nil)
  is_true(string.find(texts, "You have " .. tocField("Version"), 1, true) ~= nil)
  -- the button of the loot master's window does the same
  game.say("session")
  local before = #world.delivered
  game.fire(buttonWith(game, "Versions"), "OnClick", "LeftButton")
  world.advance(1)
  is_true(#world.delivered > before)
  game.fire(buttonWith(game, "Check again"), "OnClick", "LeftButton")
  eq(string.find(game.output(), "error: ", 1, true), nil)
  eq(string.find(game.output(), "window error", 1, true), nil)
  deep_eq(game.audit(), {})
end)

test("on the whole addon the loot master awards an item, trades with the winner from the window, and the item shows as given", function()
  local world = FakeChat.new()
  local other = UI.new()
  world.join(other, "Mirelle Dunmore").class = "MAGE"
  local trade
  local game = load({ chat = world, prepare = function(g)
    trade = FakeTrade.install(g, { bags = { [0] = { [1] = { id = 101, name = "Crown of the Fallen" }, [2] = { id = 102, name = "Ring of Ash" } } } })
    g.env.C_Item = { GetItemIconByID = function(id) return 133000 + id end }
    g.env.GameTooltip = { SetOwner = function() end, SetHyperlink = function() end, Show = function() end, Hide = function() end }
  end })
  eq(string.find(game.output(), "could not start listening", 1, true), nil)
  game.say("session add " .. FakeTrade.link(101, "Crown of the Fallen") .. " " .. FakeTrade.link(102, "Ring of Ash"))
  game.say("session start 30")
  game.say("session") -- the loot master's window
  local panel = game.named.IntrepidManagerLootSession
  is_true(game.visible(panel))
  game.say("award 1 Mirelle Dunmore")
  is_true(string.find(game.output(), "is awarded to Mirelle Dunmore.", 1, true) ~= nil)
  -- the winner has a row of her own in the window, with Trade and an x; nothing is traded before the button
  eq(#trade.calls, 0)
  local button = buttonWith(game, "Trade")
  is_true(button ~= nil)
  is_true(buttonWith(game, "x") ~= nil)
  game.fire(button, "OnClick", "LeftButton")
  deep_eq(trade.calls[1], { "initiate", "party1" })
  world.advance(3)
  is_true(trade.slots[1] ~= nil and string.find(trade.slots[1], "Hitem:101:", 1, true) ~= nil)
  eq(trade.slots[2], nil) -- item 2 was not won by anybody and stays in the bags
  is_true(string.find(game.output(), "Mirelle Dunmore can have the item: it is in the trade window.", 1, true) ~= nil)
  trade.accept()
  world.advance(3)
  local texts = table.concat(shownTexts(game, panel), "|")
  is_true(string.find(texts, "given", 1, true) ~= nil)
  eq(buttonWith(game, "Trade"), nil) -- nothing left to trade
  eq(string.find(game.output(), "error: ", 1, true), nil)
  eq(string.find(game.output(), "window error", 1, true), nil)
  deep_eq(game.audit(), {})
end)

-- The first widget below `widget` (itself included) for which `test` is true.
local function findBelow(game, widget, test)
  local mine = game.state(widget)
  if test(mine, widget) then return widget end
  for _, list in ipairs({ mine.regions, mine.children }) do
    for _, child in ipairs(list) do
      local found = findBelow(game, child, test)
      if found then return found end
    end
  end
end

test("on the whole addon the night from the Raid Desk is imported in its window, the awards of a session are exported, and the string reads", function()
  local nightText = read_file(SPEC .. "fixtures/synthetic/night.j.txt")
  local reader = load_core({}, "Crc32", "Json", "Envelope", "Ids", "Check", "Night")
  local member = reader.Night.read(nightText).roster[1] -- somebody of the night's roster is in the group
  local world = FakeChat.new()
  world.join(UI.new(), member.name .. " " .. member.surname).class = "MAGE"
  local game = load({ chat = world, prepare = function(g)
    FakeTrade.install(g, { bags = { [0] = { [1] = { id = 900001, name = "Blade of the Fixture" } } } })
    g.env.C_Item = { GetItemIconByID = function(id) return 133000 + id end }
    g.env.GameTooltip = { SetOwner = function() end, SetHyperlink = function() end, Show = function() end, Hide = function() end }
    g.env.GetServerTime = function() return 1796867000 + math.floor(g.clock) end
  end })
  eq(string.find(game.output(), "could not start listening", 1, true), nil)
  -- the import window takes the pasted night
  game.say("import")
  local window = game.named.IntrepidManagerImport
  is_true(game.visible(window))
  local box = findBelow(game, window, function(mine) return mine.kind == "EditBox" end)
  game.paste(box, nightText)
  game.advance(1)
  local importButton = buttonWith(game, "Import")
  is_true(importButton ~= nil)
  game.fire(importButton, "OnClick", "LeftButton")
  local db = game.env.IntrepidManagerDB
  is_true(db.night ~= nil)
  eq(db.night.phase, 1)
  eq(#db.night.priorities, 24)
  is_true(table.concat(shownTexts(game, window), "|"):find("In the addon now: Night of 2026-12-09", 1, true) ~= nil)
  -- a session, an award of the first priority's item to somebody of the night's roster, the trade
  game.say("session add " .. FakeTrade.link(900001, "Blade of the Fixture"))
  game.say("session start 30")
  game.say("award 1 " .. member.name .. " " .. member.surname)
  eq(db.awards.log[1].toId, member.id)
  game.say("export")
  local export = game.named.IntrepidManagerExport
  is_true(game.visible(export))
  local text = findBelow(game, export, function(mine) return mine.kind == "EditBox" end)
  local shown = game.state(text).text
  is_true(string.sub(shown, 1, 13) == "IM1:awards:j:")
  local exchange = game.ns.Game.Exchange.new({ db = {} })
  eq(exchange.verify(shown), 1)
  local read = game.ns.Envelope.read(shown, "awards")
  eq(read.model.awards[1].itemId, 900001)
  eq(read.model.awards[1].delivery.state, "assigned")
  eq(read.model.awards[1].phase, 1)
  eq(read.model.awards[1].raid, "raid-20261209")
  eq(read.model.awards[1].toId, member.id)
  local priority
  for _, p in ipairs(db.night.priorities) do
    if p.itemId == 900001 then priority = p end
  end
  eq(read.model.awards[1].priority, priority.id)
  eq(string.find(game.output(), "error: ", 1, true), nil)
  eq(string.find(game.output(), "window error", 1, true), nil)
  deep_eq(game.audit(), {})
end)

test("/im award and /im trade answer on the whole addon: no session yet, and the help names both", function()
  local world = FakeChat.new()
  local game = load({ chat = world })
  game.say("trade")
  is_true(string.find(game.output(), "there is no session.", 1, true) ~= nil)
  game.say("trade Mirelle Dunmore")
  is_true(string.find(game.output(), "there is no session to give items from.", 1, true) ~= nil)
  game.say("award 1 Mirelle Dunmore")
  is_true(string.find(game.output(), "there is no session to award from.", 1, true) ~= nil)
  game.say("award banana")
  is_true(string.find(game.output(), "use /im award <item number> <name>", 1, true) ~= nil)
  game.say("trade stop")
  is_true(string.find(game.output(), "Trade: nothing is running.", 1, true) ~= nil)
  game.say("")
  is_true(string.find(game.output(), "/im award <item> <name>, /im trade <name>", 1, true) ~= nil)
  eq(string.find(game.output(), "error: ", 1, true), nil)
end)

test("/im drops on the whole addon: a boss killed and looted in a dungeon, then the drops window holds it; every word runs", function()
  local BOSS = 990011
  local corpse = "Creature-0-4170-389-12-" .. BOSS .. "-0000000001"
  local game = load({ loot = function(g)
    FakeLoot.install(g, { items = {} })
    local env = g.env
    env.IsInInstance = function() return true, "party" end
    env.GetInstanceInfo = function() return "Hollow Test Keep", "party", 1, "Normal", 5, 0, false, 9100 end
    env.UnitGUID = function(unit) if unit == "boss1" then return corpse end end
    env.C_LootHistory = { GetSortedDropsForEncounter = function() return {} end }
    env.C_Item = { GetItemIconByID = function(id) return 133000 + id end, GetItemInfo = function() return nil end }
    env.GameTooltip = { SetOwner = function() end, SetHyperlink = function() end, Show = function() end, Hide = function() end }
  end })
  game.say("drops")
  is_true(string.find(game.output(), "Nothing to export yet", 1, true) ~= nil)
  game.say("drops list")
  is_true(string.find(game.output(), "The drop log is empty.", 1, true) ~= nil)

  game.send("ENCOUNTER_START", 3001, "The Fixture Warden", 1, 5)
  game.send("ENCOUNTER_END", 3001, "The Fixture Warden", 1, 5, 1)
  local loot = FakeLoot.install(game, { items = { { id = 900101, name = "Fixture Robe", quality = 3, source = corpse } } })
  game.send("LOOT_READY", false)
  loot.close()

  game.say("drops list")
  is_true(string.find(game.output(), "1. Hollow Test Keep (dungeon, 5 players): 1 creature, 1 boss, 1 item", 1, true) ~= nil)
  game.say("drops")
  is_true(string.find(game.output(), "1 zone seen in the last 7 days: 1 creature, 1 item seen in the game.", 1, true) ~= nil)
  local text
  for _, frame in ipairs(game.frames) do
    local state = game.state(frame)
    if type(state.text) == "string" and string.find(state.text, "^IM1:drops:") then text = state.text end
  end
  is_true(text ~= nil)
  local read = game.ns.Envelope.read(text, "drops")
  is_true(read.ok)
  eq(read.model.zones[1].sources[1].name, "The Fixture Warden")
  eq(read.model.zones[1].sources[1].itemIds[1], 900101)
  is_true(game.ns.Drops.check(read.model).ok)
  -- every other word: no error reaches the chat
  for _, words in ipairs({ "drops all", "drops 1", "drops 1, 1", "drops 7", "drops dj Hollow Test Keep", "drops nonsense" }) do game.say(words) end
  is_true(string.find(game.output(), "There is no zone 7.", 1, true) ~= nil)
  is_true(string.find(game.output(), "DungeonJournal isn't installed or isn't loaded.", 1, true) ~= nil)
  is_true(string.find(game.output(), "/im drops exports the zones seen in the last 7 days", 1, true) ~= nil)
  eq(string.find(game.output(), "error: ", 1, true), nil)
  eq(string.find(game.output(), "the drop log could not start", 1, true), nil) -- (this test has no chat stand-in, so the message test may not start)
  deep_eq(game.audit(), {})
  -- the boss's item now says where it drops, from this client's own window
  eq(game.env.IntrepidManagerDB.drops.zones["9100:1"].sources["n" .. BOSS].items[900101].n, 1)
end)
