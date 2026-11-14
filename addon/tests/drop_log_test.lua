-- The drop log (IntrepidManager/core/DropLog.lua): which corpse counts, how a boss, a guessed boss, a chest, a rare and trash are
-- told apart, what is kept and what is never kept. Invented ids and names only (docs/design/drop-list-import.md, section 2).

local ns = load_core({}, "Crc32", "DropLog")
local DropLog = ns.DropLog

local T0 = 1796866200
local DUNGEON = { instanceId = 9100, difficultyId = 1, name = "Hollow Test Keep", instanceType = "party", maxPlayers = 5, method = 2 }
local RAID = { instanceId = 9200, difficultyId = 9, name = "The Lorem Vaults", instanceType = "raid", maxPlayers = 40, method = 2 }

local BOSS, BOSS2, ADD, TRASH, RARE, CHEST = 990011, 990013, 990014, 990031, 990012, 177001

local function creature(npcId, spawn) return "Creature-0-4170-389-12-" .. npcId .. "-" .. (spawn or "00002B3C1D") end
local function object(id, spawn) return "GameObject-0-4170-389-12-" .. id .. "-" .. (spawn or "0000AA0001") end

-- A loot slot: an item id, its quality and the corpse it came from.
local function slot(itemId, quality, source, extra)
  local entry = { itemId = itemId, name = "Item " .. itemId, quality = quality, sources = { source } }
  for key, value in pairs(extra or {}) do entry[key] = value end
  return entry
end

local function window(slots, extra)
  local w = { slots = slots, threshold = 2 }
  for key, value in pairs(extra or {}) do w[key] = value end
  return w
end

local function fresh()
  local db = {}
  return DropLog.new(db), db
end

local function zoneOf(db, fact) return db.drops.zones[DropLog.zoneKey(fact)] end
local function sourceOf(db, fact, key) return zoneOf(db, fact).sources[key] end

-- A won encounter with its boss units read.
local function win(log, fact, id, name, npcs, at)
  log.encounterStart(fact, id, name)
  for _, npc in ipairs(npcs or {}) do log.bossUnit(npc, "Unit " .. npc) end
  log.encounterEnd(fact, id, name, true, at)
end

test("GUIDs: the kind and the sixth field, nothing for what is not a GUID", function()
  local kind, id = DropLog.parseGuid(creature(BOSS))
  eq(kind, "Creature")
  eq(id, BOSS)
  kind, id = DropLog.parseGuid("Vehicle-0-4170-389-12-" .. BOSS2 .. "-0000000001")
  eq(kind, "Vehicle")
  eq(id, BOSS2)
  eq((DropLog.parseGuid(object(CHEST))), "GameObject")
  eq(select(2, DropLog.parseGuid("Player-4170-0ABCDEF1")), nil)
  eq(DropLog.parseGuid(nil), nil)
  eq(DropLog.parseGuid(12), nil)
  eq(DropLog.parseGuid("-0-1"), nil)
  eq(DropLog.zoneKey(DUNGEON), "9100:1")
  eq(DropLog.zoneKey({ instanceId = 0 }), nil)
  eq(DropLog.zoneKey({ instanceId = 9100 }), "9100:0")
end)

test("a boss read from the boss units: its corpse's items from Uncommon up, under the encounter, named after it", function()
  local log, db = fresh()
  win(log, DUNGEON, 3001, "The Fixture Warden", { BOSS }, T0)
  log.window(DUNGEON, window({ slot(900101, 3, creature(BOSS)), slot(900102, 2, creature(BOSS)), slot(900103, 1, creature(BOSS)) }), T0 + 20)
  local boss = sourceOf(db, DUNGEON, "n" .. BOSS)
  eq(boss.kind, "boss")
  eq(boss.encounterId, 3001)
  eq(boss.name, "The Fixture Warden")
  eq(boss.guessed, nil)
  eq(boss.kills, 1)
  eq(boss.items[900101].n, 1)
  eq(boss.items[900101].via, "window")
  eq(boss.items[900101].quality, 3)
  eq(boss.items[900102].n, 1)
  eq(boss.items[900103], nil) -- Common is below the floor
  eq(db.drops.stats.belowFloor, 1)
  local zone = zoneOf(db, DUNGEON)
  eq(zone.name, "Hollow Test Keep")
  eq(zone.kind, "dungeon")
  eq(zone.players, 5)
  eq(zone.bosses[BOSS], 3001)
  is_true(zone.methods["2"])
end)

test("a corpse counts once: the same window again, or a hand-out window later, adds nothing", function()
  local log, db = fresh()
  win(log, DUNGEON, 3001, "The Fixture Warden", { BOSS }, T0)
  local w = window({ slot(900101, 3, creature(BOSS)) })
  log.window(DUNGEON, w, T0 + 20)
  log.window(DUNGEON, w, T0 + 21) -- LOOT_READY twice, or the window opened again to hand out
  local boss = sourceOf(db, DUNGEON, "n" .. BOSS)
  eq(boss.items[900101].n, 1)
  eq(boss.kills, 1)
  eq(db.drops.stats.repeats, 1)
  -- also after a /reload: the corpse checksums are saved
  local again = DropLog.new(db)
  again.window(DUNGEON, w, T0 + 60)
  eq(sourceOf(db, DUNGEON, "n" .. BOSS).items[900101].n, 1)
  eq(db.drops.stats.repeats, 2)
end)

test("a second kill of the boss counts the item again, and a slow loot still belongs to the last win", function()
  local log, db = fresh()
  win(log, DUNGEON, 3001, "The Fixture Warden", { BOSS }, T0)
  log.window(DUNGEON, window({ slot(900101, 3, creature(BOSS, "0000000001")) }), T0 + 20)
  win(log, DUNGEON, 3001, "The Fixture Warden", { BOSS }, T0 + 7 * 86400)
  log.window(DUNGEON, window({ slot(900101, 3, creature(BOSS, "0000000002")), slot(900104, 4, creature(BOSS, "0000000002")) }), T0 + 7 * 86400 + 900)
  local boss = sourceOf(db, DUNGEON, "n" .. BOSS)
  eq(boss.kills, 2)
  eq(boss.items[900101].n, 2)
  eq(boss.items[900104].n, 1)
  eq(boss.items[900104].quality, 4)
end)

