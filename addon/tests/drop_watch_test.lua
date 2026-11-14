-- The drop log's eyes in the game (IntrepidManager/game/DropWatch.lua) on the strict stand-in game, with a fake loot window
-- (tests/support/fake_loot.lua) and a fake dungeon: the instance, the encounter events, boss and mouseover units, rolls and the loot
-- history. The timelines follow the beta's probe (boss kill, then LOOT_READY; rolls fill the loot history). Invented ids and names only.

local UI = dofile("tests/support/strict_ui.lua")
local FakeLoot = dofile("tests/support/fake_loot.lua")

local BOSS, BOSS2, RARE, TRASH = 990011, 990013, 990012, 990031
local function creature(npcId, spawn) return "Creature-0-4170-389-12-" .. npcId .. "-" .. (spawn or "01") end
local function link(itemId) return "|cffa335ee|Hitem:" .. itemId .. "::::::::60:::::|h[Item " .. itemId .. "]|h|r" end

-- A fake dungeon around the fake loot window. world.* can be changed by a test at any time.
local function setup(options)
  options = options or {}
  local game = UI.new()
  local loot = FakeLoot.install(game, { items = options.items or {}, notMasterLooter = options.notMasterLooter, source = options.source })
  local env = game.env
  local world = {
    inside = true, kind = options.kind or "party", name = options.name or "Hollow Test Keep", difficulty = 1, size = 5, instance = 9100,
    units = {}, names = {}, classes = {}, secret = {}, rolls = {}, history = {}, boe = {},
    spells = { [8613] = "Skinning", [921] = "Pick Pocket", [2575] = "Mining", [133] = "Fireball" }, spellLookups = 0,
  }
  env.C_Spell = { GetSpellName = function(spellId)
    world.spellLookups = world.spellLookups + 1
    return world.spells[spellId]
  end }
  env.IsInInstance = function() return world.inside, world.inside and world.kind or "none" end
  env.GetInstanceInfo = function()
    return world.name, world.kind, world.difficulty, "Normal", world.size, 0, false, world.instance
  end
  env.UnitGUID = function(unit) return world.units[unit] end
  local playerName = env.UnitName
  env.UnitName = function(unit)
    if world.names[unit] then return world.names[unit] end
    return playerName(unit)
  end
  env.UnitClassification = function(unit) return world.classes[unit] or "normal" end
  env.issecretvalue = function(value) return world.secret[value] == true end
  env.GetLootRollItemLink = function(rollId) return world.rolls[rollId] and link(world.rolls[rollId].itemId) end
  env.GetLootRollItemInfo = function(rollId)
    local roll = world.rolls[rollId]
    if roll then return 134400, "Item " .. roll.itemId, 1, roll.quality, true end
  end
  env.C_LootHistory = {
    GetSortedDropsForEncounter = function(encounterId)
      if world.historyRaises then error("history trouble") end
      return world.history[encounterId] or {}
    end,
  }
  env.C_Item = {
    GetItemInfo = function(itemId)
      if world.boe[itemId] then return "Item", link(itemId), 3, 60, 55, "Armor", "Cloth", 1, "INVTYPE_CHEST", 134400, 100, 4, 1, 2 end
      return nil
    end,
  }
  local ns = {}
  game.load("IntrepidManager/core/Crc32.lua", ns)
  game.load("IntrepidManager/core/DropLog.lua", ns)
  game.load("IntrepidManager/game/DropWatch.lua", ns)
  local db = {}
  local log = ns.DropLog.new(db)
  local watch = ns.Game.DropWatch.new({ log = log })
  watch.listen()
  return { game = game, loot = loot, world = world, db = db, log = log, watch = watch, ns = ns }
end

local function item(id, quality, source, extra)
  local entry = { id = id, name = "Item " .. id, quality = quality, source = source }
  for key, value in pairs(extra or {}) do entry[key] = value end
  return entry
end

-- The boss of encounter 3001 dies; its boss unit is read during the fight.
local function killBoss(scene, encounterId, name, bossGuid)
  scene.world.units.boss1 = bossGuid
  scene.world.names.boss1 = name
  scene.game.send("ENCOUNTER_START", encounterId, name, 1, 5)
  scene.game.send("INSTANCE_ENCOUNTER_ENGAGE_UNIT")
  scene.world.units.boss1 = nil
  scene.game.send("ENCOUNTER_END", encounterId, name, 1, 5, 1)
