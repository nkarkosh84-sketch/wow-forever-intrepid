-- The reader of the optional addon DungeonJournal (IntrepidManager/game/DungeonJournal.lua), against an invented journal of the same
-- shape. Nothing of the real journal's data is used here: it is All Rights Reserved.

local UI = dofile("tests/support/strict_ui.lua")

local function row(id, name) return { id, name, "Chest, Cloth", 3 } end

-- An invented journal: two dungeons, one flagged incomplete, a trash page, a rare, a recipe page, shared items, a row whose id is still 0.
local function fakeJournal()
  local fdj = {}
  fdj.ORDER = { "Hollow Test Keep", "The Lorem Vaults" }
  fdj.DB = {
    ["Hollow Test Keep"] = {
      bosses = {
        { name = "Warden of Fixtures", npcID = 990011, loot = { row(900101, "Fixture Robe"), row(900102, "Fixture Boots") } },
        { name = "Lord Lorem", npcID = 990012, rare = true, loot = { row(900103, "Lorem Ring") } },
        { name = "Trash Drops", trash = true, loot = { row(900104, "Dusty Cloak"), row(0, "Unknown Gloves") } },
        { name = "Recipes & Patterns", recipeTab = true, loot = { row(900105, "Pattern: Test Vest") } },
      },
    },
    ["The Lorem Vaults"] = {
      fullItemsTBD = true,
      bosses = {
        { name = "  Ipsum the Unready  ", loot = { row(900201, "Ipsum Blade"), row(900201, "Ipsum Blade again") } },
        { name = "", npcID = 990022, loot = { row(900202, "Nameless Belt") } },
        "not a boss",
      },
    },
  }
  fdj.SHARED = { ["Warden of Fixtures"] = { row(900110, "Shared Trinket"), row(900101, "Fixture Robe") } }
  function fdj.GetBossSharedLoot(dungeon, boss)
    if dungeon == "Hollow Test Keep" then return fdj.SHARED[boss.name] end
    return nil
  end
  function fdj.BossDropSource(itemId)
    if itemId == 900101 then return { bossName = "Warden of Fixtures", dungeonName = "Hollow Test Keep", bossIndex = 1 } end
    if itemId == 900666 then error("journal trouble") end
    return nil
  end
  fdj.opened = {}
  function fdj.OpenItemSource(itemId)
    fdj.opened[#fdj.opened + 1] = itemId
    return itemId == 900101
  end
  function fdj.CurrentDungeon() return nil end
  return fdj
end

local function setup(journal, version)
  local game = UI.new()
  local ns = {}
  game.load("IntrepidManager/game/DungeonJournal.lua", ns)
  local DJ = ns.Game.DungeonJournal
  return DJ.new({ journal = function() return journal end, version = function() return version end }), DJ, game, ns
end

test("without the journal every answer is empty and nothing fails", function()
  local dj = setup(nil, nil)
  eq(dj.available(), false)
  eq(dj.version(), nil)
  deep_eq(dj.dungeons(), {})
  eq(dj.find("Hollow Test Keep"), nil)
  eq(dj.zone("Hollow Test Keep"), nil)
  eq(dj.sourceOf(900101), nil)
  eq(dj.open(900101), false)
  deep_eq(dj.check(), { present = false })
end)

test("a journal whose shape changed counts as missing", function()
  eq(setup({ DB = "not a table", ORDER = {} }).available(), false)
  eq(setup({ DB = {}, ORDER = nil }).available(), false)
  local game = UI.new()
  local ns = {}
  game.load("IntrepidManager/game/DungeonJournal.lua", ns)
  local raising = ns.Game.DungeonJournal.new({ journal = function() error("gone") end, version = function() error("gone too") end })
  eq(raising.available(), false)
  eq(raising.version(), nil)
end)

test("a dungeon becomes a candidate zone: bosses with their shared items, rares, trash to the zone-wide list, recipe pages left out", function()
  local dj = setup(fakeJournal(), "1.2.3")
  deep_eq(dj.zone("Hollow Test Keep"), {
    name = "Hollow Test Keep", kind = "dungeon", players = 5,
    sources = {
      { npcId = 990011, name = "Warden of Fixtures", kind = "boss", itemIds = { 900101, 900102, 900110 } },
      { npcId = 990012, name = "Lord Lorem", kind = "rare", itemIds = { 900103 } },
    },
    zoneWide = { 900104 },
    skipped = 1, -- the trash page's row whose id is still 0
  })
end)

test("names are trimmed, nameless bosses and repeated items are left out, and an incomplete dungeon says so", function()
  local dj = setup(fakeJournal(), "1.2.3")
  deep_eq(dj.zone("The Lorem Vaults"), {
    name = "The Lorem Vaults", kind = "dungeon", players = 5, partial = true,
    sources = { { name = "Ipsum the Unready", kind = "boss", itemIds = { 900201 } } },
    zoneWide = {},
    skipped = 0,
  })
  eq(dj.zone("No Such Place"), nil)
end)

test("the dungeon list follows the journal's order with counts", function()
  local dj = setup(fakeJournal(), "1.2.3")
  deep_eq(dj.dungeons(), {
    { name = "Hollow Test Keep", bosses = 2, items = 5 },
    { name = "The Lorem Vaults", bosses = 1, items = 1, partial = true },
  })
end)

test("a typed name finds the journal's dungeon, ignoring case, spaces and a leading The", function()
  local dj = setup(fakeJournal(), "1.2.3")
  eq(dj.find("hollow  test keep"), "Hollow Test Keep")
  eq(dj.find("The Hollow Test Keep"), "Hollow Test Keep")
  eq(dj.find("lorem vaults"), "The Lorem Vaults")
  eq(dj.find("  "), nil)
  eq(dj.find("Lorem"), nil)
end)

test("an item's source is the boss and dungeon, and a failing journal answers nothing", function()
  local journal = fakeJournal()
  local dj = setup(journal, "1.2.3")
  deep_eq(dj.sourceOf(900101), { boss = "Warden of Fixtures", dungeon = "Hollow Test Keep" })
  eq(dj.sourceOf(900102), nil)
  eq(dj.sourceOf(900666), nil)
  eq(dj.sourceOf(0), nil)
  eq(dj.sourceOf("900101"), nil)
  eq(dj.open(900101), true)
  eq(dj.open(900102), false)
  eq(dj.open(-1), false)
  deep_eq(journal.opened, { 900101, 900102 })
end)

test("the check counts what the journal holds, with no names", function()
  local clockValue = 10
  local dj = setup(fakeJournal(), "1.2.3")
  deep_eq(dj.check(function() clockValue = clockValue + 2.5 return clockValue end), {
    present = true, version = "1.2.3", dungeons = 2, bosses = 3, items = 6, partial = 1, badIds = 1,
    functions = { GetBossSharedLoot = true, BossDropSource = true, OpenItemSource = true, CurrentDungeon = true },
    inDungeon = false, ms = 2.5,
  })
end)

test("in the game it reads the journal's global table and its TOC version", function()
  local game = UI.new()
  game.env.ForeverDungeonJournal_NS = fakeJournal()
  game.env.C_AddOns = { GetAddOnMetadata = function(folder, field)
    if folder == "ForeverDungeonJournal" and field == "Version" then return "2.0.1" end
    return nil
  end }
  local ns = {}
  game.load("IntrepidManager/game/DungeonJournal.lua", ns)
  local dj = ns.Game.DungeonJournal.new()
  eq(dj.available(), true)
  eq(dj.version(), "2.0.1")
  eq(#dj.dungeons(), 2)
end)

test("the name key lowercases, collapses spaces and drops a leading The", function()
  local _, DJ = setup(nil, nil)
  eq(DJ.nameKey("  The   Hall of  Tests "), "hall of tests")
  eq(DJ.nameKey("Scarlet Test: Library"), "scarlet test: library")
  eq(DJ.nameKey(nil), nil)
end)
