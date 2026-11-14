-- Intrepid Manager: reads the community addon DungeonJournal (folder ForeverDungeonJournal) when the player has it installed. It is an
-- optional dependency (the TOC's OptionalDeps), never required.
--
-- Read only. Nothing here changes the journal's data. The one call into the journal that does something is open(), which asks the
-- journal to show an item, as its own key binding does. Every read is guarded: if the journal is missing, or its shape changes in a
-- later version, the answers are nil or empty, and nothing else in this addon changes.
--
-- DungeonJournal is All Rights Reserved. None of its code or data is copied into this repository: the tests use an invented journal
-- of the same shape. What it lists reaches the guild only the way any addon's data reaches its player: on that player's screen, in
-- that player's paste.
--
-- What it publishes, as read on the loot owner's copy (2026-11-12): the global ForeverDungeonJournal_NS, holding
--   DB[dungeon] = { fullItemsTBD = true?, bosses = { { name, npcID?, rare?, trash?, recipeTab?, loot = { { itemID, "Name", "Slot", quality } } } } }
--   ORDER = { dungeon, ... }
--   GetBossSharedLoot(dungeon, boss): the shared items it moved off that boss's loot when it loaded (rows of the same shape), or nil
--   BossDropSource(itemID): { bossName, dungeonName, ... } for an item one boss drops, nil for shared, trash and quest items
--   OpenItemSource(itemID): opens the journal at the item
--   CurrentDungeon(): the dungeon the player is in, by the journal's own reckoning
--
--   local dj = ns.Game.DungeonJournal.new()   -- tests pass { journal = function() return fake end, version = function() return "1.0" end }
--   dj.available()       -- true when the journal's table is there with a dungeon list
--   dj.version()         -- the journal's TOC version, or nil
--   dj.dungeons()        -- { { name, bosses, items, partial }, ... } in the journal's order
--   dj.find(text)        -- the journal's dungeon name for a typed name ("wailing caverns", "the hall of thanes"), or nil
--   dj.zone(name)        -- that dungeon as a candidate zone for the drops string (shape below), or nil
--   dj.sourceOf(itemId)  -- { boss, dungeon } when one boss drops the item, or nil
--   dj.open(itemId)      -- true when the journal opened at the item
--   dj.check()           -- what the journal looks like, for the result file (counts and true/false only)
--
-- A candidate zone: { name, kind = "dungeon", players = 5, partial = true?, sources = { { npcId?, name, kind, itemIds } }, zoneWide = { ids },
-- skipped = the rows with no valid item id }.
-- A boss's items include its shared items. The journal's trash pages have no creature: their items go to the zone-wide list. Item ids
-- outside 1 to 100,000,000 (the journal keeps a few rows at 0 until it learns the id) are left out.

local _, ns = ...

local DungeonJournal = {}
ns.Game = ns.Game or {}
ns.Game.DungeonJournal = DungeonJournal

DungeonJournal.FOLDER = "ForeverDungeonJournal"
local MAX_ID = 100000000
local MAX_NAME = 100

local function gameId(value)
  return type(value) == "number" and value >= 1 and value <= MAX_ID and value == math.floor(value)
end

-- A name the drops string can carry: text with something in it, cut to 100 characters (bytes here; the journal's names are short).
local function cleanName(value)
  if type(value) ~= "string" then return nil end
  local text = string.match(value, "^%s*(.-)%s*$")
  if text == "" then return nil end
  return string.sub(text, 1, MAX_NAME)
end

-- The key a typed dungeon name is compared by: lower case, spaces collapsed, a leading "the " dropped.
function DungeonJournal.nameKey(text)
  if type(text) ~= "string" then return nil end
  local key = string.lower(string.gsub(string.match(text, "^%s*(.-)%s*$"), "%s+", " "))
  key = string.gsub(key, "^the ", "")
  return key
end

local function defaultJournal()
  local value = _G.ForeverDungeonJournal_NS
  if type(value) == "table" then return value end
  return nil
end

local function defaultVersion()
  if not (C_AddOns and C_AddOns.GetAddOnMetadata) then return nil end
  local ok, value = pcall(C_AddOns.GetAddOnMetadata, DungeonJournal.FOLDER, "Version")
  if ok and type(value) == "string" and value ~= "" then return value end
  return nil
end

function DungeonJournal.new(options)
  options = options or {}
  local getJournal = options.journal or defaultJournal
  local getVersion = options.version or defaultVersion
  local self = {}

  local function journal()
    local ok, value = pcall(getJournal)
    if ok and type(value) == "table" and type(value.DB) == "table" and type(value.ORDER) == "table" then return value end
    return nil
  end

  -- Calls one of the journal's functions, or answers nil when it is missing or fails.
  local function call(fdj, name, ...)
    local fn = fdj and fdj[name]
    if type(fn) ~= "function" then return nil end
    local ok, a = pcall(fn, ...)
    if ok then return a end
    return nil
  end

  function self.available()
    return journal() ~= nil
  end

  function self.version()
    local ok, value = pcall(getVersion)
    if ok and type(value) == "string" then return value end
    return nil
  end

  -- The item ids of one list of the journal's loot rows, added to `into` without repeats. Returns how many rows had no valid id.
  local function addIds(rows, into, seen)
    if type(rows) ~= "table" then return 0 end
    local skipped = 0
    for _, row in ipairs(rows) do
      local id = type(row) == "table" and row[1] or nil
      if gameId(id) then
        if not seen[id] then
          seen[id] = true
          into[#into + 1] = id
        end
      elseif type(row) == "table" then
        skipped = skipped + 1
      end
    end
    return skipped
  end

  -- The journal's dungeon `name` as a candidate zone, or nil.
  local function zoneOf(fdj, name)
    local entry = fdj.DB[name]
    local zoneName = cleanName(name)
    if type(entry) ~= "table" or not zoneName then return nil end
    local zone = { name = zoneName, kind = "dungeon", players = 5, partial = entry.fullItemsTBD == true or nil, sources = {}, zoneWide = {}, skipped = 0 }
    local wideSeen = {}
    for _, boss in ipairs(type(entry.bosses) == "table" and entry.bosses or {}) do
      if type(boss) == "table" and not boss.recipeTab then
        if boss.trash then
          zone.skipped = zone.skipped + addIds(boss.loot, zone.zoneWide, wideSeen)
        else
          local bossName = cleanName(boss.name)
          if bossName then
            local ids, seen = {}, {}
            zone.skipped = zone.skipped + addIds(boss.loot, ids, seen)
            zone.skipped = zone.skipped + addIds(call(fdj, "GetBossSharedLoot", name, boss), ids, seen)
            zone.sources[#zone.sources + 1] = {
              npcId = gameId(boss.npcID) and boss.npcID or nil,
              name = bossName,
              kind = boss.rare and "rare" or "boss",
              itemIds = ids,
            }
          end
        end
      end
    end
    return zone
  end

  function self.dungeons()
    local fdj = journal()
    if not fdj then return {} end
    local list = {}
    for _, name in ipairs(fdj.ORDER) do
      local zone = type(name) == "string" and zoneOf(fdj, name) or nil
      if zone then
        local items = #zone.zoneWide
        for _, source in ipairs(zone.sources) do items = items + #source.itemIds end
        list[#list + 1] = { name = name, bosses = #zone.sources, items = items, partial = zone.partial }
      end
    end
    return list
  end

  function self.find(text)
    local fdj = journal()
    local wanted = DungeonJournal.nameKey(text)
    if not fdj or not wanted or wanted == "" then return nil end
    for _, name in ipairs(fdj.ORDER) do
      if type(name) == "string" and DungeonJournal.nameKey(name) == wanted then return name end
    end
    return nil
  end

  function self.zone(name)
    local fdj = journal()
    if not fdj or type(name) ~= "string" then return nil end
    local ok, zone = pcall(zoneOf, fdj, name)
    if ok then return zone end
    return nil
  end

  function self.sourceOf(itemId)
    local fdj = journal()
    if not fdj or not gameId(itemId) then return nil end
    local source = call(fdj, "BossDropSource", itemId)
    if type(source) ~= "table" then return nil end
    local boss, dungeon = cleanName(source.bossName), cleanName(source.dungeonName)
    if not boss or not dungeon then return nil end
    return { boss = boss, dungeon = dungeon }
  end

  function self.open(itemId)
    local fdj = journal()
    if not fdj or not gameId(itemId) then return false end
    return call(fdj, "OpenItemSource", itemId) == true
  end

  -- What the journal looks like, for the result file: counts and true or false only, no names of people (it has none anyway).
  function self.check(clock)
    local fdj = journal()
    local result = { present = fdj ~= nil, version = self.version() }
    if not fdj then return result end
    local started = clock and clock() or nil
    local dungeons, bosses, items, partial, zeroIds = 0, 0, 0, 0, 0
    for _, name in ipairs(fdj.ORDER) do
      local zone = type(name) == "string" and zoneOf(fdj, name) or nil
      if zone then
        dungeons = dungeons + 1
        bosses = bosses + #zone.sources
        items = items + #zone.zoneWide
        for _, source in ipairs(zone.sources) do items = items + #source.itemIds end
        if zone.partial then partial = partial + 1 end
      end
      local entry = type(name) == "string" and fdj.DB[name] or nil
      for _, boss in ipairs(type(entry) == "table" and type(entry.bosses) == "table" and entry.bosses or {}) do
        for _, row in ipairs(type(boss) == "table" and type(boss.loot) == "table" and boss.loot or {}) do
          if type(row) == "table" and not gameId(row[1]) then zeroIds = zeroIds + 1 end
        end
      end
    end
    result.dungeons, result.bosses, result.items, result.partial, result.badIds = dungeons, bosses, items, partial, zeroIds
    result.functions = {
      GetBossSharedLoot = type(fdj.GetBossSharedLoot) == "function",
      BossDropSource = type(fdj.BossDropSource) == "function",
      OpenItemSource = type(fdj.OpenItemSource) == "function",
      CurrentDungeon = type(fdj.CurrentDungeon) == "function",
    }
    local current = call(fdj, "CurrentDungeon")
    result.inDungeon = type(current) == "string" and current ~= "" or false
    if started and clock then result.ms = clock() - started end
    return result
  end

  return self
end
