-- The drops window, in the states a loot master meets: nothing recorded yet, the zones of the last 7 days, DungeonJournal's lists
-- added, one dungeon from DungeonJournal alone, the same window roomy and with the flat frame. The window is the addon's real code
-- (IntrepidManager/ui/); the string is made by the real code from an invented drop log. Invented ids and names only.

local FILES = { "core/Crc32", "core/Json", "core/Envelope", "core/Ids", "core/DropLog", "core/Drops", "ui/Kit", "ui/DropsWindow" }

return function(story)
  story.describe("Drops window",
    "The drops string to copy for the Raid Desk's drop list import: which creatures dropped which items in the zones picked, "
    .. "never who looted them. A box adds DungeonJournal's lists when the player has that addon.")

  local NOTICE = "The Raid Desk cannot import drops strings yet (LOOT-008): this one is for testing."
  local T0 = 1796866200

  -- A window in a fresh game, open with the view-model `make(ns)` returns.
  local function open(options, make)
    local game = story.reset({})
    local ns = {}
    for _, file in ipairs(FILES) do game.load("IntrepidManager/" .. file .. ".lua", ns) end
    local kit = ns.UI.Kit.new({ density = options and options.density, chrome = options and options.chrome })
    local window = ns.UI.DropsWindow.new(kit, {})
    window.open(make and make(ns) or {})
    return window, game
  end

  -- An invented dungeon run: a boss, a rare and trash.
  local function sample(ns, journal)
    local db = {}
    local log = ns.DropLog.new(db)
    local zone = { instanceId = 9100, difficultyId = 1, name = "Hollow Test Keep", instanceType = "party", maxPlayers = 5 }
    local function corpse(npc) return "Creature-0-4170-389-12-" .. npc .. "-01" end
    log.encounterStart(zone, 3001, "The Fixture Warden")
    log.bossUnit(990011, "The Fixture Warden")
    log.encounterEnd(zone, 3001, "The Fixture Warden", true, T0)
    log.window(zone, { slots = {
      { itemId = 900101, name = "Fixture Robe", quality = 3, sources = { corpse(990011) } },
      { itemId = 900102, name = "Fixture Boots", quality = 2, sources = { corpse(990011) } },
    } }, T0 + 10)
    log.unit(990012, "Lord Lorem", "rare")
    log.window(zone, { slots = { { itemId = 900103, name = "Lorem Ring", quality = 2, sources = { corpse(990012) } } } }, T0 + 20)
    local options = { at = T0 + 3600, id = "d-tpt9k0-8vbn", version = "0.0.19", dateOf = function(t) return os.date("!%Y-%m-%d", t) end }
    if journal then
      options.journal = { version = "2.0.3", zoneFor = function()
        return { name = "Hollow Test Keep", sources = { { npcId = 990011, name = "The Fixture Warden", kind = "boss", itemIds = { 900101, 900105, 900106 } } } }
      end }
    end
    local model, counts = ns.Drops.build(db.drops, options)
    return {
      text = ns.Drops.encode(model), zones = counts.zones, sources = counts.sources, seen = counts.seen, journal = counts.journal,
      scope = "seen in the last 7 days", journalAvailable = true, includeJournal = journal == true, notice = NOTICE,
    }
  end

  open(nil, function() return { journalAvailable = false, notice = NOTICE } end)
  story.snap("Nothing recorded yet (and DungeonJournal not installed: its box is off)")

  local window, game = open(nil, function(ns) return sample(ns, false) end)
  game.fire(window.parts.scroll, "OnMouseDown", "LeftButton")
  story.snap("A dungeon run: the boss, the rare and their items; the string is ready to copy")

  open(nil, function(ns) return sample(ns, true) end)
  story.snap("DungeonJournal's lists added: the boss's other items as journal evidence")

  open({ density = "roomy" }, function(ns) return sample(ns, false) end)
  story.snap("The same window roomy")

  open({ chrome = "flat" }, function(ns) return sample(ns, false) end)
  story.snap("The same window with the flat frame")
end
