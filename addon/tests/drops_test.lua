-- The drops string (IntrepidManager/core/Drops.lua): built from the drop log, written, read back through the envelope, and checked the
-- way the Raid Desk's import will (docs/design/drop-list-import.md, section 5). Invented ids and names only.

local ns = load_core({}, "Crc32", "Json", "Envelope", "Ids", "DropLog", "Drops")
local DropLog, Drops, Envelope, Json, Ids = ns.DropLog, ns.Drops, ns.Envelope, ns.Json, ns.Ids

local T0 = 1796866200
local DAY = 86400
local DUNGEON = { instanceId = 9100, difficultyId = 1, name = "Hollow Test Keep", instanceType = "party", maxPlayers = 5 }
local RAID = { instanceId = 9200, difficultyId = 9, name = "The Lorem Vaults", instanceType = "raid", maxPlayers = 40 }
local BOSS, BOSS2, RARE, TRASH = 990011, 990013, 990012, 990031

local function creature(npcId, spawn) return "Creature-0-4170-389-12-" .. npcId .. "-" .. (spawn or "01") end
local function slot(itemId, quality, source) return { itemId = itemId, name = "Item " .. itemId, quality = quality, sources = { source } } end
local function dateOf(t) return os.date("!%Y-%m-%d", t) end

-- A drop log after a dungeon run and a raid night.
local function sampleLog()
  local db = {}
  local log = DropLog.new(db)
  log.encounterStart(DUNGEON, 3001, "The Fixture Warden")
  log.bossUnit(BOSS, "The Fixture Warden")
  log.encounterEnd(DUNGEON, 3001, "The Fixture Warden", true, T0)
  log.window(DUNGEON, { slots = { slot(900101, 3, creature(BOSS)), slot(900102, 2, creature(BOSS)) } }, T0 + 10)
  log.unit(RARE, "Lord Lorem", "rare")
  log.window(DUNGEON, { slots = { slot(900103, 2, creature(RARE)) } }, T0 + 20)
  log.window(DUNGEON, { slots = { slot(900104, 3, creature(TRASH)) } }, T0 + 30)
  log.encounterStart(RAID, 4001, "Ipsum the Unready")
  log.encounterEnd(RAID, 4001, "Ipsum the Unready", true, T0 + DAY)
  log.window(RAID, { masterLooter = true, threshold = 2, slots = { slot(900301, 4, creature(BOSS2)) } }, T0 + DAY + 30)
  return log, db
end

local function build(db, options)
  options = options or {}
  options.at = options.at or (T0 + 2 * DAY)
  options.id = options.id or "d-tpt9k0-8vbn"
  options.version = options.version or "0.0.19"
  options.dateOf = dateOf
  return Drops.build(db.drops, options)
end

local function readBack(model)
  local text = Drops.encode(model)
  local read = Envelope.read(text, "drops")
  if not read.ok then error("read failed: " .. tostring(read.code) .. " " .. tostring(read.message)) end
  return read.model, text
end

test("a drops id is d-, the time in base 36 and four random characters", function()
  local n = 0
  local id = Ids.dropsId(T0, function() n = n + 1 return n end)
  eq(id, "d-tpt2u0-0123") -- (1 to 36 pick the digits 0 to z)
  is_true(Ids.isId(id))
end)

test("the string holds the zones newest first, each creature with its items and their evidence, and reads back clean", function()
  local _, db = sampleLog()
  local model, counts = build(db)
  eq(counts.zones, 2)
  eq(counts.sources, 4)
  eq(counts.seen, 5)
  eq(counts.journal, 0)
  eq(model.schema, 1)
  eq(model.by, "IntrepidManager/0.0.19")
  eq(model.journal, nil)
  eq(model.zones[1].name, "The Lorem Vaults")
  eq(model.zones[1].kind, "raid")
  eq(model.zones[1].players, 40)
  eq(model.zones[1].instanceId, 9200)
  eq(model.zones[1].difficultyId, 9)
  local guessed = model.zones[1].sources[1]
  eq(guessed.guessed, true)
  eq(guessed.npcId, BOSS2)
  eq(guessed.encounterId, 4001)
  -- the dungeon: the boss first, then the rare, then trash
  local dungeon = model.zones[2]
  eq(dungeon.sources[1].kind, "boss")
  eq(dungeon.sources[2].kind, "rare")
  eq(dungeon.sources[3].kind, "trash")
  deep_eq(dungeon.sources[1].itemIds, { 900101, 900102 })
  deep_eq(dungeon.sources[1].seen[1], { itemId = 900101, n = 1, last = "2026-12-10", via = "window", name = "Item 900101", quality = 3 })
  eq(dungeon.sources[1].kills, 1)
  eq(dungeon.sources[1].first, "2026-12-10")
  local decoded, text = readBack(model)
  is_true(string.find(text, '^IM1:drops:j:%d+:{"schema":1,"id":"d%-tpt9k0%-8vbn","at":%d+,"by":"IntrepidManager/0.0.19","zones":%[') ~= nil)
  local checked = Drops.check(decoded)
  is_true(checked.ok)
  deep_eq(checked.rowErrors, {})
end)