test("trash keeps Rare and better; a trash creature with nothing at that floor makes no entry", function()
  local log, db = fresh()
  log.window(DUNGEON, window({ slot(900201, 2, creature(TRASH, "01")), slot(900202, 3, creature(TRASH, "01")) }), T0)
  local trash = sourceOf(db, DUNGEON, "n" .. TRASH)
  eq(trash.kind, "trash")
  eq(trash.items[900201], nil)
  eq(trash.items[900202].n, 1)
  eq(trash.name, "Creature " .. TRASH) -- nobody pointed at it
  log.window(DUNGEON, window({ slot(900203, 2, creature(TRASH + 1, "02")) }), T0 + 5)
  eq(sourceOf(db, DUNGEON, "n" .. (TRASH + 1)), nil)
  eq(db.drops.stats.trashEmpty, 1)
  -- a later corpse of a creature it already keeps still counts the kill
  log.window(DUNGEON, window({ slot(900201, 2, creature(TRASH, "03")) }), T0 + 9)
  eq(sourceOf(db, DUNGEON, "n" .. TRASH).kills, 2)
end)

test("a rare is a creature the game classed rare: its Uncommon items count, and the name comes from the unit", function()
  local log, db = fresh()
  log.unit(RARE, "Lord Lorem", "rareelite")
  log.window(DUNGEON, window({ slot(900103, 2, creature(RARE)) }), T0)
  local rare = sourceOf(db, DUNGEON, "n" .. RARE)
  eq(rare.kind, "rare")
  eq(rare.name, "Lord Lorem")
  eq(rare.items[900103].n, 1)
  -- a creature first kept as trash and seen rare later becomes a rare, and gets its name
  log.window(DUNGEON, window({ slot(900204, 3, creature(TRASH, "05")) }), T0 + 1)
  log.unit(TRASH, "Dusty Sentry", "rare")
  log.window(DUNGEON, window({ slot(900204, 3, creature(TRASH, "06")) }), T0 + 2)
  eq(sourceOf(db, DUNGEON, "n" .. TRASH).kind, "rare")
  eq(sourceOf(db, DUNGEON, "n" .. TRASH).name, "Dusty Sentry")
end)

test("a guessed boss: only the master looter, only within 5 minutes, only loot at the threshold; two kills make it sure", function()
  local log, db = fresh()
  -- the boss units could not be read (no bossUnit): the encounter is known, its creature is not
  win(log, RAID, 4001, "Ipsum the Unready", {}, T0)
  -- not the master looter: no guess; the corpse waits for rolls that never come, then it is trash
  log.window(RAID, window({ slot(900301, 3, creature(BOSS2, "01")) }), T0 + 30)
  eq(sourceOf(db, RAID, "n" .. BOSS2), nil)
  eq(log.holding(), 1)
  log.settle(T0 + 30 + DropLog.HOLD)
  eq(sourceOf(db, RAID, "n" .. BOSS2).kind, "trash")

  local log2, db2 = fresh()
  win(log2, RAID, 4001, "Ipsum the Unready", {}, T0)
  log2.window(RAID, window({ slot(900301, 3, creature(BOSS2, "01")), slot(900302, 2, creature(BOSS2, "01")) }, { masterLooter = true }), T0 + 30)
  local guessed = sourceOf(db2, RAID, "n" .. BOSS2)
  eq(guessed.kind, "boss")
  eq(guessed.guessed, true)
  eq(guessed.encounterId, 4001)
  eq(guessed.name, "Ipsum the Unready")
  eq(guessed.items[900302].n, 1) -- a boss keeps Uncommon
  eq(zoneOf(db2, RAID).bosses[BOSS2], nil)
  -- the next corpse after the same win is not a second guess
  log2.window(RAID, window({ slot(900303, 3, creature(ADD, "02")) }, { masterLooter = true }), T0 + 40)
  eq(sourceOf(db2, RAID, "n" .. ADD).kind, "trash")
  -- a week later, the same creature after the same encounter: sure
  win(log2, RAID, 4001, "Ipsum the Unready", {}, T0 + 7 * 86400)
  log2.window(RAID, window({ slot(900304, 4, creature(BOSS2, "03")) }, { masterLooter = true }), T0 + 7 * 86400 + 60)
  guessed = sourceOf(db2, RAID, "n" .. BOSS2)
  eq(guessed.guessed, nil)
  eq(zoneOf(db2, RAID).bosses[BOSS2], 4001)
  eq(guessed.kills, 2)
  eq(db2.drops.stats.guessed, 1)
  eq(db2.drops.stats.confirmed, 1)
end)

test("no guess after 5 minutes, below the threshold, or for a creature already kept as trash", function()
  local log, db = fresh()
  win(log, RAID, 4001, "Ipsum the Unready", {}, T0)
  log.window(RAID, window({ slot(900301, 3, creature(BOSS2, "01")) }, { masterLooter = true }), T0 + DropLog.WINDOW + 1)
  eq(sourceOf(db, RAID, "n" .. BOSS2).kind, "trash")

  local log2, db2 = fresh()
  win(log2, RAID, 4001, "Ipsum the Unready", {}, T0)
  log2.window(RAID, window({ slot(900301, 3, creature(BOSS2, "01")) }, { masterLooter = true, threshold = 4 }), T0 + 30)
  eq(sourceOf(db2, RAID, "n" .. BOSS2).kind, "trash")

  local log3, db3 = fresh()
  log3.window(RAID, window({ slot(900305, 3, creature(TRASH, "01")) }), T0 - 60)
  win(log3, RAID, 4001, "Ipsum the Unready", {}, T0)
  log3.window(RAID, window({ slot(900306, 3, creature(TRASH, "02")) }, { masterLooter = true }), T0 + 30)
  eq(sourceOf(db3, RAID, "n" .. TRASH).kind, "trash")
end)

