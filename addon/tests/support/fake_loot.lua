-- A stand-in for the master loot window of the client, for tests on a stand-in game (tests/support/strict_ui.lua). It gives the
-- game the loot functions the addon reads (GetNumLootItems, GetLootSlotType, GetLootSlotInfo, GetLootSlotLink,
-- GetMasterLootCandidate, GiveMasterLoot, GetLootThreshold, C_PartyInfo.GetLootMethod, UnitName, GetNumGroupMembers) and plays
-- the answers the probe saw on 2026-10-20: a give clears the slot after a short delay (LOOT_SLOT_CLEARED); when the receiver's bags
-- are full nothing happens at all on the loot master's client; a slot that is cleared stays in the numbering as an empty slot.
--
--   local loot = FakeLoot.install(game, { items = { { name = "Ruined Pelt", quality = 0, id = 7 } }, candidates = { "Jorren Ashvale", "Mirelle Dunmore" } })
--   loot.gives            -- the calls of GiveMasterLoot: { slot, index, name }
--   loot.close()          -- the window closes (LOOT_CLOSED); loot.open(items) opens a new one
--
-- An item may name the corpse it came from (`source`, a GUID, or a list of GUIDs for area loot; default options.source) and say it
-- starts a quest (`quest = true`): GetLootSourceInfo and GetLootSlotInfo's seventh answer give them, as the drop log reads them.
--
-- options: me (the name of the player, default the first candidate), candidates (names, in the game's order), items, money
-- (a money slot is added first), delay (seconds until a give clears the slot, default 0.2), keepOpen (the window stays open when the
-- last item is gone), full (set of names whose bags are full),
-- notMasterLooter (no candidates), raises (GiveMasterLoot raises this error), orders (per slot, candidates in another order).

local FakeLoot = {}

function FakeLoot.install(game, options)
  options = options or {}
  local env = game.env
  local loot = { gives = {}, full = options.full or {}, delay = options.delay or 0.2, threshold = options.threshold or 0, slots = {}, method = options.method or "master" }
  local candidates = options.candidates or { "Jorren Ashvale", "Mirelle Dunmore" }
  local me = options.me or candidates[1]

  local function itemLink(item)
    return "|cff9d9d9d|Hitem:" .. item.id .. "::::::::70:::::|h[" .. item.name .. "]|h|r"
  end

  function loot.open(items)
    loot.slots = {}
    if options.money then loot.slots[#loot.slots + 1] = { kind = "money" } end
    for _, item in ipairs(items or {}) do
      loot.slots[#loot.slots + 1] = { kind = "item", item = item, link = itemLink(item) }
    end
    loot.opened = true
  end

  function loot.close()
    loot.slots = {}
    loot.opened = false
    game.send("LOOT_CLOSED")
  end

  local function candidateNames(slot)
    if options.notMasterLooter then return {} end
    local order = options.orders and options.orders[slot]
    if order then return order end
    return candidates
  end

  env.GetNumLootItems = function() return #loot.slots end
  env.GetLootSlotType = function(slot)
    local entry = loot.slots[slot]
    if not entry or entry.cleared then return 0 end
    return entry.kind == "money" and 2 or 1
  end
  env.GetLootSlotInfo = function(slot)
    local entry = loot.slots[slot]
    if not entry or entry.cleared or entry.kind ~= "item" then return nil end
    return 134400 + slot, entry.item.name, entry.item.quantity or 1, nil, entry.item.quality, false, entry.item.quest == true
  end
  env.GetLootSourceInfo = function(slot)
    local entry = loot.slots[slot]
    if not entry or entry.cleared or entry.kind ~= "item" then return nil end
    local source = entry.item.source or options.source
    if type(source) == "table" then
      if #source == 2 then return source[1], 1, source[2], 1 end
      return source[1], 1
    end
    if source == nil then return nil end
    return source, 1
  end
  env.GetLootSlotLink = function(slot)
    local entry = loot.slots[slot]
    if not entry or entry.cleared or entry.kind ~= "item" then return nil end
    return entry.link
  end
  env.GetMasterLootCandidate = function(slot, index)
    return candidateNames(slot)[index]
  end
  env.GiveMasterLoot = function(slot, index)
    if options.raises then error(options.raises) end
    local name = candidateNames(slot)[index]
    loot.gives[#loot.gives + 1] = { slot = slot, index = index, name = name }
    if not name or loot.full[name] then return end
    env.C_Timer.After(loot.delay, function()
      local entry = loot.slots[slot]
      if not entry or entry.cleared then return end
      entry.cleared = true
      game.send("LOOT_SLOT_CLEARED", slot)
      -- the game closes the window by itself when the last item is gone
      local left = false
      for _, other in ipairs(loot.slots) do
        if other.kind == "item" and not other.cleared then left = true end
      end
      if not left and not options.keepOpen then
        env.C_Timer.After(0.05, function()
          if loot.opened then loot.close() end
        end)
      end
    end)
  end
  env.GetLootThreshold = function() return loot.threshold end
  env.C_PartyInfo = env.C_PartyInfo or {}
  env.C_PartyInfo.GetLootMethod = function() return loot.method, 0 end
  env.UnitName = function(unit)
    if unit == "player" then return (string.match(me, "^(%S+)")) end
  end
  env.GetNumGroupMembers = function() return #candidates end

  loot.open(options.items)
  return loot
end

return FakeLoot
