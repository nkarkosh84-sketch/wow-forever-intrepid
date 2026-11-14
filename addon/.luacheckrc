-- WoW: Forever runs Lua 5.1, but the client's Lua has no io, os, require, package, dofile, loadfile or debug library.
-- Addon code is checked against what the client really has, so code that only works on a desktop Lua fails here
-- (in CI) instead of in the game. The tests run on a desktop Lua and may use all of it.
stds.wow = {
  read_globals = {
    "assert", "collectgarbage", "coroutine", "error", "getmetatable", "ipairs", "math", "next", "pairs", "pcall",
    "rawequal", "rawget", "rawset", "select", "setmetatable", "string", "table", "tonumber", "tostring", "type",
    "unpack", "xpcall", "_G", "_VERSION",
  },
}
std = "wow"
max_line_length = false

exclude_files = {
  "IntrepidProbe/**", -- the research probe reads many client globals; not linted
}

-- Globals this addon defines.
globals = {
  "IntrepidManagerDB",
  "SlashCmdList",
  "SLASH_INTREPIDMANAGER1",
  "SLASH_INTREPIDMANAGER2",
}

-- Client globals this addon reads. Add each one here when code starts using it, and give it evidence in
-- tools/api-known.json (python3 tools/api_lint.py check says how).
read_globals = {
  "bit",
  "C_AddOns",
  "ForeverDungeonJournal_NS", -- the optional addon DungeonJournal (game/DungeonJournal.lua)
  "C_ChatInfo",
  "C_Container",
  "C_Item",
  "C_PartyInfo",
  "C_Timer",
  "C_TooltipInfo",
  "CreateFrame",
  "date",
  "debugprofilestop",
  "Enum",
  "GetAddOnMetadata",
  "GetBuildInfo",
  "GetLocale",
  "GetNumGroupMembers",
  "GetPhysicalScreenSize",
  "GetServerTime",
  "GetTime",
  "GetTimePreciseSec",
  "GameTooltip",
  "GetLootSlotInfo",
  "GetLootSlotLink",
  "GetLootSlotType",
  "GetLootThreshold",
  "GetMasterLootCandidate",
  "GetNumLootItems",
  "GiveMasterLoot",
  "InCombatLockdown",
  "IsEncounterInProgress",
  "IsInGroup",
  "IsInRaid",
  "issecretvalue",
  "print",
  "time",
  "UIParent",
  "UISpecialFrames",
  "UnitClass",
  "ERR_TRADE_COMPLETE",
  "ClearCursor",
  "ClickTradeButton",
  "GetCursorInfo",
  "GetTradePlayerItemLink",
  "GetUnitName",
  "InitiateTrade",
  "UnitExists",
  "UnitIsConnected",
  "UnitName",
  -- the drop log (game/DropWatch.lua)
  "C_LootHistory",
  "C_Spell",
  "GetInstanceInfo",
  "GetLootRollItemInfo",
  "GetLootRollItemLink",
  "GetLootSourceInfo",
  "GetSpellInfo",
  "IsInInstance",
  "UnitClassification",
  "UnitGUID",
}

-- Test files define their own helpers (see tests/run.lua).
files["tests/**"] = {
  std = "lua51",
  globals = { "SPEC", "test", "eq", "is_true", "deep_eq", "read_file", "apply_edit", "load_addon_file", "load_core" },
}