test("a chest counts for the master looter within 5 minutes of a win, under that encounter; other objects never", function()
  local log, db = fresh()
  win(log, RAID, 4002, "The Council of Ids", { BOSS, BOSS2 }, T0)
  log.window(RAID, window({ slot(900401, 4, object(CHEST)) }, { masterLooter = true }), T0 + 45)
  local zone = zoneOf(db, RAID)
  -- the encounter had two boss units: nobody knows whose the chest's items were, so they stay under the encounter
  eq(zone.sources["n" .. BOSS], nil)
  local loose = zone.sources["e4002"]
  eq(loose.kind, "boss")
  eq(loose.npcId, nil)
  eq(loose.name, "The Council of Ids")
  eq(loose.items[900401].n, 1)
  eq(db.drops.stats.chests, 1)
  -- one boss: its chest goes to it
  local log2, db2 = fresh()
  win(log2, RAID, 4003, "The Lone Fixture", { BOSS }, T0)
  log2.window(RAID, window({ slot(900404, 4, object(CHEST, "DD")) }, { masterLooter = true }), T0 + 45)
  eq(sourceOf(db2, RAID, "n" .. BOSS).items[900404].n, 1)
  -- a chest (or ore, or a herb) opened by someone else, or too late, is ignored
  log.window(RAID, window({ slot(900402, 4, object(CHEST, "BB")) }), T0 + 50)
  log.window(RAID, window({ slot(900403, 4, object(CHEST, "CC")) }, { masterLooter = true }), T0 + DropLog.WINDOW + 10)
  eq(db.drops.stats.objectsIgnored, 2)
end)

test("a roll the loot history files under the encounter waits under it, and joins the boss once its corpse is opened, counted once", function()
  local log, db = fresh()
  win(log, RAID, 4001, "Ipsum the Unready", {}, T0)
  log.roll(RAID, { itemId = 900501, name = "Item 900501", quality = 4 }, 4001, T0 + 15)
  local loose = sourceOf(db, RAID, "e4001")
  eq(loose.kind, "boss")
  eq(loose.npcId, nil)
  eq(loose.name, "Ipsum the Unready")
  eq(loose.items[900501].via, "roll")
  -- a roll for another encounter is not filed
  log.roll(RAID, { itemId = 900502, quality = 4 }, 4999, T0 + 16)
  eq(db.drops.stats.rollsUnfiled, 1)
  -- the master looter opens the boss: guessed, and the encounter's items join it
  log.window(RAID, window({ slot(900501, 4, creature(BOSS2)), slot(900503, 3, creature(BOSS2)) }, { masterLooter = true }), T0 + 30)
  eq(sourceOf(db, RAID, "e4001"), nil)
  local boss = sourceOf(db, RAID, "n" .. BOSS2)
  eq(boss.items[900501].n, 1) -- the roll and the window of one kill
  eq(boss.items[900501].via, "window")
  eq(boss.items[900503].n, 1)
  eq(boss.kills, 1)
end)

test("one window with the loot of several corpses (area loot) files each slot under its own corpse", function()
  local log, db = fresh()
  log.unit(RARE, "Lord Lorem", "rare")
  log.window(DUNGEON, window({ slot(900601, 3, creature(TRASH, "01")), slot(900602, 2, creature(RARE, "02")), slot(900603, 3, creature(TRASH, "03")) }), T0)
  eq(sourceOf(db, DUNGEON, "n" .. TRASH).kills, 2)
  eq(sourceOf(db, DUNGEON, "n" .. TRASH).items[900603].n, 1)
  eq(sourceOf(db, DUNGEON, "n" .. RARE).items[900602].n, 1)
  -- a slot with no source is counted, never filed
  log.window(DUNGEON, window({ { itemId = 900604, quality = 4, sources = {} } }), T0 + 1)
  eq(db.drops.stats.noSource, 1)
end)

test("quest items and bind-on-equip items are flagged; names and qualities come from the window", function()
  local log, db = fresh()
  win(log, DUNGEON, 3001, "The Fixture Warden", { BOSS }, T0)
  log.window(DUNGEON, window({ slot(900701, 2, creature(BOSS), { quest = true }), slot(900702, 3, creature(BOSS), { boe = true }) }), T0 + 5)
  local boss = sourceOf(db, DUNGEON, "n" .. BOSS)
  eq(boss.items[900701].quest, true)
  eq(boss.items[900701].name, "Item 900701")
  eq(boss.items[900702].boe, true)
  eq(boss.items[900702].quest, nil)
end)

test("a lost encounter is not a win; an encounter id that is not a number is ignored", function()
  local log, db = fresh()
  log.encounterStart(DUNGEON, 3001, "The Fixture Warden")
  log.bossUnit(BOSS, "Unit")
  log.encounterEnd(DUNGEON, 3001, "The Fixture Warden", false, T0)
  eq(db.drops.last, nil)
  eq(db.drops.stats.encountersLost, 1)
  log.encounterStart(DUNGEON, "3001", "x")
  log.encounterEnd(DUNGEON, nil, "x", true, T0)
  eq(db.drops.last, nil)
  -- a boss unit outside a fight is ignored
  log.bossUnit(BOSS, "Unit")
  eq(log.fighting(), false)
end)

test("the last win survives a /reload: the boss opened after it still belongs to it", function()
  local log, db = fresh()
  win(log, DUNGEON, 3001, "The Fixture Warden", { BOSS }, T0)
  local after = DropLog.new(db)
  after.window(DUNGEON, window({ slot(900101, 3, creature(BOSS)) }), T0 + 40)
  local boss = sourceOf(db, DUNGEON, "n" .. BOSS)
  eq(boss.items[900101].k, "e3001@" .. T0)
end)

test("where an item drops: a boss or a rare of this client's windows, the newest zone first; trash says nothing", function()
  local log = fresh()
  win(log, DUNGEON, 3001, "The Fixture Warden", { BOSS }, T0)
  log.window(DUNGEON, window({ slot(900101, 3, creature(BOSS)) }), T0 + 5)
  log.window(DUNGEON, window({ slot(900202, 3, creature(TRASH)) }), T0 + 6)
  eq(log.sourceOf(900101), "The Fixture Warden, Hollow Test Keep")
  eq(log.sourceOf(900202), nil)
  eq(log.sourceOf(123), nil)
  eq(log.sourceOf("900101"), nil)
end)

