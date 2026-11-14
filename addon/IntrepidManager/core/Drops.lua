-- Intrepid Manager: the drops string (IM1:drops:...), which carries the drop log to the Raid Desk's drop list import
-- (docs/design/drop-list-import.md, section 5). Pure Lua 5.1 with no client calls.
--
--   Drops.build(log, options)   the model of a drops string from the drop log's data (DropLog store) and, when asked, DungeonJournal's lists
--   Drops.encode(model)         the string
--   Drops.check(model)          the content checks the importer makes: { ok = true, rowErrors = { "zone:2", "zone:1/source:3" } }
--                               or { ok = false, code = "E_PAYLOAD", message }
--
-- The string never holds a player's name: its `by` is the addon and its version, and its names are zones, creatures and items.

local _, ns = ...

local Drops = {}
ns.Drops = Drops

local Json, Envelope, Ids = ns.Json, ns.Envelope, ns.Ids

Drops.SCHEMA = 1
Drops.MAX_ZONES = 100
Drops.MAX_SOURCES = 100
Drops.MAX_ITEMS = 80
local MAX_ID = 100000000
local MAX_NAME = 100
local KINDS = { boss = true, rare = true, trash = true }
local ZONE_KINDS = { dungeon = true, raid = true }
local VIA = { window = true, roll = true }
local KIND_ORDER = { boss = 1, rare = 2, trash = 3 }

local SEEN = Json.object({ "itemId", "n", "last", "via", "name", "quality", "boe", "quest" })
local SOURCE = Json.object(
  { "npcId", "encounterId", "name", "kind", "guessed", "kills", "first", "last", "itemIds", "seen", "journal", "ej" },
  { itemIds = Json.listOf(), seen = Json.listOf(SEEN), journal = Json.listOf(), ej = Json.listOf() }
)
local ZONE = Json.object(
  { "zoneId", "name", "kind", "players", "instanceId", "difficultyId", "journalPartial", "journalSkipped", "sources" },
  { sources = Json.listOf(SOURCE) }
)
Drops.SHAPE = Json.object({ "schema", "id", "at", "by", "journal", "zones" }, { zones = Json.listOf(ZONE) })

local function gameId(value)
  return type(value) == "number" and value >= 1 and value <= MAX_ID and value == math.floor(value)
end

local function whole(value, low, high)
  return type(value) == "number" and value == math.floor(value) and value >= low and (high == nil or value <= high)
end

local function nameKey(text)
  if type(text) ~= "string" then return nil end
  local key = string.lower(string.gsub(string.match(text, "^%s*(.-)%s*$"), "%s+", " "))
  return (string.gsub(key, "^the ", ""))
end
Drops.nameKey = nameKey

---------------------------------------------------------------------------------------------------------------
-- Building
---------------------------------------------------------------------------------------------------------------

