-- Intrepid Manager: the drop log's eyes in the game. It listens to the client's events, reads what they offer, and hands the facts
-- to core/DropLog.lua, which decides what to keep. It runs on every client with the addon, and only inside a dungeon or a raid.
--
-- Nothing here changes the game, sends a message or reads a player: it reads loot windows (the items and the corpse they came from),
-- the encounter events, the boss units during a fight, the creature under the mouse or targeted (its name and whether it is rare),
-- the item of a group roll, and the game's loot history (only which items it files under which encounter; never who rolled or won).
-- Every handler runs in pcall: an error is counted in IntrepidManagerDB.drops.stats and never reaches the player mid-raid.
--
-- The answers the probe has not confirmed on the live client are counted in stats too (boss units that are secret, loot windows
-- with no source, rolls the history could not file), so one dungeon run's saved file says what works.
--
--   local watch = ns.Game.DropWatch.new({ log = ns.DropLog.new(IntrepidManagerDB) })
--   watch.listen()     -- at ADDON_LOADED

local _, ns = ...

local DropWatch = {}
ns.Game = ns.Game or {}
ns.Game.DropWatch = DropWatch

local ITEM = 1 -- GetLootSlotType: an item
local BIND_ON_EQUIP = 2 -- the bindType that C_Item.GetItemInfo returns for an item that binds when equipped
local HISTORY_RETRIES = { 2, 10 } -- seconds after a roll starts to look in the loot history again
local MAX_CANDIDATE_CHECK = 40

-- Loot windows that are not drops: what the player skins, mines or gathers from a corpse or a node, or picks from a living
-- creature's pocket. On a client that never looted the corpse, skinning is the first window of it; pick-pocketing always comes
-- before the kill. A window within GATHER_SECONDS of the player's own cast of one of these spells (the US English names of the
-- game's spells) is left out, and its corpse is not marked as counted.
DropWatch.GATHER = { ["Skinning"] = true, ["Mining"] = true, ["Herb Gathering"] = true, ["Pick Pocket"] = true }
local GATHER_SECONDS = 3

