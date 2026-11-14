-- Intrepid Manager: the drop log. Inside dungeons and raids it counts which creature or encounter dropped which items, so the
-- Raid Desk's drop lists can be filled from the game (docs/design/drop-list-import.md, section 2). Pure Lua: game/DropWatch.lua
-- reads the client and hands the facts in, so every rule here is tested without the game.
--
-- It keeps counts, not a history. Never kept: a player's name or GUID, a creature's GUID (only a short checksum of a corpse's,
-- to count each corpse once), chat text, master loot candidates, roll results or winners. Creature, item and zone names are
-- the game's.
--
--   local log = ns.DropLog.new(IntrepidManagerDB)            -- keeps its data in db.drops
--   log.encounterStart(zone, id, name); log.bossUnit(npcId, name); log.encounterEnd(zone, id, name, success, now)
--   log.unit(npcId, name, classification)                      -- a creature seen as the target or under the mouse
--   log.window(zone, window, now)                              -- the first LOOT_READY of a loot window
--   log.roll(zone, item, encounterId, now)                     -- a roll the game's loot history files under an encounter
--   log.settle(now)                                            -- file the corpses held for a roll that never came (as trash)
--   log.sourceOf(itemId)                                       -- "Boss, Zone" for an item a boss or a rare dropped here
--   log.zones()                                                -- the zones, newest first, as summaries
--
-- A zone fact: { instanceId, difficultyId, name, instanceType = "party" or "raid", maxPlayers, method }.
-- A window: { masterLooter = true?, threshold = 2, slots = { { itemId, name, quality, quest = true?, boe = true?, sources = { guid, ... } } } }.
--
-- How a corpse is told (section 2.2): only the first window of a corpse counts; a boss is a creature that was a boss unit of
-- an encounter won here; a guessed boss is the first corpse the master looter opens with loot at or above the threshold
-- within 5 minutes of a won encounter (it needs 2 kills, or the journal, to count as sure); a matched boss is a corpse within
-- those 5 minutes that holds an item the game's loot history filed under that win's rolls (any loot method: group loot has no
-- boss units here); a chest counts only for the master looter within those 5 minutes; a rare is a creature the game classed rare;
-- everything else is trash. A corpse that could still be matched (opened before its rolls were filed) is held for HOLD seconds.

local _, ns = ...

local DropLog = {}
ns.DropLog = DropLog

DropLog.SCHEMA = 1
DropLog.WINDOW = 300 -- seconds after a won encounter in which a chest or a guessed boss belongs to it
DropLog.MAX_CORPSES = 200
DropLog.MAX_ITEMS_PER_SOURCE = 80
DropLog.MAX_SOURCES_PER_ZONE = 100
DropLog.MAX_ZONES = 60
DropLog.MAX_ITEMS = 20000
DropLog.MAX_UNITS = 500
DropLog.FLOOR = { boss = 2, rare = 2, trash = 3 } -- the lowest quality kept: Uncommon from bosses and rares, Rare from trash
DropLog.CONFIRM_KILLS = 2
DropLog.BOSS_WIN_LIMIT = 3 * 3600 -- a known boss's corpse belongs to its encounter's last win here for this long; later it counts on its own
DropLog.HOLD = 15 -- seconds a corpse waits for the loot history to file its rolls (the watcher asks again 2 and 10 seconds after a roll)
DropLog.MAX_HELD = 20 -- corpses held at once; one more files the oldest
local MAX_ID = 100000000
local MAX_NAME = 100

local function gameId(value)
  return type(value) == "number" and value >= 1 and value <= MAX_ID and value == math.floor(value)
end
DropLog.gameId = gameId

-- A name the drops string can carry: text with something in it, cut to 100 bytes. Nil otherwise.
local function cleanName(value)
  if type(value) ~= "string" then return nil end
  local text = string.match(value, "^%s*(.-)%s*$")
  if text == "" then return nil end
  return string.sub(text, 1, MAX_NAME)
end
DropLog.cleanName = cleanName