-- One source of the log as a source of the string, its items seen most first (then seen last, then by id).
local function sourceModel(source, dateOf)
  local entries = {}
  for id, item in pairs(source.items or {}) do entries[#entries + 1] = { id = id, item = item } end
  table.sort(entries, function(a, b)
    if a.item.n ~= b.item.n then return a.item.n > b.item.n end
    if (a.item.last or 0) ~= (b.item.last or 0) then return (a.item.last or 0) > (b.item.last or 0) end
    return a.id < b.id
  end)
  local model = {
    npcId = source.npcId, encounterId = source.encounterId, name = source.name, kind = source.kind, guessed = source.guessed or nil,
    kills = source.kills and source.kills >= 1 and source.kills or nil,
    first = source.first and dateOf(source.first) or nil, last = source.last and dateOf(source.last) or nil,
    itemIds = {}, seen = {},
  }
  for i = 1, math.min(#entries, Drops.MAX_ITEMS) do
    local id, item = entries[i].id, entries[i].item
    model.itemIds[#model.itemIds + 1] = id
    model.seen[#model.seen + 1] = {
      itemId = id, n = item.n, last = dateOf(item.last), via = item.via, name = item.name,
      quality = whole(item.quality, 0, 7) and item.quality or nil, boe = item.boe or nil, quest = item.quest or nil,
    }
  end
  if #model.seen == 0 then model.seen = nil end
  return model
end

-- Adds the journal's item ids to a source of the string: as evidence (`journal`) and, while there is room, to its item list.
local function addJournal(model, ids)
  if #ids == 0 then return 0 end
  local listed = {}
  for _, id in ipairs(model.itemIds) do listed[id] = true end
  -- (two journal entries can name one creature: the second adds to the first's evidence, never replaces it)
  local journal = model.journal or {}
  local inJournal = {}
  for _, id in ipairs(journal) do inJournal[id] = true end
  local carried = 0
  for _, id in ipairs(ids) do
    if not inJournal[id] then
      if not listed[id] and #model.itemIds < Drops.MAX_ITEMS then
        model.itemIds[#model.itemIds + 1] = id
        listed[id] = true
      end
      if listed[id] then
        journal[#journal + 1] = id
        inJournal[id] = true
        carried = carried + 1
      end
    end
  end
  if #journal > 0 then model.journal = journal end
  return carried
end

-- The journal's lists put onto a zone of the string: a creature of the log takes the journal's items of the same creature (same
-- npc id, else the same name); a journal boss the log never saw becomes a source of its own. Returns how many ids it carries.
local function mergeJournal(zone, journalZone)
  local carried = 0
  local byNpc, byName = {}, {}
  for _, source in ipairs(zone.sources) do
    if source.npcId then byNpc[source.npcId] = source end
    byName[nameKey(source.name)] = byName[nameKey(source.name)] or source
  end
  for _, entry in ipairs(journalZone.sources or {}) do
    local target = entry.npcId and byNpc[entry.npcId]
    if not target then
      -- by name only when one side has no npc id: two different npc ids are two different creatures
      local named = byName[nameKey(entry.name)]
      if named and (entry.npcId == nil or named.npcId == nil) then target = named end
    end
    if target then
      -- the journal names the same creature as a boss: a guessed boss is sure
      if target.guessed and entry.npcId and target.npcId == entry.npcId and entry.kind == "boss" then target.guessed = nil end
      carried = carried + addJournal(target, entry.itemIds or {})
    elseif #zone.sources < Drops.MAX_SOURCES and #(entry.itemIds or {}) > 0 then
      local model = { npcId = entry.npcId, name = entry.name, kind = entry.kind, itemIds = {} }
      carried = carried + addJournal(model, entry.itemIds)
      zone.sources[#zone.sources + 1] = model
      if model.npcId then byNpc[model.npcId] = model end
      byName[nameKey(model.name)] = byName[nameKey(model.name)] or model
    end
  end
  if journalZone.partial then zone.journalPartial = true end
  if (journalZone.skipped or 0) > 0 then zone.journalSkipped = journalZone.skipped end
  return carried
end

local function sortSources(list, kills)
  table.sort(list, function(a, b)
    local ka, kb = KIND_ORDER[a.kind] or 4, KIND_ORDER[b.kind] or 4
    if ka ~= kb then return ka < kb end
    if a.kind == "trash" and (kills[a] or 0) ~= (kills[b] or 0) then return (kills[a] or 0) > (kills[b] or 0) end
    if (a.first or "") ~= (b.first or "") then return (a.first or "") < (b.first or "") end
    return (a.name or "") < (b.name or "")
  end)
end

-- options:
--   keys     the zone keys to take (default: every zone with `last` at or after `since`, or every zone)
--   since    server time; zones seen before it are left out (when `keys` is not given)
--   at, id   when the string is made and its id (Ids.dropsId)
--   version  the addon's version
--   dateOf(t)  a server time as YYYY-MM-DD
--   journal  { version = "2.0.3", zoneFor = function(zoneName) -> a candidate zone of game/DungeonJournal.lua, or nil }
--   extra    candidate zones of the journal to add as zones of their own (the loot master picked a dungeon)
-- Returns the model and counts: { zones, sources, seen, journal } (seen: items seen in the game; journal: journal ids carried).
function Drops.build(store, options)
  options = options or {}
  local dateOf = options.dateOf or function(t) return date("!%Y-%m-%d", t) end
  local zonesIn = (store and store.zones) or {}
  local picked = {}
  if options.keys then
    for _, key in ipairs(options.keys) do
      if zonesIn[key] then picked[#picked + 1] = key end
    end
  else
    for key, zone in pairs(zonesIn) do
      if not options.since or (zone.last or 0) >= options.since then picked[#picked + 1] = key end
    end
    table.sort(picked, function(a, b)
      local la, lb = zonesIn[a].last or 0, zonesIn[b].last or 0
      if la ~= lb then return la > lb end
      return a < b
    end)
  end
  local counts = { zones = 0, sources = 0, seen = 0, journal = 0 }
  local model = {
    schema = Drops.SCHEMA, id = options.id, at = options.at, by = "IntrepidManager/" .. string.sub(tostring(options.version or "unknown"), 1, 40),
    zones = {},
  }
  local usedJournal = false
  local function addZone(zone)
    if #model.zones >= Drops.MAX_ZONES then return end
    model.zones[#model.zones + 1] = zone
    counts.zones = counts.zones + 1
    counts.sources = counts.sources + #zone.sources
  end

  for _, key in ipairs(picked) do
    local zone = zonesIn[key]
    local out = {
      name = zone.name, kind = zone.kind == "raid" and "raid" or "dungeon",
      players = zone.players or (zone.kind == "raid" and 40 or 5),
      instanceId = gameId(zone.instanceId) and zone.instanceId or nil,
      difficultyId = whole(zone.difficultyId, 1) and zone.difficultyId or nil,
      sources = {},
    }
    local kills = {}
    for _, source in pairs(zone.sources or {}) do
      local entry = sourceModel(source, dateOf)
      if #entry.itemIds > 0 or entry.kind ~= "trash" then
        out.sources[#out.sources + 1] = entry
        kills[entry] = source.kills or 0
        counts.seen = counts.seen + #entry.itemIds
      end
    end
    sortSources(out.sources, kills)
    while #out.sources > Drops.MAX_SOURCES do table.remove(out.sources) end
    local journalZone = options.journal and options.journal.zoneFor and options.journal.zoneFor(zone.name)
    if journalZone then
      local carried = mergeJournal(out, journalZone)
      if carried > 0 then usedJournal = true end
      counts.journal = counts.journal + carried
    end
    addZone(out)
  end

  for _, journalZone in ipairs(options.extra or {}) do
    local taken = false
    for _, zone in ipairs(model.zones) do
      if nameKey(zone.name) == nameKey(journalZone.name) then taken = true end
    end
    if not taken then
      local out = { name = journalZone.name, kind = "dungeon", players = journalZone.players or 5, sources = {} }
      local carried = mergeJournal(out, journalZone)
      if carried > 0 then
        usedJournal = true
        counts.journal = counts.journal + carried
        addZone(out)
      end
    end
  end

  if usedJournal and options.journal and options.journal.version then
    model.journal = "ForeverDungeonJournal/" .. string.sub(tostring(options.journal.version), 1, 40)
  elseif usedJournal then
    model.journal = "ForeverDungeonJournal/unknown"
  end
  return model, counts
end

function Drops.encode(model)
  return Envelope.write("drops", Json.encode(model, Drops.SHAPE))
end

---------------------------------------------------------------------------------------------------------------
-- Checking (what the importer does with a decoded string)
---------------------------------------------------------------------------------------------------------------

local function isDate(value)
  return type(value) == "string" and string.find(value, "^%d%d%d%d%-%d%d%-%d%d$") ~= nil
end

local function isName(value)
  return type(value) == "string" and #value >= 1 and #value <= MAX_NAME and string.find(value, "%S") ~= nil
end

local function isList(value)
  return type(value) == "table" and Json.isList(value)
end

local function idList(value, limit)
  if not isList(value) or #value > limit then return nil end
  local set = {}
  for _, id in ipairs(value) do
    if not gameId(id) or set[id] then return nil end
    set[id] = true
  end
  return set
end

-- Why a source is refused, or nil.
local function sourceProblem(s)
  if type(s) ~= "table" then return "not an object" end
  if s.npcId ~= nil and not gameId(s.npcId) then return "npcId is not a valid id" end
  if s.encounterId ~= nil and not whole(s.encounterId, 1) then return "encounterId is not a valid id" end
  if not isName(s.name) then return "name is missing, blank or too long" end
  if not KINDS[s.kind] then return "kind is not boss, rare or trash" end
  if s.guessed ~= nil and s.guessed ~= true then return "guessed is not true" end
  if s.kills ~= nil and not whole(s.kills, 1) then return "kills is not a whole number from 1" end
  if s.first ~= nil and not isDate(s.first) then return "first is not YYYY-MM-DD" end
  if s.last ~= nil and not isDate(s.last) then return "last is not YYYY-MM-DD" end
  if s.first and s.last and s.first > s.last then return "first is after last" end
  local items = idList(s.itemIds, Drops.MAX_ITEMS)
  if not items then return "itemIds is not a list of up to 80 different item ids" end
  local evidence = {}
  if s.seen ~= nil then
    if not isList(s.seen) then return "seen is not a list" end
    for _, seen in ipairs(s.seen) do
      if type(seen) ~= "table" or not gameId(seen.itemId) then return "a seen entry has no valid itemId" end
      if not items[seen.itemId] then return "a seen item is not in itemIds" end
      if evidence[seen.itemId] then return "an item is seen twice" end
      if not whole(seen.n, 1) then return "a seen entry has no count" end
      if not isDate(seen.last) then return "a seen entry has no last date" end
      if seen.via ~= nil and not VIA[seen.via] then return "via is not window or roll" end
      if seen.name ~= nil and not isName(seen.name) then return "a seen name is blank or too long" end
      if seen.quality ~= nil and not whole(seen.quality, 0, 7) then return "quality is not 0 to 7" end
      if seen.boe ~= nil and seen.boe ~= true then return "boe is not true" end
      if seen.quest ~= nil and seen.quest ~= true then return "quest is not true" end
      evidence[seen.itemId] = true
    end
  end
  for _, field in ipairs({ "journal", "ej" }) do
    if s[field] ~= nil then
      local set = idList(s[field], Drops.MAX_ITEMS)
      if not set then return field .. " is not a list of different item ids" end
      for id in pairs(set) do
        if not items[id] then return "a " .. field .. " item is not in itemIds" end
        evidence[id] = true
      end
    end
  end
  for id in pairs(items) do
    if not evidence[id] then return "an item has no evidence (seen, journal or ej)" end
  end
  return nil
end

local function zoneProblem(z)
  if type(z) ~= "table" then return "not an object" end
  if z.zoneId ~= nil and not gameId(z.zoneId) then return "zoneId is not a valid id" end
  if not isName(z.name) then return "name is missing, blank or too long" end
  if not ZONE_KINDS[z.kind] then return "kind is not dungeon or raid" end
  if not whole(z.players, 1, 40) then return "players is not 1 to 40" end
  if z.instanceId ~= nil and not gameId(z.instanceId) then return "instanceId is not a valid id" end
  if z.difficultyId ~= nil and not whole(z.difficultyId, 1) then return "difficultyId is not a valid id" end
  if z.journalPartial ~= nil and z.journalPartial ~= true then return "journalPartial is not true" end
  if z.journalSkipped ~= nil and not whole(z.journalSkipped, 1) then return "journalSkipped is not a whole number from 1" end
  if not isList(z.sources) or #z.sources > Drops.MAX_SOURCES then return "sources is not a list of up to 100" end
  return nil
end

function Drops.check(model)
  local function refuse(detail)
    return { ok = false, code = "E_PAYLOAD", message = Envelope.message("E_PAYLOAD", detail) }
  end
  if type(model) ~= "table" then return refuse("not an object") end
  if model.schema ~= Drops.SCHEMA then return refuse("schema is not 1") end
  if not Ids.isId(model.id) then return refuse("id is missing or not valid") end
  if not whole(model.at, 0) then return refuse("at is missing") end
  if not isName(model.by) then return refuse("by is missing") end
  if model.journal ~= nil and not isName(model.journal) then return refuse("journal is not text") end
  if not isList(model.zones) or #model.zones < 1 or #model.zones > Drops.MAX_ZONES then return refuse("zones is not a list of 1 to 100") end
  local rowErrors, problems = {}, {}
  for zi, zone in ipairs(model.zones) do
    local why = zoneProblem(zone)
    if why then
      rowErrors[#rowErrors + 1] = "zone:" .. zi
      problems[#problems + 1] = { row = "zone:" .. zi, reason = why }
    else
      for si, source in ipairs(zone.sources) do
        local reason = sourceProblem(source)
        if reason then
          local row = "zone:" .. zi .. "/source:" .. si
          rowErrors[#rowErrors + 1] = row
          problems[#problems + 1] = { row = row, reason = reason }
        end
      end
    end
  end
  return { ok = true, rowErrors = rowErrors, problems = problems }
end