-- context: log (core/DropLog), now (server time), clock (seconds, GetTime), after(seconds, fn) (C_Timer.After)
function DropWatch.new(context)
  local log = context.log
  local now = context.now or function() return GetServerTime() end
  local clock = context.clock or function() return GetTime() end
  local spellKinds = {} -- spell id -> true for a gathering spell, false otherwise (looked up once per spell)
  local lastGather -- the clock when the player last cast a gathering spell
  local after = context.after or function(seconds, fn) C_Timer.After(seconds, fn) end
  local self = {}
  local frame
  local count = log.count

  local function secret(value)
    if issecretvalue == nil then return false end
    local ok, answer = pcall(issecretvalue, value)
    return ok and answer == true
  end

  -- The dungeon or raid the player is in, as a zone fact; nil anywhere else.
  local function instance()
    local ok, inside, kind = pcall(IsInInstance)
    if not ok or not inside or (kind ~= "party" and kind ~= "raid") then return nil end
    local got, name, instanceType, difficultyId, _, maxPlayers, _, _, instanceId = pcall(GetInstanceInfo)
    if not got or type(instanceId) ~= "number" or secret(instanceId) then return nil end
    local fact = { name = name, instanceType = instanceType or kind, difficultyId = difficultyId, maxPlayers = maxPlayers, instanceId = instanceId }
    local methodOk, method = pcall(C_PartyInfo.GetLootMethod)
    if methodOk and method ~= nil and not secret(method) then fact.method = method end
    return fact
  end

  -- The creature of a unit ("boss1", "target"): its npc id and name, or nil (and why).
  local function creatureOf(unit)
    local ok, guid = pcall(UnitGUID, unit)
    if not ok or guid == nil then return nil, "none" end
    if secret(guid) then return nil, "secret" end
    local kind, npcId = ns.DropLog.parseGuid(guid)
    if kind ~= "Creature" and kind ~= "Vehicle" then return nil, "other" end
    local nameOk, name = pcall(UnitName, unit)
    if not nameOk or secret(name) then name = nil end
    return npcId, name
  end

  local function readBossUnits()
    for i = 1, 5 do
      local npcId, nameOrWhy = creatureOf("boss" .. i)
      if npcId then
        log.bossUnit(npcId, nameOrWhy)
        count("bossUnits")
      elseif nameOrWhy == "secret" then
        count("bossUnitsSecret")
      end
    end
  end

  local function itemIdOf(link)
    if type(link) ~= "string" or secret(link) then return nil end
    return tonumber(string.match(link, "item:(%d+)"))
  end

  local function bindsOnEquip(itemId)
    if not (C_Item and C_Item.GetItemInfo) then return nil end
    -- (the bind type is the 14th answer; nothing comes back while the game has not cached the item)
    local answers = { pcall(C_Item.GetItemInfo, itemId) }
    if answers[1] and answers[15] == BIND_ON_EQUIP then return true end
    return nil
  end

  -- The open loot window, as the drop log wants it: its item slots, each with the corpse or object it came from.
  local function readWindow()
    local okCount, slotCount = pcall(GetNumLootItems)
    if not okCount or type(slotCount) ~= "number" then return nil end
    local window = { slots = {} }
    local okThreshold, threshold = pcall(GetLootThreshold)
    if okThreshold and type(threshold) == "number" then window.threshold = threshold end
    for slot = 1, slotCount do
      local okType, slotType = pcall(GetLootSlotType, slot)
      if okType and slotType == ITEM then
        local okLink, link = pcall(GetLootSlotLink, slot)
        local itemId = okLink and itemIdOf(link) or nil
        local okInfo, _, name, _, _, quality, _, isQuest = pcall(GetLootSlotInfo, slot)
        if itemId and okInfo then
          local entry = { itemId = itemId, name = (not secret(name)) and name or nil, quality = quality, quest = isQuest == true or nil, sources = {} }
          if isQuest ~= nil and type(isQuest) ~= "boolean" then count("questNotBoolean") end
          entry.boe = bindsOnEquip(itemId)
          -- GetLootSourceInfo gives guid, count, guid, count ... (several corpses when loot is gathered from an area)
          local values = { pcall(GetLootSourceInfo, slot) }
          if values[1] then
            for index = 2, #values, 2 do
              if type(values[index]) == "string" and not secret(values[index]) then entry.sources[#entry.sources + 1] = values[index] end
            end
          end
          if not window.masterLooter then
            local okCandidate, candidate = pcall(GetMasterLootCandidate, slot, 1)
            if okCandidate and candidate ~= nil then window.masterLooter = true end
            if not window.masterLooter then
              -- the first candidate number can be empty while a later one is filled
              for index = 2, MAX_CANDIDATE_CHECK do
                local okLater, later = pcall(GetMasterLootCandidate, slot, index)
                if okLater and later ~= nil then
                  window.masterLooter = true
                  break
                end
              end
            end
          end
          window.slots[#window.slots + 1] = entry
        end
      end
    end
    return window
  end

  -- The item of a roll, when the loot history files it under the last encounter won here. The history may not have it the moment
  -- the roll starts, so it is asked again a little later.
  local function fileRoll(zone, item, attempt)
    local last = log.last()
    if not last or not (C_LootHistory and C_LootHistory.GetSortedDropsForEncounter) then
      count("rollsNoEncounter")
      return
    end
    local ok, drops = pcall(C_LootHistory.GetSortedDropsForEncounter, last.id)
    if ok and type(drops) == "table" then
      for _, drop in ipairs(drops) do
        if type(drop) == "table" and itemIdOf(drop.itemHyperlink) == item.itemId then
          log.roll(zone, item, last.id, now())
          return
        end
      end
    elseif not ok then
      count("historyErrors")
    end
    local wait = HISTORY_RETRIES[attempt]
    if wait then
      after(wait, function()
        local fine, problem = pcall(fileRoll, zone, item, attempt + 1)
        if not fine then
          count("errors")
          log.store().stats.lastError = string.sub(tostring(problem), 1, 120)
        end
      end)
    else
      count("rollsNotInHistory")
    end
  end

  local function spellName(spellId)
    if C_Spell and C_Spell.GetSpellName then
      local ok, name = pcall(C_Spell.GetSpellName, spellId)
      if ok and type(name) == "string" then return name end
    end
    if GetSpellInfo then
      local ok, name = pcall(GetSpellInfo, spellId)
      if ok and type(name) == "string" then return name end
    end
    return nil
  end

  local function inside()
    local ok, isInside, kind = pcall(IsInInstance)
    return ok and isInside and (kind == "party" or kind == "raid")
  end

  local function onEvent(event, ...)
    if event == "UNIT_SPELLCAST_SUCCEEDED" then
      -- (every spell the player casts: only a table lookup after the first time)
      local unit, _, spellId = ...
      if unit ~= "player" or type(spellId) ~= "number" or secret(spellId) then return end
      local gathering = spellKinds[spellId]
      if gathering == nil then
        gathering = DropWatch.GATHER[spellName(spellId) or ""] == true
        spellKinds[spellId] = gathering
      end
      if gathering then lastGather = clock() end
      return
    end
    if event == "PLAYER_TARGET_CHANGED" or event == "UPDATE_MOUSEOVER_UNIT" then
      -- (these fire all the time: only the cheap check here)
      if not inside() then return end
      local unit = event == "PLAYER_TARGET_CHANGED" and "target" or "mouseover"
      local npcId, name = creatureOf(unit)
      if name == "secret" then count("unitsSecret") end
      if npcId then
        local ok, classification = pcall(UnitClassification, unit)
        if ok and not secret(classification) then
          log.unit(npcId, name, classification)
          if classification == "rare" or classification == "rareelite" then count("raresSeen") end
        else
          log.unit(npcId, name, nil)
        end
      end
      return
    end
    if event == "PLAYER_ENTERING_WORLD" or event == "ZONE_CHANGED_NEW_AREA" then
      local zone = instance()
      if zone then
        count("zoneReads")
        if not zone.difficultyId or zone.difficultyId == 0 then count("zoneReadsNoDifficulty") end
      end
      return
    end
    local zone = instance()
    if not zone then return end
    if event == "LOOT_READY" then
      if lastGather and clock() - lastGather >= 0 and clock() - lastGather <= GATHER_SECONDS then
        -- skinned, mined, gathered or picked from a pocket: not a drop (the next window counts again)
        lastGather = nil
        count("gatherWindows")
        return
      end
      local window = readWindow()
      if window then
        log.window(zone, window, now())
        -- a corpse held for its rolls is filed on its own once its time is up, even when nothing else happens
        if log.holding() > 0 then
          after(ns.DropLog.HOLD + 1, function()
            local fine, problem = pcall(log.settle, now())
            if not fine then
              count("errors")
              log.store().stats.lastError = string.sub(tostring(problem), 1, 120)
            end
          end)
        end
      end
    elseif event == "ENCOUNTER_START" then
      local id, name = ...
      if not secret(id) then
        log.encounterStart(zone, id, (not secret(name)) and name or nil)
        readBossUnits()
      end
    elseif event == "INSTANCE_ENCOUNTER_ENGAGE_UNIT" then
      if log.fighting() then readBossUnits() end
    elseif event == "ENCOUNTER_END" then
      local id, name, _, _, success = ...
      if not secret(id) then log.encounterEnd(zone, id, (not secret(name)) and name or nil, success == 1 or success == true, now()) end
    elseif event == "START_LOOT_ROLL" then
      local rollId = ...
      local okLink, link = pcall(GetLootRollItemLink, rollId)
      local itemId = okLink and itemIdOf(link) or nil
      if not itemId then
        count("rollsUnread")
        return
      end
      local okInfo, _, name, _, quality = pcall(GetLootRollItemInfo, rollId)
      local item = { itemId = itemId, name = okInfo and not secret(name) and name or nil, quality = okInfo and quality or nil }
      item.boe = bindsOnEquip(itemId)
      count("rollsSeen")
      fileRoll(zone, item, 1)
    end
  end

  function self.listen()
    if frame then return end
    frame = CreateFrame("Frame")
    -- One at a time, so an event this client lacks stops only itself (written out, so tools/api_lint.py checks each name).
    local function try(register)
      if not pcall(register) then count("eventsRefused") end
    end
    try(function() frame:RegisterEvent("PLAYER_ENTERING_WORLD") end)
    try(function() frame:RegisterEvent("ZONE_CHANGED_NEW_AREA") end)
    try(function() frame:RegisterEvent("ENCOUNTER_START") end)
    try(function() frame:RegisterEvent("INSTANCE_ENCOUNTER_ENGAGE_UNIT") end)
    try(function() frame:RegisterEvent("ENCOUNTER_END") end)
    try(function() frame:RegisterEvent("LOOT_READY") end)
    try(function() frame:RegisterEvent("START_LOOT_ROLL") end)
    try(function() frame:RegisterEvent("PLAYER_TARGET_CHANGED") end)
    try(function() frame:RegisterEvent("UPDATE_MOUSEOVER_UNIT") end)
    try(function() frame:RegisterUnitEvent("UNIT_SPELLCAST_SUCCEEDED", "player") end)
    frame:SetScript("OnEvent", function(_, event, ...)
      -- Never let an error here reach the player mid-raid: keep it in the log's stats.
      local ok, problem = pcall(onEvent, event, ...)
      if not ok then
        count("errors")
        log.store().stats.lastError = string.sub(tostring(problem), 1, 120)
      end
    end)
  end

  self.onEvent = onEvent -- for the tests
  return self
end