-- "Creature-0-4170-34-7-12345-00002B3C1D" -> "Creature", 12345. The sixth field is the creature's (or the object's) id.
function DropLog.parseGuid(guid)
  if type(guid) ~= "string" then return nil end
  local fields = {}
  for field in string.gmatch(guid, "[^%-]+") do fields[#fields + 1] = field end
  local kind = fields[1]
  if not kind or not string.find(kind, "^%a+$") then return nil end
  return kind, tonumber(fields[6])
end

local CREATURES = { Creature = true, Vehicle = true }

-- The key of a zone: the instance and its difficulty.
function DropLog.zoneKey(zone)
  if type(zone) ~= "table" or not gameId(zone.instanceId) then return nil end
  local difficulty = type(zone.difficultyId) == "number" and zone.difficultyId or 0
  return string.format("%.0f:%.0f", zone.instanceId, difficulty)
end

function DropLog.new(db, options)
  options = options or {}
  local hash = options.hash or function(text) return ns.Crc32.hex(text) end
  local self = {}

  local function store()
    local data = db.drops
    if type(data) ~= "table" or data.schema ~= DropLog.SCHEMA then
      data = { schema = DropLog.SCHEMA, zones = {}, zoneCount = 0, itemCount = 0, corpses = {}, cursor = 0, stats = {} }
      db.drops = data
    end
    return data
  end

  -- The corpses waiting for their rolls, in the saved data so that a /reload does not lose one: { key, npcId, h, slots, at,
  -- killKey, encounterId } (no names: item ids and the game's item names only).
  local function heldList()
    local data = store()
    if type(data.held) ~= "table" then data.held = {} end
    return data.held
  end

  local function count(name, by)
    local stats = store().stats
    stats[name] = (stats[name] or 0) + (by or 1)
  end
  self.count = count

  -- In memory only: the creatures seen as target or under the mouse (name, classification), the encounter being fought, and the
  -- set of corpse checksums (rebuilt from the saved ring at the first window).
  local units, unitCount = {}, 0
  local fight
  local corpseSet
  local sourceCache = {} -- itemId -> "Boss, Zone" or false; emptied whenever the log changes

  ---------------------------------------------------------------------------------------------------------------
  -- Zones and sources
  ---------------------------------------------------------------------------------------------------------------

  local function dropZone(data, key)
    local zone = data.zones[key]
    if not zone then return end
    for _, source in pairs(zone.sources) do data.itemCount = data.itemCount - (source.count or 0) end
    data.zones[key] = nil
    data.zoneCount = data.zoneCount - 1
  end

  -- The zone of a zone fact, made when first needed. A full log drops the zone not seen for the longest time.
  local function zoneOf(fact, now)
    local key = DropLog.zoneKey(fact)
    if not key then return nil end
    local data = store()
    local zone = data.zones[key]
    if not zone then
      if data.zoneCount >= DropLog.MAX_ZONES then
        local oldestKey, oldest
        for otherKey, other in pairs(data.zones) do
          if not oldest or (other.last or 0) < (oldest.last or 0) then oldestKey, oldest = otherKey, other end
        end
        dropZone(data, oldestKey)
        count("zonesDropped")
      end
      zone = { instanceId = fact.instanceId, difficultyId = fact.difficultyId, first = now, sources = {}, count = 0, bosses = {}, guesses = {}, methods = {}, wins = {} }
      data.zones[key] = zone
      data.zoneCount = data.zoneCount + 1
    end
    zone.name = cleanName(fact.name) or zone.name or ("Instance " .. string.format("%.0f", fact.instanceId))
    zone.kind = fact.instanceType == "raid" and "raid" or "dungeon"
    if type(fact.maxPlayers) == "number" and fact.maxPlayers >= 1 and fact.maxPlayers <= 40 then zone.players = fact.maxPlayers end
    if fact.method ~= nil then zone.methods[tostring(fact.method)] = true end
    zone.wins = zone.wins or {}
    zone.last = now
    return zone, key
  end

  local function removeSource(zone, key)
    local source = zone.sources[key]
    if not source then return end
    store().itemCount = store().itemCount - (source.count or 0)
    zone.sources[key] = nil
    zone.count = zone.count - 1
  end

  -- A source of a zone by its key ("n12345" for a creature, "e678" for an encounter known only by its id), made when first
  -- needed. A full zone makes room for a boss or a rare by dropping the trash creature seen longest ago; trash waits.
  local function sourceOf(zone, key, make)
    local source = zone.sources[key]
    if source then return source end
    if zone.count >= DropLog.MAX_SOURCES_PER_ZONE then
      local victimKey, victim
      if make.kind ~= "trash" then
        for otherKey, other in pairs(zone.sources) do
          if other.kind == "trash" and (not victim or (other.last or 0) < (victim.last or 0)) then victimKey, victim = otherKey, other end
        end
      end
      if not victimKey then
        count("full")
        return nil
      end
      removeSource(zone, victimKey)
    end
    source = { npcId = make.npcId, encounterId = make.encounterId, name = make.name, kind = make.kind, guessed = make.guessed, kills = 0, items = {}, count = 0 }
    zone.sources[key] = source
    zone.count = zone.count + 1
    return source
  end

  -- One item seen under a source of the zone `zoneKey`, in one kill. The same item in the same kill (a window and a roll of one
  -- corpse, or a window opened twice) counts once.
  local function addItem(zoneKey, source, slot, killKey, via, now)
    local data = store()
    local item = source.items[slot.itemId]
    if not item then
      if source.count >= DropLog.MAX_ITEMS_PER_SOURCE then
        -- a full list keeps the items seen most: only an item seen once, in an earlier kill, makes room for a new one
        local leastId, least
        for id, other in pairs(source.items) do
          if not least or other.n < least.n or (other.n == least.n and (other.last or 0) < (least.last or 0)) then leastId, least = id, other end
        end
        if not least or least.n > 1 or least.k == killKey then
          count("itemsDropped")
          return
        end
        source.items[leastId] = nil
        source.count = source.count - 1
        data.itemCount = data.itemCount - 1
        count("itemsDropped")
      end
      -- a full log drops the zone not seen for the longest time (never the zone being added to)
      while data.itemCount >= DropLog.MAX_ITEMS do
        local oldestKey, oldest
        for otherKey, other in pairs(data.zones) do
          if otherKey ~= zoneKey and (not oldest or (other.last or 0) < (oldest.last or 0)) then oldestKey, oldest = otherKey, other end
        end
        if not oldestKey then
          count("full")
          return
        end
        dropZone(data, oldestKey)
        count("zonesDropped")
      end
      item = { n = 0 }
      source.items[slot.itemId] = item
      source.count = source.count + 1
      data.itemCount = data.itemCount + 1
    end
    if item.k ~= killKey then
      item.n = item.n + 1
      item.k = killKey
    end
    item.last = now
    item.name = cleanName(slot.name) or item.name
    if type(slot.quality) == "number" then item.quality = slot.quality end
    if slot.boe then item.boe = true end
    if slot.quest then item.quest = true end
    if via == "window" or not item.via then item.via = via end
    count("kept")
  end

  local function kill(source, killKey, now)
    if source.k ~= killKey then
      source.kills = source.kills + 1
      source.k = killKey
    end
    source.first = source.first or now
    source.last = now
  end

  local function killKeyOf(last)
    return "e" .. string.format("%.0f", last.id) .. "@" .. string.format("%.0f", last.at)
  end

  -- The last won encounter, when it was won in this zone less than WINDOW seconds ago.
  local function recent(key, now)
    local last = store().last
    if last and last.zone == key and type(last.at) == "number" and now - last.at >= 0 and now - last.at <= DropLog.WINDOW then return last end
    return nil
  end

  -- The name of a boss: the encounter's name when the encounter had one boss, else the unit's name.
  local function bossName(npcId, encounterId, last)
    local unitName = units[npcId] and units[npcId].name
    if last and last.id == encounterId then
      if #(last.npcs or {}) <= 1 and last.name then return last.name end
      if last.names and last.names[tostring(npcId)] then return last.names[tostring(npcId)] end
    end
    return unitName or (last and last.id == encounterId and last.name) or ("Creature " .. string.format("%.0f", npcId))
  end

  -- The creatures known as bosses of an encounter here: from the boss units of its last win and from earlier wins.
  local function bossesOf(zone, encounterId, last)
    local set, list = {}, {}
    local function add(id)
      if not set[id] then
        set[id] = true
        list[#list + 1] = id
      end
    end
    if last and last.id == encounterId then
      for _, id in ipairs(last.npcs or {}) do add(id) end
    end
    for id, owner in pairs(zone.bosses) do
      if owner == encounterId then add(id) end
    end
    table.sort(list)
    return list
  end

  -- A source known only by its encounter (from rolls or a chest) joins the boss creature of that encounter once it is known.
  local function joinEncounter(zone, encounterId, into)
    local key = "e" .. string.format("%.0f", encounterId)
    local loose = zone.sources[key]
    if not loose or loose == into then return end
    for id, item in pairs(loose.items) do
      local mine = into.items[id]
      if mine then
        -- (the larger count comes with the kill it last counted, so the same kill is not counted again)
        if item.n > mine.n then mine.n, mine.k = item.n, item.k end
        if (item.last or 0) > (mine.last or 0) then mine.last = item.last end
        if item.via == "window" then mine.via = "window" end
        if item.rk and (mine.rk == nil or (item.last or 0) >= (mine.last or 0)) then mine.rk = item.rk end
      elseif into.count < DropLog.MAX_ITEMS_PER_SOURCE then
        into.items[id] = item
        into.count = into.count + 1
        loose.items[id] = nil
        loose.count = loose.count - 1
      end
    end
    -- (the kill the loose source last counted is the boss's kill too, so carry its key: the same kill is not counted twice)
    if loose.kills > into.kills then into.kills, into.k = loose.kills, loose.k end
    if into.k == nil then into.k = loose.k end
    if loose.first and (not into.first or loose.first < into.first) then into.first = loose.first end
    removeSource(zone, key)
  end

  -- Was this creature a boss unit of the last win? (Then it is known for sure in this kill, whatever matched before.)
  local function unitOfLast(npcId, encounterId, last)
    if not (last and last.id == encounterId) then return false end
    for _, id in ipairs(last.npcs or {}) do
      if id == npcId then return true end
    end
    return false
  end

  -- A boss learned by a roll match takes from the encounter's loose source only what its own corpse held in this kill: the
  -- encounter may have more bosses, whose rolls are filed there too. Each item moves for this kill only (its count there goes
  -- down by one), and the window then counts it under the boss.
  local function claimLoose(zone, encounterId, slots, killKey)
    local key = "e" .. string.format("%.0f", encounterId)
    local loose = zone.sources[key]
    if not loose then return end
    local data = store()
    for _, slot in ipairs(slots or {}) do
      local item = gameId(slot.itemId) and loose.items[slot.itemId]
      if item and item.k == killKey then
        item.n, item.k = item.n - 1, nil
        if item.n <= 0 then
          loose.items[slot.itemId] = nil
          loose.count = loose.count - 1
          data.itemCount = data.itemCount - 1
        end
      end
    end
    if loose.count <= 0 then removeSource(zone, key) end
  end

  -- matched: the boss was learned by a roll match (now, or in an earlier kill); claim: { slots, killKey } of its corpse's window.
  local function bossSource(zone, npcId, encounterId, last, guessed, matched, claim)
    local source = sourceOf(zone, "n" .. string.format("%.0f", npcId), {
      npcId = npcId, encounterId = encounterId, name = bossName(npcId, encounterId, last), kind = "boss", guessed = guessed or nil,
    })
    if not source then return nil end
    source.kind, source.encounterId = "boss", encounterId
    if not guessed then source.guessed = nil end
    if matched then source.matched = true end
    if unitOfLast(npcId, encounterId, last) then source.matched = nil end
    if source.matched then
      if claim then claimLoose(zone, encounterId, claim.slots, claim.killKey) end
      return source
    end
    -- the encounter's loose items join this creature only when it is the encounter's one boss: with several, nobody knows
    -- whose they were, and they stay under the encounter (design 2.2, step 7)
    local bosses = bossesOf(zone, encounterId, last)
    if #bosses == 0 or (#bosses == 1 and bosses[1] == npcId) then joinEncounter(zone, encounterId, source) end
    return source
  end

  -- The source for something filed under an encounter: its boss creature when the zone knows it for sure (a boss unit, or a guess
  -- confirmed by kills), else the encounter itself. A boss known only by a roll match may share the encounter with bosses not
  -- matched yet, so a roll is not filed under it unless its corpse held the item in this kill (see self.roll).
  local function encounterSource(zone, last)
    local bosses = bossesOf(zone, last.id, last)
    if #bosses == 1 then
      local known = zone.sources["n" .. string.format("%.0f", bosses[1])]
      if not (known and known.matched and not unitOfLast(bosses[1], last.id, last)) then return bossSource(zone, bosses[1], last.id, last) end
    end
    return sourceOf(zone, "e" .. string.format("%.0f", last.id), { encounterId = last.id, name = cleanName(last.name) or ("Encounter " .. string.format("%.0f", last.id)), kind = "boss" })
  end

  ---------------------------------------------------------------------------------------------------------------
  -- Corpses: each counted once
  ---------------------------------------------------------------------------------------------------------------

  local function corpses()
    if not corpseSet then
      corpseSet = {}
      for _, h in ipairs(store().corpses) do corpseSet[h] = true end
    end
    return corpseSet
  end

  -- Whether a corpse was counted already, without counting it.
  local function counted(guid)
    return corpses()[hash(guid)] == true
  end

  local function seenCorpse(guid)
    local data = store()
    corpses()
    local h = hash(guid)
    if corpseSet[h] then return true, h end
    data.cursor = (data.cursor % DropLog.MAX_CORPSES) + 1
    local old = data.corpses[data.cursor]
    if old then corpseSet[old] = nil end
    data.corpses[data.cursor] = h
    corpseSet[h] = true
    return false, h
  end

  ---------------------------------------------------------------------------------------------------------------
  -- Facts
  ---------------------------------------------------------------------------------------------------------------

  function self.unit(npcId, name, classification)
    if not gameId(npcId) then return end
    local entry = units[npcId]
    if not entry then
      if unitCount >= DropLog.MAX_UNITS then units, unitCount = {}, 0 end
      entry = {}
      units[npcId] = entry
      unitCount = unitCount + 1
      count("unitsSeen")
    end
    entry.name = cleanName(name) or entry.name
    if type(classification) == "string" then entry.class = classification end
  end

  function self.encounterStart(zone, id, name)
    if not gameId(id) then return end
    fight = { id = id, name = cleanName(name), zone = DropLog.zoneKey(zone), npcs = {}, names = {} }
    count("encounters")
  end

  -- A boss unit read during the fight (boss1 to boss5).
  function self.bossUnit(npcId, name)
    if not fight or not gameId(npcId) then return end
    for _, id in ipairs(fight.npcs) do
      if id == npcId then return end
    end
    if #fight.npcs >= 5 then return end
    fight.npcs[#fight.npcs + 1] = npcId
    fight.names[tostring(npcId)] = cleanName(name)
    self.unit(npcId, name, nil)
  end

  function self.encounterEnd(zoneFact, id, name, success, now)
    if not gameId(id) then return end
    local current = fight
    fight = nil
    if not success then
      count("encountersLost")
      return
    end
    count("encountersWon")
    local zone, key = zoneOf(zoneFact, now)
    if not zone then return end
    local npcs, names = {}, {}
    if current and current.id == id then npcs, names = current.npcs, current.names end
    for _, npcId in ipairs(npcs) do zone.bosses[npcId] = id end
    zone.wins[string.format("%.0f", id)] = now
    store().last = { id = id, name = cleanName(name) or (current and current.name), at = now, zone = key, npcs = npcs, names = names }
  end

  local function qualityOf(slots)
    local best = -1
    for _, slot in ipairs(slots) do
      if type(slot.quality) == "number" and slot.quality > best then best = slot.quality end
    end
    return best
  end

  -- The kill a known boss's corpse belongs to: its encounter's last win here, when that was less than BOSS_WIN_LIMIT ago (the same
  -- key a roll of that kill got), else the corpse itself.
  local function bossKill(zone, encounterId, now, h)
    local at = zone.wins[string.format("%.0f", encounterId)]
    if type(at) == "number" and now - at >= 0 and now - at <= DropLog.BOSS_WIN_LIMIT then
      return "e" .. string.format("%.0f", encounterId) .. "@" .. string.format("%.0f", at), at
    end
    return "c" .. h, nil
  end

  -- The items the loot history filed under the rolls of one kill (its key "e<id>@<at>"), as a set, from the encounter's sources.
  local function rolledIn(zone, encounterId, killKey)
    local set, any = {}, false
    for _, source in pairs(zone.sources) do
      if source.encounterId == encounterId and source.kind == "boss" then
        for id, item in pairs(source.items) do
          if item.rk == killKey then
            set[id] = true
            any = true
          end
        end
      end
    end
    return any and set or nil
  end

  local function bestQuality(slots, floor)
    for _, slot in ipairs(slots) do
      if type(slot.quality) == "number" and slot.quality >= floor then return true end
    end
    return false
  end

  -- A creature that is no boss: a rare, or trash when it has something at the trash floor (or is kept already). Returns its source and
  -- floor, or nil when nothing of it is kept.
  local function creatureSource(zone, npcId, slots)
    local key2 = "n" .. string.format("%.0f", npcId)
    local known = zone.sources[key2]
    local unit = units[npcId]
    local rare = unit and (unit.class == "rare" or unit.class == "rareelite")
    local creatureKind = rare and "rare" or "trash"
    -- a creature the log already keeps as a boss or a rare stays one, whether or not its unit was seen this time
    if known and (known.kind == "boss" or known.kind == "rare") then creatureKind = known.kind end
    local floor = DropLog.FLOOR[creatureKind]
    -- trash is only kept when something of it is: a creature with nothing at the floor makes no entry
    if not (creatureKind ~= "trash" or known ~= nil or bestQuality(slots, floor)) then
      count("trashEmpty")
      return nil
    end
    local source = known or sourceOf(zone, key2, { npcId = npcId, name = cleanName(unit and unit.name) or ("Creature " .. string.format("%.0f", npcId)), kind = creatureKind })
    if source and rare and source.kind == "trash" then source.kind = "rare" end
    if source and unit and unit.name and string.find(source.name or "", "^Creature %d+$") then source.name = cleanName(unit.name) end
    return source, floor
  end

  local function fileSlots(key, source, slots, floor, killKey, now)
    for _, slot in ipairs(slots) do
      if type(slot.quality) == "number" and slot.quality >= floor then
        addItem(key, source, slot, killKey, "window", now)
      else
        count("belowFloor")
      end
    end
  end

  -- A held corpse is decided: the boss of its kill (a roll matched one of its items) or, when its time is up, a creature on its own.
  local function resolve(entry, asBoss)
    local zone = store().zones[entry.key]
    if not zone then return end
    sourceCache = {}
    if asBoss then
      zone.bosses[entry.npcId] = entry.encounterId
      local won = store().last
      local ofLast = won ~= nil and won.zone == entry.key and won.id == entry.encounterId and killKeyOf(won) == entry.killKey
      if ofLast then won.claimed = true end
      local source = bossSource(zone, entry.npcId, entry.encounterId, ofLast and won or nil, nil, true, { slots = entry.slots, killKey = entry.killKey })
      if not source then return end
      kill(source, entry.killKey, entry.at)
      fileSlots(entry.key, source, entry.slots, DropLog.FLOOR.boss, entry.killKey, entry.at)
      count("matched")
    else
      local source, floor = creatureSource(zone, entry.npcId, entry.slots)
      if not source then return end
      local killKey = "c" .. entry.h
      kill(source, killKey, entry.at)
      fileSlots(entry.key, source, entry.slots, floor, killKey, entry.at)
      count("heldTrash")
    end
  end

  -- File, as creatures on their own, the held corpses whose rolls did not come within HOLD seconds (all of them with `all`).
  function self.settle(now, all)
    local held = heldList()
    local i = 1
    while i <= #held do
      local entry = held[i]
      if all or type(now) ~= "number" or now - entry.at >= DropLog.HOLD or now < entry.at then
        table.remove(held, i)
        resolve(entry, false)
      else
        i = i + 1
      end
    end
  end

  function self.holding() return #heldList() end

  -- The first LOOT_READY of a loot window. Slots of several corpses (area loot) are told apart by their source.
  function self.window(zoneFact, window, now)
    self.settle(now)
    local zone, key = zoneOf(zoneFact, now)
    if not zone then return end
    sourceCache = {}
    count("windows")
    local groups, order = {}, {}
    local any = false
    for _, slot in ipairs(window.slots or {}) do
      if gameId(slot.itemId) then
        local sources = slot.sources or {}
        if #sources == 0 then count("noSource") end
        for _, guid in ipairs(sources) do
          if not groups[guid] then
            groups[guid] = {}
            order[#order + 1] = guid
          end
          local list = groups[guid]
          list[#list + 1] = slot
          any = true
        end
      end
    end
    if not any then return end
    local threshold = type(window.threshold) == "number" and window.threshold or 2
    local last = recent(key, now)

    -- First: a corpse holding an item the loot history filed under this win's rolls is the encounter's boss (sure: the game named
    -- the encounter, and the item was on this corpse). This works with any loot method.
    local matchedNow = {}
    if last then
      local rolled = rolledIn(zone, last.id, killKeyOf(last))
      if rolled then
        for _, guid in ipairs(order) do
          local kind, npcId = DropLog.parseGuid(guid)
          if CREATURES[kind] and gameId(npcId) and not zone.bosses[npcId] and not counted(guid) then
            local known = zone.sources["n" .. string.format("%.0f", npcId)]
            local unit = units[npcId]
            local rare = (known and known.kind == "rare") or (unit and (unit.class == "rare" or unit.class == "rareelite"))
            if not rare then
              for _, slot in ipairs(groups[guid]) do
                if rolled[slot.itemId] then
                  zone.bosses[npcId] = last.id
                  matchedNow[npcId] = true
                  count("matchedAtOnce")
                  break
                end
              end
            end
          end
        end
      end
    end

    -- Before any corpse is filed: a known boss of the recent win in this window claims the win (no guess beside it), and when
    -- the window could hold a guessed boss, it is the corpse with the best item, not the first in slot order.
    local guessGuid
    if last and not last.claimed then
      local best = -1
      for _, guid in ipairs(order) do
        local kind, npcId = DropLog.parseGuid(guid)
        if CREATURES[kind] and gameId(npcId) then
          local known = zone.sources["n" .. string.format("%.0f", npcId)]
          if zone.bosses[npcId] == last.id then
            last.claimed = true
          elseif not zone.bosses[npcId] and not (known and known.kind ~= "boss") and window.masterLooter and not counted(guid) then
            local quality = qualityOf(groups[guid])
            if quality >= threshold and quality > best then guessGuid, best = guid, quality end
          end
        end
      end
      if last.claimed then guessGuid = nil end
    end

    for _, guid in ipairs(order) do
      local slots = groups[guid]
      local kind, npcId = DropLog.parseGuid(guid)
      local repeated, h = seenCorpse(guid)
      if repeated then
        count("repeats")
      else
        count("corpses")
        local source, killKey, floor
        if kind == "GameObject" then
          if window.masterLooter and last then
            source, killKey, floor = encounterSource(zone, last), killKeyOf(last), DropLog.FLOOR.boss
            last.claimed = true -- the encounter's loot was in its chest: no corpse after it is its boss
            count("chests")
          else
            count("objectsIgnored")
          end
        elseif CREATURES[kind] and gameId(npcId) then
          local key2 = "n" .. string.format("%.0f", npcId)
          local encounterId = zone.bosses[npcId]
          local known = zone.sources[key2]
          if encounterId then
            local winAt
            killKey, winAt = bossKill(zone, encounterId, now, h)
            local won = store().last
            local ofLast = winAt ~= nil and won ~= nil and won.zone == key and won.id == encounterId and won.at == winAt
            if ofLast then won.claimed = true end
            source = bossSource(zone, npcId, encounterId, ofLast and won or nil, nil, matchedNow[npcId], { slots = slots, killKey = killKey })
            floor = DropLog.FLOOR.boss
          elseif guid == guessGuid then
            -- a guessed boss: one guess never decides; the same creature on CONFIRM_KILLS kills of the encounter does
            local guess = zone.guesses[npcId]
            if guess and guess.e == last.id and guess.k ~= killKeyOf(last) then
              guess.n, guess.k = guess.n + 1, killKeyOf(last)
            elseif not guess or guess.e ~= last.id then
              guess = { e = last.id, n = 1, k = killKeyOf(last) }
              zone.guesses[npcId] = guess
            end
            local sure = guess.n >= DropLog.CONFIRM_KILLS
            if sure then
              zone.bosses[npcId] = last.id
              count("confirmed")
            else
              count("guessed")
            end
            source = bossSource(zone, npcId, last.id, last, not sure)
            killKey, floor = killKeyOf(last), DropLog.FLOOR.boss
            last.claimed = true
          else
            local unit = units[npcId]
            local rare = unit and (unit.class == "rare" or unit.class == "rareelite")
            -- (a guessed boss is no sure boss: its corpse may still be matched to the rolls)
            local kept = known and (known.kind == "rare" or (known.kind == "boss" and not known.guessed))
            -- Without a master looter, a corpse opened within 5 minutes of a win with something a roll could be for may be the boss
            -- whose rolls the loot history has not filed yet: it waits for them (HOLD seconds), then counts as a creature.
            if last and not window.masterLooter and not rare and not kept and bestQuality(slots, math.max(threshold, DropLog.FLOOR.boss)) then
              local held = heldList()
              if #held >= DropLog.MAX_HELD then resolve(table.remove(held, 1), false) end
              local copy = {}
              for i, slot in ipairs(slots) do
                copy[i] = { itemId = slot.itemId, name = slot.name, quality = slot.quality, quest = slot.quest, boe = slot.boe }
              end
              held[#held + 1] = { key = key, npcId = npcId, h = h, slots = copy, at = now, killKey = killKeyOf(last), encounterId = last.id }
              count("held")
            else
              source, floor = creatureSource(zone, npcId, slots)
              killKey = "c" .. h
            end
          end
        else
          count("otherSources")
        end
        if source then
          kill(source, killKey, now)
          fileSlots(key, source, slots, floor, killKey, now)
        end
      end
    end
  end

  -- A roll the game's loot history puts under encounter `encounterId` (the watcher checked that). It is filed under the
  -- encounter's boss when the zone knows exactly one, else under the encounter.
  function self.roll(zoneFact, item, encounterId, now)
    count("rolls")
    self.settle(now)
    if type(item) ~= "table" or not gameId(item.itemId) then return end
    local zone, key = zoneOf(zoneFact, now)
    if not zone then return end
    sourceCache = {}
    local last = store().last
    if not (last and last.zone == key and last.id == encounterId) then
      count("rollsUnfiled")
      return
    end
    local killKey = killKeyOf(last)
    -- the boss whose corpse held this item in this kill (its window came first) takes the roll: the same drop counts once
    local source
    for _, other in pairs(zone.sources) do
      local seen = other.kind == "boss" and other.npcId and other.encounterId == last.id and other.items[item.itemId]
      if seen and seen.k == killKey then source = other end
    end
    source = source or encounterSource(zone, last)
    if not source then return end
    kill(source, killKey, now)
    if type(item.quality) == "number" and item.quality >= DropLog.FLOOR.boss then
      addItem(key, source, item, killKey, "roll", now)
      local filed = source.items[item.itemId]
      if filed then filed.rk = killKey end -- (the kill whose rolls had it: a corpse holding it is that kill's boss)
      count("rollsFiled")
    else
      count("belowFloor")
    end
    -- a held corpse with this item is the boss of this kill (its rolls came after its window)
    local held = heldList()
    local i = 1
    while i <= #held do
      local entry = held[i]
      local match = false
      if entry.key == key and entry.killKey == killKey then
        for _, slot in ipairs(entry.slots) do
          if slot.itemId == item.itemId then match = true end
        end
      end
      if match then
        table.remove(held, i)
        resolve(entry, true)
      else
        i = i + 1
      end
    end
  end

  ---------------------------------------------------------------------------------------------------------------
  -- Reading the log
  ---------------------------------------------------------------------------------------------------------------

  -- "Boss, Zone" for an item a boss or a rare dropped here, from the zone seen most recently first; nil otherwise. The answer is
  -- kept until the log changes: the loot master's window asks every second.
  function self.sourceOf(itemId)
    if not gameId(itemId) then return nil end
    local cached = sourceCache[itemId]
    if cached ~= nil then return cached or nil end
    local best, bestZone
    for _, zone in pairs(store().zones) do
      for _, source in pairs(zone.sources) do
        if (source.kind == "boss" or source.kind == "rare") and source.items[itemId] then
          if not bestZone or (zone.last or 0) > (bestZone.last or 0) then best, bestZone = source, zone end
        end
      end
    end
    local answer = best and (best.name .. ", " .. bestZone.name) or false
    sourceCache[itemId] = answer
    return answer or nil
  end

  -- The zones as summaries, the one seen last first: { key, name, kind, players, difficultyId, first, last, creatures, bosses, items }.
  function self.zones()
    local list = {}
    for key, zone in pairs(store().zones) do
      local bosses, items = 0, 0
      for _, source in pairs(zone.sources) do
        if source.kind == "boss" then bosses = bosses + 1 end
        items = items + (source.count or 0)
      end
      list[#list + 1] = {
        key = key, name = zone.name, kind = zone.kind, players = zone.players, difficultyId = zone.difficultyId,
        first = zone.first, last = zone.last, creatures = zone.count, bosses = bosses, items = items,
      }
    end
    table.sort(list, function(a, b)
      if (a.last or 0) ~= (b.last or 0) then return (a.last or 0) > (b.last or 0) end
      return a.key < b.key
    end)
    return list
  end

  function self.store() return store() end
  function self.last() return store().last end
  function self.fighting() return fight ~= nil end

  return self
end