test("which zones: the last 7 days by default in the window, picked keys, or every zone", function()
  local log, db = sampleLog()
  local _, recent = build(db, { since = T0 + DAY })
  eq(recent.zones, 1)
  local zones = log.zones()
  local picked = build(db, { keys = { zones[2].key, "9999:1" } })
  eq(#picked.zones, 1)
  eq(picked.zones[1].name, "Hollow Test Keep")
  local _, nothing = build(db, { keys = {} })
  eq(nothing.zones, 0)
  local _, all = build(db)
  eq(all.zones, 2)
end)

test("a creature's items are the ones seen most first, at most 80, and a kept creature with nothing listed still shows for a boss", function()
  local db = { drops = { schema = 1, zoneCount = 1, itemCount = 0, corpses = {}, cursor = 0, stats = {}, zones = {
    ["9100:1"] = { instanceId = 9100, difficultyId = 1, name = "Hollow Test Keep", kind = "dungeon", players = 5, first = T0, last = T0, count = 2, bosses = {}, guesses = {}, methods = {}, sources = {
      n990011 = { npcId = BOSS, name = "The Fixture Warden", kind = "boss", kills = 3, first = T0, last = T0, count = 0, items = {} },
      n990031 = { npcId = TRASH, name = "Dusty Sentry", kind = "trash", kills = 1, first = T0, last = T0, count = 0, items = {} },
    } },
  } } }
  local items = db.drops.zones["9100:1"].sources.n990011.items
  for i = 1, 90 do items[900000 + i] = { n = (i % 7) + 1, last = T0 + i, via = "window" } end
  local model = build(db)
  local boss = model.zones[1].sources[1]
  eq(#boss.itemIds, 80)
  eq(#boss.seen, 80)
  eq(boss.seen[1].n, 7)
  is_true(boss.seen[1].last >= boss.seen[2].last or boss.seen[1].n > boss.seen[2].n)
  -- the trash creature with no items is left out; the boss with items stays
  eq(#model.zones[1].sources, 1)
  is_true(Drops.check((readBack(model))).ok)
end)

-- An invented journal zone, in the shape game/DungeonJournal.lua gives.
local function journalZone()
  return {
    name = "Hollow Test Keep", kind = "dungeon", players = 5, partial = true, skipped = 2,
    sources = {
      { npcId = BOSS, name = "The Fixture Warden", kind = "boss", itemIds = { 900101, 900105, 900106 } },
      { npcId = 990015, name = "Quiet Placeholder", kind = "boss", itemIds = { 900107 } },
      { name = "lord   LOREM", kind = "rare", itemIds = { 900108 } },
    },
    zoneWide = { 900109 },
  }
end

test("DungeonJournal's lists, when asked: its items as evidence on the same creature, a boss the log never saw as its own source", function()
  local _, db = sampleLog()
  local model, counts = build(db, { journal = { version = "2.0.3", zoneFor = function(name)
    if name == "Hollow Test Keep" then return journalZone() end
  end } })
  eq(model.journal, "ForeverDungeonJournal/2.0.3")
  local dungeon = model.zones[2]
  eq(dungeon.journalPartial, true)
  eq(dungeon.journalSkipped, 2)
  local boss = dungeon.sources[1]
  deep_eq(boss.itemIds, { 900101, 900102, 900105, 900106 })
  deep_eq(boss.journal, { 900101, 900105, 900106 })
  local rare = dungeon.sources[2]
  deep_eq(rare.journal, { 900108 }) -- matched by name, ignoring case and spaces
  local placeholder = dungeon.sources[#dungeon.sources]
  eq(placeholder.name, "Quiet Placeholder")
  eq(placeholder.npcId, 990015)
  deep_eq(placeholder.itemIds, { 900107 })
  deep_eq(placeholder.journal, { 900107 })
  eq(placeholder.seen, nil)
  eq(counts.journal, 5)
  -- the zone-wide (trash) list of the journal is not sent
  for _, source in ipairs(dungeon.sources) do
    for _, id in ipairs(source.itemIds) do is_true(id ~= 900109) end
  end
  is_true(Drops.check((readBack(model))).ok)
  deep_eq(Drops.check((readBack(model))).rowErrors, {})
end)

test("the journal naming the same creature as a boss makes a guessed boss sure", function()
  local _, db = sampleLog()
  local model = build(db, { journal = { version = "2.0.3", zoneFor = function(name)
    if name == "The Lorem Vaults" then
      return { name = name, sources = { { npcId = BOSS2, name = "Ipsum the Unready", kind = "boss", itemIds = { 900301, 900302 } } } }
    end
  end } })
  local boss = model.zones[1].sources[1]
  eq(boss.guessed, nil)
  deep_eq(boss.journal, { 900301, 900302 })
end)

test("a dungeon from DungeonJournal alone (/im drops dj): only journal evidence, no instance id, the journal named", function()
  local _, db = sampleLog()
  local model, counts = build(db, { keys = {}, extra = { journalZone() }, journal = { version = "2.0.3" } })
  eq(counts.zones, 1)
  local zone = model.zones[1]
  eq(zone.name, "Hollow Test Keep")
  eq(zone.instanceId, nil)
  eq(#zone.sources, 3)
  for _, source in ipairs(zone.sources) do
    eq(source.seen, nil)
    deep_eq(source.journal, source.itemIds)
  end
  eq(model.journal, "ForeverDungeonJournal/2.0.3")
  is_true(Drops.check((readBack(model))).ok)
  -- the same dungeon is not added twice when the log has it too
  local both = build(db, { extra = { journalZone() }, journal = { version = "2.0.3" } })
  eq(#both.zones, 2)
end)

-- A decoded model of the sample, to break one thing at a time.
local function decodedSample()
  local _, db = sampleLog()
  return (readBack((build(db))))
end

test("the checks refuse the whole string for a bad top: schema, id, time, maker, no zones", function()
  for _, change in ipairs({
    function(m) m.schema = 2 end, function(m) m.id = "bad id" end, function(m) m.at = 1.5 end, function(m) m.by = "" end,
    function(m) m.zones = Json.list({}) end, function(m) m.zones = {} end, function(m) m.journal = 5 end,
  }) do
    local m = decodedSample()
    change(m)
    local checked = Drops.check(m)
    eq(checked.ok, false)
    eq(checked.code, "E_PAYLOAD")
  end
  eq(Drops.check("text").ok, false)
end)

test("the checks drop one zone or one creature with its row, and keep the rest", function()
  local cases = {
    { function(m) m.zones[1].kind = "cave" end, { "zone:1" } },
    { function(m) m.zones[1].players = 41 end, { "zone:1" } },
    { function(m) m.zones[2].name = " " end, { "zone:2" } },
    { function(m) m.zones[2].sources[1].kind = "elite" end, { "zone:2/source:1" } },
    { function(m) m.zones[2].sources[1].itemIds[3] = 900101 end, { "zone:2/source:1" } },              -- a repeat
    { function(m) m.zones[2].sources[1].itemIds[3] = 900199 end, { "zone:2/source:1" } },              -- no evidence
    { function(m) m.zones[2].sources[1].seen[1].itemId = 900199 end, { "zone:2/source:1" } },          -- seen, not listed
    { function(m) m.zones[2].sources[1].first = "2026-12-31" end, { "zone:2/source:1" } },             -- first after last
    { function(m) m.zones[2].sources[1].seen[1].via = "mail" end, { "zone:2/source:1" } },
    { function(m) m.zones[2].sources[1].seen[1].quality = 9 end, { "zone:2/source:1" } },
    { function(m) m.zones[2].sources[2].npcId = 0 end, { "zone:2/source:2" } },
    { function(m) m.zones[2].sources[2].journal = Json.list({ 900777 }) end, { "zone:2/source:2" } },  -- journal id not listed
    { function(m) m.zones[1].sources[1].guessed = false end, { "zone:1/source:1" } },
  }
  for i, case in ipairs(cases) do
    local m = decodedSample()
    case[1](m)
    local checked = Drops.check(m)
    if not checked.ok then error("case " .. i .. ": refused: " .. tostring(checked.message)) end
    local ok, why = pcall(deep_eq, checked.rowErrors, case[2])
    if not ok then error("case " .. i .. ": " .. why) end
  end
end)

test("a drops string in the awards box says where it belongs; a damaged one is refused", function()
  local _, db = sampleLog()
  local text = Drops.encode((build(db)))
  local wrong = Envelope.read(text, "awards")
  eq(wrong.code, "E_KIND")
  is_true(string.find(wrong.message, "drop list import", 1, true) ~= nil)
  local cut = Envelope.read(string.sub(text, 1, #text - 20), "drops")
  eq(cut.ok, false)
end)

test("no person in the string: the maker is the addon, and nothing of a player's is in the log to send", function()
  local _, db = sampleLog()
  local text = Drops.encode((build(db, { version = "0.0.19" })))
  is_true(string.find(text, '"by":"IntrepidManager/0.0.19"', 1, true) ~= nil)
  eq(string.find(text, "Player-", 1, true), nil)
  eq(string.find(text, "Creature-", 1, true), nil)
end)

test("size: a raid zone after a night with 8 bosses and 30 trash creatures is a few thousand characters", function()
  local db = {}
  local log = DropLog.new(db)
  for b = 1, 8 do
    log.encounterStart(RAID, 5000 + b, "Boss Number " .. b)
    log.bossUnit(991000 + b, "Boss Number " .. b)
    log.encounterEnd(RAID, 5000 + b, "Boss Number " .. b, true, T0 + b * 600)
    local slots = {}
    for i = 1, 4 do slots[i] = slot(910000 + b * 100 + i, 4, creature(991000 + b, "B" .. b)) end
    log.window(RAID, { masterLooter = true, threshold = 2, slots = slots }, T0 + b * 600 + 30)
  end
  for t = 1, 30 do log.window(RAID, { slots = { slot(920000 + t, 3, creature(992000 + t, "T" .. t)) } }, T0 + 6000 + t) end
  local text = Drops.encode((build(db)))
  is_true(#text > 2000 and #text < 12000)
end)

test("two journal entries for one creature add to its evidence, never replace it; the string stays clean", function()
  local _, db = sampleLog()
  local model = build(db, { journal = { version = "2.0.3", zoneFor = function(name)
    if name == "Hollow Test Keep" then
      return { name = name, sources = {
        { npcId = BOSS, name = "The Fixture Warden", kind = "boss", itemIds = { 900105, 900106 } },
        { name = "The Fixture Warden", kind = "boss", itemIds = { 900107 } },             -- no npc id: matched by name
        { npcId = 990077, name = "Second Placeholder", kind = "boss", itemIds = { 900120 } },
        { npcId = 990077, name = "Second Placeholder", kind = "boss", itemIds = { 900121 } }, -- the same unseen boss twice
      } }
    end
  end } })
  local dungeon = model.zones[2]
  deep_eq(dungeon.sources[1].journal, { 900105, 900106, 900107 })
  local placeholders = 0
  for _, source in ipairs(dungeon.sources) do
    if source.npcId == 990077 then
      placeholders = placeholders + 1
      deep_eq(source.itemIds, { 900120, 900121 })
    end
  end
  eq(placeholders, 1)
  local checked = Drops.check((readBack(model)))
  is_true(checked.ok)
  deep_eq(checked.rowErrors, {})
end)

test("a journal boss with another npc id is another creature, even with the same name", function()
  local _, db = sampleLog()
  local model = build(db, { journal = { version = "2.0.3", zoneFor = function(name)
    if name == "The Lorem Vaults" then
      return { name = name, sources = { { npcId = 990011, name = "Ipsum the Unready", kind = "boss", itemIds = { 900301, 900302 } } } }
    end
  end } })
  local raid = model.zones[1]
  eq(#raid.sources, 2)
  eq(raid.sources[1].npcId, BOSS2)
  eq(raid.sources[1].guessed, true)
  eq(raid.sources[1].journal, nil)
  eq(raid.sources[2].npcId, 990011)
  deep_eq(raid.sources[2].journal, { 900301, 900302 })
end)