end

local function source(scene, key)
  local zone = scene.db.drops and scene.db.drops.zones["9100:1"]
  return zone and zone.sources[key]
end

test("it listens to the ten events of the drop log, each registered on its own", function()
  local scene = setup()
  local found
  for _, frame in ipairs(scene.game.frames) do
    local events = scene.game.state(frame).events
    if events.LOOT_READY then found = events end
  end
  is_true(found ~= nil)
  for _, event in ipairs({ "PLAYER_ENTERING_WORLD", "ZONE_CHANGED_NEW_AREA", "ENCOUNTER_START", "INSTANCE_ENCOUNTER_ENGAGE_UNIT", "ENCOUNTER_END",
      "LOOT_READY", "START_LOOT_ROLL", "PLAYER_TARGET_CHANGED", "UPDATE_MOUSEOVER_UNIT", "UNIT_SPELLCAST_SUCCEEDED" }) do
    is_true(found[event] == true)
  end
end)

test("a boss read from boss1 during the fight, then its corpse: its items under the encounter, the window's names and qualities", function()
  local scene = setup()
  killBoss(scene, 3001, "The Fixture Warden", creature(BOSS))
  scene.loot.open({ item(900101, 3, creature(BOSS)), item(900102, 2, creature(BOSS)), item(900103, 0, creature(BOSS)) })
  scene.game.send("LOOT_READY", false)
  local boss = source(scene, "n" .. BOSS)
  eq(boss.kind, "boss")
  eq(boss.name, "The Fixture Warden")
  eq(boss.encounterId, 3001)
  eq(boss.items[900101].n, 1)
  eq(boss.items[900101].name, "Item 900101")
  eq(boss.items[900102].quality, 2)
  eq(boss.items[900103], nil)
  eq(scene.db.drops.stats.bossUnits, 2) -- read at the start and again when the unit engaged
  eq(scene.db.drops.zones["9100:1"].name, "Hollow Test Keep")
  -- LOOT_READY again for the same window counts nothing more
  scene.game.send("LOOT_READY", false)
  eq(source(scene, "n" .. BOSS).items[900101].n, 1)
end)

test("outside a dungeon or raid nothing is recorded", function()
  local scene = setup()
  scene.world.inside = false
  killBoss(scene, 3001, "The Fixture Warden", creature(BOSS))
  scene.loot.open({ item(900101, 4, creature(BOSS)) })
  scene.game.send("LOOT_READY", false)
  scene.world.units.mouseover = creature(RARE)
  scene.game.send("UPDATE_MOUSEOVER_UNIT")
  eq(scene.db.drops, nil)
end)

test("a boss unit the game keeps secret is counted, not read; the master looter's first corpse is then a guessed boss", function()
  local scene = setup()
  -- (during the fight the unit's GUID comes back as a secret value; the corpse's GUID in the loot window later is an ordinary one)
  scene.world.secret["secret boss guid"] = true
  killBoss(scene, 4001, "Ipsum the Unready", "secret boss guid")
  eq(scene.db.drops.stats.bossUnitsSecret, 2)
  eq(scene.db.drops.stats.bossUnits, nil)
  scene.game.advance(30)
  scene.loot.open({ item(900301, 4, creature(BOSS2)) })
  scene.game.send("LOOT_READY", false)
  local boss = source(scene, "n" .. BOSS2)
  eq(boss.kind, "boss")
  eq(boss.guessed, true)
  eq(boss.name, "Ipsum the Unready")
end)

test("not the master looter: the same corpse waits for a roll, and with none it is trash when the wait is over", function()
  local scene = setup({ notMasterLooter = true })
  scene.world.secret["secret boss guid"] = true
  killBoss(scene, 4001, "Ipsum the Unready", "secret boss guid")
  scene.loot.open({ item(900301, 4, creature(BOSS2)) })
  scene.game.send("LOOT_READY", false)
  eq(source(scene, "n" .. BOSS2), nil)
  eq(scene.log.holding(), 1)
  scene.game.advance(scene.ns.DropLog.HOLD + 1)
  eq(scene.log.holding(), 0)
  eq(source(scene, "n" .. BOSS2).kind, "trash")
end)