test("the zones list: newest first, with creatures, bosses and items counted", function()
  local log = fresh()
  win(log, DUNGEON, 3001, "The Fixture Warden", { BOSS }, T0)
  log.window(DUNGEON, window({ slot(900101, 3, creature(BOSS)), slot(900102, 2, creature(BOSS)) }), T0 + 5)
  log.window(RAID, window({ slot(900202, 3, creature(TRASH)) }), T0 + 100)
  local zones = log.zones()
  eq(#zones, 2)
  eq(zones[1].name, "The Lorem Vaults")
  eq(zones[1].kind, "raid")
  eq(zones[1].players, 40)
  eq(zones[2].creatures, 1)
  eq(zones[2].bosses, 1)
  eq(zones[2].items, 2)
  eq(zones[2].key, "9100:1")
end)

test("caps: a full creature keeps the items seen most, a full log drops the zone seen longest ago, a full total stops adding", function()
  local saved = { DropLog.MAX_ITEMS_PER_SOURCE, DropLog.MAX_ZONES, DropLog.MAX_ITEMS, DropLog.MAX_CORPSES }
  local ok, problem = pcall(function()
    DropLog.MAX_ITEMS_PER_SOURCE, DropLog.MAX_ZONES, DropLog.MAX_ITEMS, DropLog.MAX_CORPSES = 2, 2, 5, 3
    local log, db = fresh()
    win(log, DUNGEON, 3001, "The Fixture Warden", { BOSS }, T0)
    log.window(DUNGEON, window({ slot(900801, 3, creature(BOSS, "01")), slot(900802, 3, creature(BOSS, "01")) }), T0 + 1)
    win(log, DUNGEON, 3001, "The Fixture Warden", { BOSS }, T0 + 100)
    log.window(DUNGEON, window({ slot(900801, 3, creature(BOSS, "02")), slot(900803, 3, creature(BOSS, "02")) }), T0 + 101)
    local boss = sourceOf(db, DUNGEON, "n" .. BOSS)
    eq(boss.count, 2)
    eq(boss.items[900801].n, 2)  -- seen most: kept
    eq(boss.items[900802], nil)  -- seen once, longest ago: made room
    eq(boss.items[900803].n, 1)
    eq(db.drops.itemCount, 2)
    -- zones: a third zone drops the one seen longest ago
    local third = { instanceId = 9300, difficultyId = 1, name = "Third Keep", instanceType = "party", maxPlayers = 5 }
    log.window(RAID, window({ slot(900901, 3, creature(TRASH, "03")) }), T0 + 200)
    log.window(third, window({ slot(900902, 3, creature(TRASH, "04")) }), T0 + 300)
    eq(db.drops.zoneCount, 2)
    eq(zoneOf(db, DUNGEON), nil)
    eq(db.drops.itemCount, 2)
    -- the total: a full log drops the zone seen longest ago, never the one being added to; with no other zone, nothing is added
    log.window(third, window({ slot(900903, 3, creature(TRASH + 1, "05")), slot(900904, 3, creature(TRASH + 1, "05")) }), T0 + 301)
    log.window(third, window({ slot(900905, 3, creature(TRASH + 2, "06")), slot(900906, 3, creature(TRASH + 2, "06")) }), T0 + 302)
    eq(db.drops.itemCount, 5)
    eq(zoneOf(db, RAID), nil)
    eq(db.drops.zoneCount, 1)
    log.window(third, window({ slot(900907, 3, creature(TRASH + 3, "07")) }), T0 + 303)
    eq(db.drops.itemCount, 5)
    is_true(db.drops.stats.full >= 1)
    -- the corpse ring keeps only the last three
    eq(#db.drops.corpses, 3)
  end)
  DropLog.MAX_ITEMS_PER_SOURCE, DropLog.MAX_ZONES, DropLog.MAX_ITEMS, DropLog.MAX_CORPSES = saved[1], saved[2], saved[3], saved[4]
  if not ok then error(problem, 0) end
end)

test("a full zone makes room for a boss by dropping the trash seen longest ago, never for more trash", function()
  local saved = DropLog.MAX_SOURCES_PER_ZONE
  local ok, problem = pcall(function()
    DropLog.MAX_SOURCES_PER_ZONE = 2
    local log, db = fresh()
    log.window(DUNGEON, window({ slot(901001, 3, creature(TRASH, "01")) }), T0)
    log.window(DUNGEON, window({ slot(901002, 3, creature(TRASH + 1, "02")) }), T0 + 1)
    log.window(DUNGEON, window({ slot(901003, 3, creature(TRASH + 2, "03")) }), T0 + 2)
    eq(sourceOf(db, DUNGEON, "n" .. (TRASH + 2)), nil)
    win(log, DUNGEON, 3001, "The Fixture Warden", { BOSS }, T0 + 10)
    log.window(DUNGEON, window({ slot(901004, 3, creature(BOSS)) }), T0 + 11)
    eq(sourceOf(db, DUNGEON, "n" .. TRASH), nil)
    eq(sourceOf(db, DUNGEON, "n" .. BOSS).items[901004].n, 1)
    eq(zoneOf(db, DUNGEON).count, 2)
    eq(db.drops.itemCount, 2)
  end)
  DropLog.MAX_SOURCES_PER_ZONE = saved
  if not ok then error(problem, 0) end
end)

-- What the saved data may hold: these keys, and no others. A player's name or GUID has nowhere to go.
local ALLOWED = {
  store = { schema = true, zones = true, zoneCount = true, itemCount = true, corpses = true, cursor = true, stats = true, last = true, held = true },
  zone = { instanceId = true, difficultyId = true, name = true, kind = true, players = true, first = true, last = true, sources = true, count = true, bosses = true, guesses = true, methods = true, wins = true },
  source = { npcId = true, encounterId = true, name = true, kind = true, guessed = true, kills = true, first = true, last = true, items = true, count = true, k = true, matched = true },
  item = { n = true, last = true, via = true, name = true, quality = true, boe = true, quest = true, k = true, rk = true },
  last = { id = true, name = true, at = true, zone = true, npcs = true, names = true, claimed = true },
}

local function only(tableValue, allowed, where)
  for key in pairs(tableValue) do
    if not allowed[key] then error(where .. " has a key it should not: " .. tostring(key)) end
  end
end

test("the saved data holds only its own fields; corpses are kept as 8-character checksums, never as GUIDs", function()
  local log, db = fresh()
  log.unit(RARE, "Lord Lorem", "rare")
  win(log, RAID, 4002, "The Council of Ids", { BOSS, BOSS2 }, T0)
  log.window(RAID, window({ slot(900101, 3, creature(BOSS)), slot(900401, 4, object(CHEST)) }, { masterLooter = true }), T0 + 10)
  log.window(RAID, window({ slot(900602, 2, creature(RARE)) }), T0 + 20)
  log.roll(RAID, { itemId = 900501, quality = 4 }, 4002, T0 + 30)
  local store = db.drops
  only(store, ALLOWED.store, "the store")
  only(store.last, ALLOWED.last, "the last win")
  for _, zone in pairs(store.zones) do
    only(zone, ALLOWED.zone, "a zone")
    for _, source in pairs(zone.sources) do
      only(source, ALLOWED.source, "a source")
      for _, item in pairs(source.items) do only(item, ALLOWED.item, "an item") end
    end
  end
  for _, h in ipairs(store.corpses) do
    is_true(string.find(h, "^%x%x%x%x%x%x%x%x$") ~= nil)
  end
  -- no GUID anywhere: walk every string
  local function walk(value)
    if type(value) == "string" then
      if string.find(value, "Creature%-") or string.find(value, "GameObject%-") or string.find(value, "Player%-") then error("a GUID was kept: " .. value) end
    elseif type(value) == "table" then
      for key, item in pairs(value) do
        walk(key)
        walk(item)
      end
    end
  end
  walk(store)
end)

test("an old or broken store is started again", function()
  local db = { drops = { schema = 99, zones = "junk" } }
  local log = DropLog.new(db)
  log.window(DUNGEON, window({ slot(900202, 3, creature(TRASH)) }), T0)
  eq(db.drops.schema, 1)
  eq(db.drops.zoneCount, 1)
end)

-- One test per finding of the bounded review (2026-11-12).

test("an encounter with two bosses: its rolls stay under the encounter, and one boss's corpse does not take them", function()
  local log, db = fresh()
  win(log, RAID, 4002, "The Council of Ids", { BOSS, BOSS2 }, T0)
  log.roll(RAID, { itemId = 900401, quality = 4 }, 4002, T0 + 10)
  eq(sourceOf(db, RAID, "n" .. BOSS), nil)
  eq(sourceOf(db, RAID, "e4002").items[900401].n, 1)
  -- the second boss's corpse holds the item: it is filed under that boss, and the encounter keeps its roll
  log.window(RAID, window({ slot(900401, 4, creature(BOSS2)) }), T0 + 30)
  eq(sourceOf(db, RAID, "n" .. BOSS2).items[900401].n, 1)
  eq(sourceOf(db, RAID, "e4002").items[900401].n, 1)
  eq(sourceOf(db, RAID, "n" .. BOSS), nil)
end)

test("a known boss opened after a later win still belongs to its own encounter's win: the roll and the window count once", function()
  local log, db = fresh()
  win(log, DUNGEON, 3001, "The Fixture Warden", { BOSS }, T0)
  log.roll(DUNGEON, { itemId = 900102, quality = 3 }, 3001, T0 + 10)
  win(log, DUNGEON, 3002, "The Second Fixture", { BOSS2 }, T0 + 600)
  log.window(DUNGEON, window({ slot(900102, 3, creature(BOSS)) }), T0 + 700)
  local boss = sourceOf(db, DUNGEON, "n" .. BOSS)
  eq(boss.kills, 1)
  eq(boss.items[900102].n, 1)
  -- long after its win (another night, the end of the encounter missed), the corpse counts on its own
  log.window(DUNGEON, window({ slot(900102, 3, creature(BOSS, "LATER")) }), T0 + DropLog.BOSS_WIN_LIMIT + 1000)
  eq(sourceOf(db, DUNGEON, "n" .. BOSS).kills, 2)
  eq(sourceOf(db, DUNGEON, "n" .. BOSS).items[900102].n, 2)
end)

test("area loot: a known boss of the win in the window means no guess; otherwise the guess is the corpse with the best item", function()
  local log, db = fresh()
  win(log, RAID, 4001, "Ipsum the Unready", { BOSS2 }, T0)
  log.window(RAID, window({ slot(900311, 3, creature(ADD, "A1")), slot(900312, 4, creature(BOSS2, "B1")) }, { masterLooter = true }), T0 + 30)
  eq(sourceOf(db, RAID, "n" .. ADD).kind, "trash") -- the add's blue is kept, as trash, and it is not guessed
  eq(sourceOf(db, RAID, "n" .. BOSS2).guessed, nil)

  local log2, db2 = fresh()
  win(log2, RAID, 4001, "Ipsum the Unready", {}, T0)
  log2.window(RAID, window({ slot(900311, 2, creature(ADD, "A1")), slot(900312, 4, creature(BOSS2, "B1")), slot(900313, 2, creature(BOSS2, "B1")) }, { masterLooter = true }), T0 + 30)
  local guessed = sourceOf(db2, RAID, "n" .. BOSS2)
  eq(guessed.guessed, true)
  eq(guessed.items[900313].n, 1) -- the boss's green kept at the boss floor
  eq(sourceOf(db2, RAID, "n" .. ADD), nil) -- the add's green is below the trash floor
end)

test("a chest claims its encounter's win: the master looter's next corpse is not guessed as the boss", function()
  local log, db = fresh()
  win(log, RAID, 4100, "The Hall of Chests", {}, T0)
  log.window(RAID, window({ slot(900420, 4, object(CHEST)) }, { masterLooter = true }), T0 + 30)
  log.window(RAID, window({ slot(900421, 3, creature(ADD, "A2")) }, { masterLooter = true }), T0 + 90)
  eq(sourceOf(db, RAID, "n" .. ADD).kind, "trash")
  eq(db.drops.stats.guessed, nil)
end)

test("a creature kept as a rare keeps the rare floor after a /reload, when its unit was not seen again", function()
  local log, db = fresh()
  log.unit(RARE, "Lord Lorem", "rareelite")
  log.window(DUNGEON, window({ slot(900103, 2, creature(RARE, "R1")) }), T0)
  local after = DropLog.new(db)
  after.window(DUNGEON, window({ slot(900110, 2, creature(RARE, "R2")) }), T0 + 7 * 86400)
  local rare = sourceOf(db, DUNGEON, "n" .. RARE)
  eq(rare.kind, "rare")
  eq(rare.kills, 2)
  eq(rare.items[900110].n, 1)
end)

test("a full creature never drops an item seen more than once, nor one of the same kill, for a new one", function()
  local saved = DropLog.MAX_ITEMS_PER_SOURCE
  local ok, problem = pcall(function()
    DropLog.MAX_ITEMS_PER_SOURCE = 3
    local log, db = fresh()
    for night = 1, 3 do
      win(log, DUNGEON, 3001, "The Fixture Warden", { BOSS }, T0 + night * 86400)
      log.window(DUNGEON, window({ slot(901, 3, creature(BOSS, "N" .. night)), slot(902, 3, creature(BOSS, "N" .. night)), slot(903, 3, creature(BOSS, "N" .. night)) }), T0 + night * 86400 + 10)
    end
    win(log, DUNGEON, 3001, "The Fixture Warden", { BOSS }, T0 + 4 * 86400)
    log.window(DUNGEON, window({ slot(904, 3, creature(BOSS, "N4")), slot(905, 3, creature(BOSS, "N4")), slot(901, 3, creature(BOSS, "N4")) }), T0 + 4 * 86400 + 10)
    local boss = sourceOf(db, DUNGEON, "n" .. BOSS)
    eq(boss.items[902].n, 3)
    eq(boss.items[903].n, 3)
    eq(boss.items[901].n, 4)
    eq(boss.items[904], nil)
    eq(boss.items[905], nil)
    eq(db.drops.stats.itemsDropped, 2)
  end)
  DropLog.MAX_ITEMS_PER_SOURCE = saved
  if not ok then error(problem, 0) end
end)

test("where an item drops is remembered until the log changes", function()
  local log, db = fresh()
  win(log, DUNGEON, 3001, "The Fixture Warden", { BOSS }, T0)
  log.window(DUNGEON, window({ slot(900101, 3, creature(BOSS)) }), T0 + 5)
  eq(log.sourceOf(900101), "The Fixture Warden, Hollow Test Keep")
  eq(log.sourceOf(900555), nil)
  db.drops.zones["9100:1"].sources["n" .. BOSS].name = "Renamed Behind Its Back"
  eq(log.sourceOf(900101), "The Fixture Warden, Hollow Test Keep") -- the remembered answer
  log.window(DUNGEON, window({ slot(900555, 4, creature(RARE)) }), T0 + 6)
  eq(log.sourceOf(900101), "Renamed Behind Its Back, Hollow Test Keep")
end)

-- Group loot (the live client, 2026-11-12): no boss units in a dungeon, so the boss is the corpse that held what the loot history
-- filed under the win's rolls. The rolls come before the window when another player opened the corpse first, after it otherwise.
local GROUP = { instanceId = 9100, difficultyId = 1, name = "Hollow Test Keep", instanceType = "party", maxPlayers = 5, method = 3 }

test("group loot, rolls first: the corpse holding a rolled item is the boss at once, named after the encounter, each item counted once", function()
  local log, db = fresh()
  win(log, GROUP, 3001, "The Fixture Warden", {}, T0)
  log.roll(GROUP, { itemId = 900101, name = "Item 900101", quality = 3 }, 3001, T0 + 5)
  log.roll(GROUP, { itemId = 900102, name = "Item 900102", quality = 2 }, 3001, T0 + 5)
  eq(sourceOf(db, GROUP, "e3001").count, 2)
  log.window(GROUP, window({ slot(900101, 3, creature(BOSS)), slot(900102, 2, creature(BOSS)), slot(900103, 1, creature(BOSS)) }), T0 + 20)
  eq(log.holding(), 0)
  local boss = sourceOf(db, GROUP, "n" .. BOSS)
  eq(boss.kind, "boss")
  eq(boss.name, "The Fixture Warden")
  eq(boss.encounterId, 3001)
  eq(boss.guessed, nil)
  eq(boss.kills, 1)
  eq(boss.items[900101].n, 1) -- the roll and the window are one drop
  eq(boss.items[900102].n, 1)
  eq(boss.items[900101].via, "window")
  eq(boss.items[900103], nil) -- below the boss floor
  eq(sourceOf(db, GROUP, "e3001"), nil) -- the encounter's loose items joined the boss
  eq(zoneOf(db, GROUP).bosses[BOSS], 3001)
  eq(db.drops.stats.matchedAtOnce, 1)
  -- the next run: the boss is known, its corpse is the boss again with no roll needed, and it counts a second kill
  win(log, GROUP, 3001, "The Fixture Warden", {}, T0 + 4000)
  log.window(GROUP, window({ slot(900101, 3, creature(BOSS, "02")) }), T0 + 4020)
  eq(sourceOf(db, GROUP, "n" .. BOSS).kills, 2)
  eq(sourceOf(db, GROUP, "n" .. BOSS).items[900101].n, 2)
end)

test("group loot, window first: the corpse waits, the late roll makes it the boss, and its other items come with it", function()
  local log, db = fresh()
  win(log, GROUP, 3001, "The Fixture Warden", {}, T0)
  log.window(GROUP, window({ slot(900101, 3, creature(BOSS)), slot(900104, 4, creature(BOSS), { boe = true }) }), T0 + 10)
  eq(log.holding(), 1)
  eq(sourceOf(db, GROUP, "n" .. BOSS), nil)
  eq(db.drops.stats.held, 1)
  -- the loot history files the roll 2 seconds after it started
  log.roll(GROUP, { itemId = 900101, name = "Item 900101", quality = 3 }, 3001, T0 + 12)
  eq(log.holding(), 0)
  local boss = sourceOf(db, GROUP, "n" .. BOSS)
  eq(boss.kind, "boss")
  eq(boss.name, "The Fixture Warden")
  eq(boss.kills, 1)
  eq(boss.items[900101].n, 1)
  eq(boss.items[900104].n, 1)
  eq(boss.items[900104].boe, true)
  eq(sourceOf(db, GROUP, "e3001"), nil)
  eq(db.drops.stats.matched, 1)
  -- the same corpse opened again counts nothing more
  log.window(GROUP, window({ slot(900101, 3, creature(BOSS)) }), T0 + 30)
  eq(sourceOf(db, GROUP, "n" .. BOSS).items[900101].n, 1)
end)

test("group loot: a corpse whose items were never rolled is trash after the wait, and one with nothing a roll could be for never waits", function()
  local log, db = fresh()
  win(log, GROUP, 3001, "The Fixture Warden", {}, T0)
  log.roll(GROUP, { itemId = 900101, name = "Item 900101", quality = 3 }, 3001, T0 + 5)
  -- trash with a Rare item that was not the boss's roll: it waits, then it is trash (Rare is the trash floor)
  log.window(GROUP, window({ slot(900201, 3, creature(TRASH, "01")) }), T0 + 40)
  eq(log.holding(), 1)
  log.settle(T0 + 40 + DropLog.HOLD - 1)
  eq(log.holding(), 1)
  log.settle(T0 + 40 + DropLog.HOLD)
  eq(log.holding(), 0)
  local trash = sourceOf(db, GROUP, "n" .. TRASH)
  eq(trash.kind, "trash")
  eq(trash.items[900201].n, 1)
  eq(db.drops.stats.heldTrash, 1)
  -- trash with only white items does not wait, and keeps nothing
  log.window(GROUP, window({ slot(900202, 1, creature(TRASH, "02")) }), T0 + 50)
  eq(log.holding(), 0)
  -- more than 5 minutes after the win nothing waits: trash at once
  log.window(GROUP, window({ slot(900203, 3, creature(TRASH, "03")) }), T0 + DropLog.WINDOW + 1)
  eq(log.holding(), 0)
  eq(sourceOf(db, GROUP, "n" .. TRASH).items[900203].n, 1)
  -- the boss corpse opened late (after 5 minutes) is trash: the win is too old to match
  eq(zoneOf(db, GROUP).bosses[TRASH], nil)
end)

test("group loot: the next window settles the corpses whose wait is over, and a full hold files the oldest", function()
  local log, db = fresh()
  win(log, GROUP, 3001, "The Fixture Warden", {}, T0)
  log.window(GROUP, window({ slot(900201, 3, creature(TRASH, "01")) }), T0 + 10)
  eq(log.holding(), 1)
  log.window(GROUP, window({ slot(900202, 3, creature(TRASH, "02")) }), T0 + 10 + DropLog.HOLD)
  eq(log.holding(), 1) -- the first was filed, the second waits
  eq(sourceOf(db, GROUP, "n" .. TRASH).items[900201].n, 1)
  local saved = DropLog.MAX_HELD
  DropLog.MAX_HELD = 2
  local ok, problem = pcall(function()
    log.window(GROUP, window({ slot(900203, 3, creature(TRASH, "03")) }), T0 + 30)
    log.window(GROUP, window({ slot(900204, 3, creature(TRASH, "04")) }), T0 + 31)
    eq(log.holding(), 2)
    eq(sourceOf(db, GROUP, "n" .. TRASH).items[900202].n, 1)
  end)
  DropLog.MAX_HELD = saved
  if not ok then error(problem, 0) end
end)

test("group loot: an encounter with two bosses, rolls first: each corpse takes only its own item, counted once", function()
  local log, db = fresh()
  win(log, GROUP, 3002, "The Twin Fixtures", {}, T0)
  log.roll(GROUP, { itemId = 900301, name = "Item 900301", quality = 3 }, 3002, T0 + 3)
  log.roll(GROUP, { itemId = 900302, name = "Item 900302", quality = 3 }, 3002, T0 + 3)
  log.roll(GROUP, { itemId = 900303, name = "Item 900303", quality = 3 }, 3002, T0 + 3) -- from a corpse nobody here opened
  log.window(GROUP, window({ slot(900301, 3, creature(BOSS, "01")) }), T0 + 10)
  log.window(GROUP, window({ slot(900302, 3, creature(BOSS2, "01")) }), T0 + 12)
  eq(zoneOf(db, GROUP).bosses[BOSS], 3002)
  eq(zoneOf(db, GROUP).bosses[BOSS2], 3002)
  local first, second = sourceOf(db, GROUP, "n" .. BOSS), sourceOf(db, GROUP, "n" .. BOSS2)
  eq(first.kind, "boss")
  eq(first.items[900301].n, 1)
  eq(first.items[900302], nil)
  eq(first.items[900303], nil)
  eq(second.items[900302].n, 1)
  eq(second.items[900301], nil)
  -- the item no matched corpse held stays under the encounter
  local loose = sourceOf(db, GROUP, "e3002")
  eq(loose.count, 1)
  eq(loose.items[900303].n, 1)
end)

test("group loot: an encounter with two bosses, both corpses waiting: each roll goes to its own corpse", function()
  local log, db = fresh()
  win(log, GROUP, 3002, "The Twin Fixtures", {}, T0)
  log.window(GROUP, window({ slot(900301, 3, creature(BOSS, "01")) }), T0 + 10)
  log.window(GROUP, window({ slot(900302, 3, creature(BOSS2, "01")) }), T0 + 11)
  eq(log.holding(), 2)
  log.roll(GROUP, { itemId = 900301, name = "Item 900301", quality = 3 }, 3002, T0 + 12)
  log.roll(GROUP, { itemId = 900302, name = "Item 900302", quality = 3 }, 3002, T0 + 13)
  eq(log.holding(), 0)
  eq(sourceOf(db, GROUP, "n" .. BOSS).items[900302], nil)
  eq(sourceOf(db, GROUP, "n" .. BOSS2).items[900302].n, 1)
  eq(sourceOf(db, GROUP, "n" .. BOSS).items[900301].n, 1)
  eq(sourceOf(db, GROUP, "e3002"), nil)
  -- a roll of the first boss's item after its window, in the same kill, counts nothing more
  log.roll(GROUP, { itemId = 900301, name = "Item 900301", quality = 3 }, 3002, T0 + 20)
  eq(sourceOf(db, GROUP, "n" .. BOSS).items[900301].n, 1)
end)

test("a corpse waiting for its rolls survives a /reload: the roll after it still makes it the boss", function()
  local log, db = fresh()
  win(log, GROUP, 3001, "The Fixture Warden", {}, T0)
  log.window(GROUP, window({ slot(900101, 3, creature(BOSS)), slot(900104, 4, creature(BOSS)) }), T0 + 10)
  eq(log.holding(), 1)
  local after = DropLog.new(db) -- the /reload
  eq(after.holding(), 1)
  after.roll(GROUP, { itemId = 900101, name = "Item 900101", quality = 3 }, 3001, T0 + 12)
  eq(after.holding(), 0)
  eq(zoneOf(db, GROUP).bosses[BOSS], 3001)
  eq(sourceOf(db, GROUP, "n" .. BOSS).items[900104].n, 1)
  -- the same corpse opened again is a repeat
  after.window(GROUP, window({ slot(900104, 4, creature(BOSS)) }), T0 + 20)
  eq(sourceOf(db, GROUP, "n" .. BOSS).items[900104].n, 1)
end)

test("a boss guessed under master loot is matched in a group-loot run in either order", function()
  for _, rollFirst in ipairs({ true, false }) do
    local log, db = fresh()
    win(log, RAID, 4001, "Ipsum the Unready", {}, T0)
    log.window(RAID, window({ slot(900301, 4, creature(BOSS2, "01")) }, { masterLooter = true }), T0 + 30)
    eq(sourceOf(db, RAID, "n" .. BOSS2).guessed, true)
    win(log, RAID, 4001, "Ipsum the Unready", {}, T0 + 4000)
    local corpse = window({ slot(900301, 4, creature(BOSS2, "02")) })
    if rollFirst then
      log.roll(RAID, { itemId = 900301, name = "Item 900301", quality = 4 }, 4001, T0 + 4005)
      log.window(RAID, corpse, T0 + 4010)
    else
      log.window(RAID, corpse, T0 + 4010)
      log.roll(RAID, { itemId = 900301, name = "Item 900301", quality = 4 }, 4001, T0 + 4012)
    end
    local boss = sourceOf(db, RAID, "n" .. BOSS2)
    eq(zoneOf(db, RAID).bosses[BOSS2], 4001)
    eq(boss.guessed, nil)
    eq(boss.kills, 2)
    eq(boss.items[900301].n, 2)
    eq(sourceOf(db, RAID, "e4001"), nil)
  end
end)

test("an item never counts more often than its creature was killed, also when a late trash entry turns out to be the boss", function()
  local log, db = fresh()
  win(log, GROUP, 3001, "The Fixture Warden", {}, T0)
  log.roll(GROUP, { itemId = 900101, name = "Item 900101", quality = 3 }, 3001, T0 + 5)
  win(log, GROUP, 3001, "The Fixture Warden", {}, T0 + 4000)
  log.roll(GROUP, { itemId = 900101, name = "Item 900101", quality = 3 }, 3001, T0 + 4005)
  log.window(GROUP, window({ slot(900101, 3, creature(BOSS, "02")) }), T0 + 4000 + DropLog.WINDOW + 10) -- too late: trash
  win(log, GROUP, 3001, "The Fixture Warden", {}, T0 + 8000)
  log.roll(GROUP, { itemId = 900101, name = "Item 900101", quality = 3 }, 3001, T0 + 8005)
  log.window(GROUP, window({ slot(900101, 3, creature(BOSS, "03")) }), T0 + 8010)
  for _, source in pairs(zoneOf(db, GROUP).sources) do
    for _, item in pairs(source.items) do is_true(item.n <= source.kills) end
  end
  eq(sourceOf(db, GROUP, "n" .. BOSS).kind, "boss")
end)

test("group loot: a creature kept as trash before (a log from build 0.0.19) becomes the boss when its corpse matches", function()
  local log, db = fresh()
  -- the old log: the boss corpse was filed as trash after a won encounter more than 5 minutes ago
  log.window(GROUP, window({ slot(900101, 3, creature(BOSS, "01")) }), T0 - 1000)
  eq(sourceOf(db, GROUP, "n" .. BOSS).kind, "trash")
  win(log, GROUP, 3001, "The Fixture Warden", {}, T0)
  log.roll(GROUP, { itemId = 900101, name = "Item 900101", quality = 3 }, 3001, T0 + 4)
  log.window(GROUP, window({ slot(900101, 3, creature(BOSS, "02")) }), T0 + 20)
  local boss = sourceOf(db, GROUP, "n" .. BOSS)
  eq(boss.kind, "boss")
  eq(boss.encounterId, 3001)
  eq(boss.items[900101].n, 2)
end)

test("a rare is never taken for a boss, even when its corpse holds an item rolled for the win", function()
  local log, db = fresh()
  log.unit(RARE, "Lord Lorem", "rare")
  win(log, GROUP, 3001, "The Fixture Warden", {}, T0)
  log.roll(GROUP, { itemId = 900103, name = "Item 900103", quality = 3 }, 3001, T0 + 4)
  log.window(GROUP, window({ slot(900103, 3, creature(RARE)) }), T0 + 20)
  eq(log.holding(), 0)
  eq(sourceOf(db, GROUP, "n" .. RARE).kind, "rare")
  eq(zoneOf(db, GROUP).bosses[RARE], nil)
end)