test("group loot in the game: no boss unit, the corpse opened first, the roll filed from the loot history makes it the boss", function()
  local scene = setup({ notMasterLooter = true })
  -- the boss units give nothing (as in the live client's dungeons)
  scene.game.send("ENCOUNTER_START", 4001, "Ipsum the Unready", 1, 5)
  scene.game.send("INSTANCE_ENCOUNTER_ENGAGE_UNIT")
  scene.game.send("ENCOUNTER_END", 4001, "Ipsum the Unready", 1, 5, 1)
  scene.loot.open({ item(900301, 4, creature(BOSS2)), item(900302, 2, creature(BOSS2)) })
  scene.game.send("LOOT_READY", false)
  eq(scene.log.holding(), 1)
  -- the roll starts; the loot history has it 2 seconds later
  scene.world.rolls[11] = { itemId = 900301, quality = 4 }
  scene.game.send("START_LOOT_ROLL", 11, 60000)
  scene.world.history[4001] = { { itemHyperlink = link(900301) } }
  scene.game.advance(3)
  eq(scene.log.holding(), 0)
  local boss = source(scene, "n" .. BOSS2)
  eq(boss.kind, "boss")
  eq(boss.name, "Ipsum the Unready")
  eq(boss.items[900301].n, 1)
  eq(boss.items[900302].n, 1)
  eq(scene.db.drops.stats.bossUnits, nil)
  -- nothing more happens when the settle timer comes
  scene.game.advance(scene.ns.DropLog.HOLD)
  eq(boss.items[900301].n, 1)
end)

test("a creature under the mouse that the game calls rare elite: its corpse is a rare, with its name", function()
  local scene = setup()
  scene.world.units.mouseover = creature(RARE, "07")
  scene.world.names.mouseover = "Lord Lorem"
  scene.world.classes.mouseover = "rareelite"
  scene.game.send("UPDATE_MOUSEOVER_UNIT")
  scene.world.units.target = creature(TRASH, "08")
  scene.world.names.target = "Dusty Sentry"
  scene.game.send("PLAYER_TARGET_CHANGED")
  scene.loot.open({ item(900103, 2, creature(RARE, "07")), item(900104, 3, creature(TRASH, "08")) })
  scene.game.send("LOOT_READY", false)
  eq(source(scene, "n" .. RARE).kind, "rare")
  eq(source(scene, "n" .. RARE).name, "Lord Lorem")
  eq(source(scene, "n" .. TRASH).name, "Dusty Sentry")
  eq(scene.db.drops.stats.raresSeen, 1)
end)

test("a quest item and a bind-on-equip item are flagged", function()
  local scene = setup()
  scene.world.boe[900702] = true
  killBoss(scene, 3001, "The Fixture Warden", creature(BOSS))
  scene.loot.open({ item(900701, 2, creature(BOSS), { quest = true }), item(900702, 3, creature(BOSS)) })
  scene.game.send("LOOT_READY", false)
  eq(source(scene, "n" .. BOSS).items[900701].quest, true)
  eq(source(scene, "n" .. BOSS).items[900702].boe, true)
end)

test("a roll is filed under the encounter once the loot history has it, even a few seconds after the roll starts", function()
  local scene = setup()
  scene.world.secret["secret boss guid"] = true
  killBoss(scene, 4001, "Ipsum the Unready", "secret boss guid")
  scene.world.rolls[7] = { itemId = 900501, quality = 4 }
  scene.game.send("START_LOOT_ROLL", 7, 60000)
  eq(source(scene, "e4001"), nil)
  scene.world.history[4001] = { { itemHyperlink = link(900501), rollInfos = { { playerName = "Never Read" } } } }
  scene.game.advance(2)
  local loose = source(scene, "e4001")
  eq(loose.items[900501].via, "roll")
  eq(scene.db.drops.stats.rollsSeen, 1)
  eq(scene.db.drops.stats.rollsFiled, 1)
end)

test("a roll the loot history never files is counted and left out", function()
  local scene = setup()
  killBoss(scene, 3001, "The Fixture Warden", creature(BOSS))
  scene.world.rolls[8] = { itemId = 900601, quality = 3 } -- a trash item rolled after the boss
  scene.game.send("START_LOOT_ROLL", 8, 60000)
  scene.game.advance(15)
  eq(scene.db.drops.stats.rollsNotInHistory, 1)
  eq(source(scene, "e3001"), nil)
  -- a history that raises is counted too, and nothing reaches the player
  scene.world.historyRaises = true
  scene.world.rolls[9] = { itemId = 900602, quality = 3 }
  scene.game.send("START_LOOT_ROLL", 9, 60000)
  scene.game.advance(15)
  eq(scene.db.drops.stats.historyErrors, 3)
end)

test("an error in the drop log is counted and kept short, never raised to the player", function()
  local scene = setup()
  scene.log.window = function() error("boom in the log") end
  scene.loot.open({ item(900101, 4, creature(BOSS)) })
  scene.game.send("LOOT_READY", false)
  eq(scene.db.drops.stats.errors, 1)
  is_true(string.find(scene.db.drops.stats.lastError, "boom in the log", 1, true) ~= nil)
end)

test("entering a dungeon is counted, and a difficulty still 0 at that moment is noted", function()
  local scene = setup()
  scene.world.difficulty = 0
  scene.game.send("PLAYER_ENTERING_WORLD", true, false)
  scene.world.difficulty = 1
  scene.game.send("ZONE_CHANGED_NEW_AREA")
  eq(scene.db.drops.stats.zoneReads, 2)
  eq(scene.db.drops.stats.zoneReadsNoDifficulty, 1)
  -- no zone is made just by entering
  eq(scene.db.drops.zones["9100:0"], nil)
end)

test("a raid is a raid zone of its size", function()
  local scene = setup({ kind = "raid" })
  scene.world.size, scene.world.instance, scene.world.difficulty, scene.world.name = 40, 9200, 9, "The Lorem Vaults"
  scene.loot.open({ item(900901, 3, creature(TRASH)) })
  scene.game.send("LOOT_READY", false)
  local zone = scene.db.drops.zones["9200:9"]
  eq(zone.kind, "raid")
  eq(zone.players, 40)
end)

test("a skinning window on a client that never looted the corpse is not a drop; the next window counts again", function()
  local scene = setup()
  killBoss(scene, 3001, "The Fixture Warden", creature(BOSS))
  -- this client skins the boss the loot master already emptied: the window holds the hide, from the boss's corpse
  scene.game.send("UNIT_SPELLCAST_SUCCEEDED", "player", "Cast-1", 8613)
  scene.game.advance(0.5)
  scene.loot.open({ item(900801, 2, creature(BOSS)) })
  scene.game.send("LOOT_READY", false)
  eq(scene.db.drops.stats.gatherWindows, 1)
  eq(source(scene, "n" .. BOSS), nil)
  -- a later window (another corpse) counts as usual
  scene.game.advance(10)
  scene.loot.open({ item(900802, 3, creature(TRASH, "09")) })
  scene.game.send("LOOT_READY", false)
  eq(source(scene, "n" .. TRASH).items[900802].n, 1)
end)

test("pick-pocketing comes before the kill: its window is left out and the corpse's own loot counts afterwards", function()
  local scene = setup()
  scene.game.send("UNIT_SPELLCAST_SUCCEEDED", "player", "Cast-2", 921)
  scene.loot.open({ item(900901, 3, creature(TRASH, "P1")) })
  scene.game.send("LOOT_READY", false)
  eq(scene.db.drops.stats.gatherWindows, 1)
  scene.game.advance(20)
  scene.loot.open({ item(900902, 3, creature(TRASH, "P1")) })
  scene.game.send("LOOT_READY", false)
  eq(source(scene, "n" .. TRASH).items[900902].n, 1)
  eq(scene.db.drops.stats.repeats, nil)
end)

test("other spells change nothing, a cast long before the window changes nothing, and a spell name is looked up once", function()
  local scene = setup()
  for _ = 1, 5 do scene.game.send("UNIT_SPELLCAST_SUCCEEDED", "player", "Cast-3", 133) end
  scene.game.send("UNIT_SPELLCAST_SUCCEEDED", "party1", "Cast-4", 8613) -- (registered for the player only; ignored anyway)
  eq(scene.world.spellLookups, 1)
  scene.game.send("UNIT_SPELLCAST_SUCCEEDED", "player", "Cast-5", 2575)
  scene.game.advance(5)
  scene.loot.open({ item(900903, 3, creature(TRASH, "Q1")) })
  scene.game.send("LOOT_READY", false)
  eq(scene.db.drops.stats.gatherWindows, nil)
  eq(source(scene, "n" .. TRASH).items[900903].n, 1)
end)
