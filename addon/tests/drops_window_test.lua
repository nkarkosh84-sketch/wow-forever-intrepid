-- The drops window (IntrepidManager/ui/DropsWindow.lua) on the strict stand-in widgets. Invented names only.

local UI = dofile("tests/support/strict_ui.lua")
local StockTemplates = dofile("tests/support/stock_templates.lua")
local Intact = dofile("tests/support/intact.lua")

local FILES = { "ui/Kit", "ui/DropsWindow" }
local DROPS = "IM1:drops:j:52:{\"schema\":1,\"id\":\"d-tpt9k0-8vbn\",\"at\":1,\"by\":\"x\",\"zones\":[]}:00000000"

local function setup(options)
  options = options or {}
  local game = StockTemplates.install(UI.new({ setTextFires = options.setTextFires }))
  local ns = {}
  for _, file in ipairs(FILES) do game.load("IntrepidManager/" .. file .. ".lua", ns) end
  local scene = { game = game, ns = ns, calls = {}, errors = {} }
  scene.kit = ns.UI.Kit.new({
    density = options.density, chrome = options.chrome, onError = function(err) scene.errors[#scene.errors + 1] = tostring(err) end,
  })
  scene.window = ns.UI.DropsWindow.new(scene.kit, {
    journal = function(on) scene.calls[#scene.calls + 1] = { "journal", on } end,
    done = function() scene.calls[#scene.calls + 1] = { "done" } end,
  })
  scene.parts = scene.window.parts
  return scene
end

local function text(scene, widget) return scene.game.state(widget).text end
local function enabled(scene, widget) return scene.game.state(widget).enabled ~= false end
local function press(scene, widget) scene.game.fire(widget, "OnClick", "LeftButton") end

local function vm(change)
  local model = { text = DROPS, zones = 2, sources = 9, seen = 21, journal = 0, scope = "seen in the last 7 days", journalAvailable = true, includeJournal = false }
  for key, value in pairs(change or {}) do model[key] = value end
  return model
end

test("the sentence about the string: zones, creatures, items seen, and DungeonJournal's ids", function()
  local summary = setup().ns.UI.DropsWindow.summary
  eq((summary(vm())), "2 zones seen in the last 7 days: 9 creatures, 21 items seen in the game.")
  eq((summary(vm({ journal = 40, includeJournal = true }))), "2 zones seen in the last 7 days: 9 creatures, 21 items seen in the game, plus 40 from DungeonJournal.")
  eq((summary(vm({ zones = 1, sources = 1, seen = 1, scope = "picked" }))), "1 zone picked: 1 creature, 1 item seen in the game.")
  eq((summary(vm({ zones = 1, sources = 4, seen = 0, journal = 30, scope = "from DungeonJournal" }))), "1 zone from DungeonJournal: 4 creatures, plus 30 from DungeonJournal.")
  local words, any = summary(vm({ text = nil, zones = 0 }))
  eq(any, false)
  eq(words, "Nothing to export yet: the drop log records loot windows inside dungeons and raids.")
  eq((select(2, summary({}))), false)
end)

test("opened with a string: the sentence, the string ready to copy, its length, the notice, Select all on", function()
  local scene = setup()
  scene.window.open(vm({ notice = "The Raid Desk cannot import drops strings yet (LOOT-008): this one is for testing." }))
  eq(scene.window.isShown(), true)
  eq(text(scene, scene.parts.edit), DROPS)
  eq(text(scene, scene.parts.count), #DROPS .. " characters")
  is_true(string.find(text(scene, scene.parts.warning), "LOOT-008", 1, true) ~= nil)
  eq(enabled(scene, scene.parts.selectButton), true)
  eq(enabled(scene, scene.parts.journal), true)
end)

test("nothing to export: an empty box, Select all off; without DungeonJournal its box is off", function()
  local scene = setup()
  scene.window.open(vm({ text = nil, zones = 0, journalAvailable = false }))
  eq(text(scene, scene.parts.edit), "")
  eq(enabled(scene, scene.parts.selectButton), false)
  eq(enabled(scene, scene.parts.journal), false)
  eq(text(scene, scene.parts.warning), "")
end)

test("the journal box calls back with its state; Done closes the window and calls back", function()
  local scene = setup()
  scene.window.open(vm())
  scene.game.state(scene.parts.journal).checked = true
  press(scene, scene.parts.journal)
  deep_eq(scene.calls[1], { "journal", true })
  press(scene, scene.parts.doneButton)
  eq(scene.window.isShown(), false)
  deep_eq(scene.calls[2], { "done" })
end)

test("the box cannot be edited: typing puts the string back", function()
  for _, setTextFires in ipairs({ false, true }) do
    local scene = setup({ setTextFires = setTextFires })
    scene.window.open(vm())
    scene.game.state(scene.parts.edit).text = "typed over"
    scene.game.fire(scene.parts.edit, "OnTextChanged", true)
    eq(text(scene, scene.parts.edit), DROPS)
  end
end)

test("a callback that raises does not harm the window", function()
  local scene = setup()
  local bare = scene.ns.UI.DropsWindow.new(scene.kit, { journal = function() error("boom") end })
  bare.open(vm())
  press(scene, bare.parts.journal)
  eq(#scene.errors, 1)
  press(scene, bare.parts.doneButton)
  eq(bare.isShown(), false)
end)

test("nothing sticks out and no two controls overlap: compact, roomy, flat, in every state the window has", function()
  for _, options in ipairs({ {}, { density = "roomy" }, { chrome = "flat" }, { density = "roomy", chrome = "flat" } }) do
    local scene = setup(options)
    local function check(label)
      local problems = Intact.problems(scene.game, scene.window.window.frame)
      if #problems > 0 then
        error((options.density or "compact") .. " " .. (options.chrome or "stock") .. " " .. label .. ": " .. table.concat(problems, "; "))
      end
    end
    scene.window.open({})
    check("empty")
    scene.window.update(vm({ notice = "The Raid Desk cannot import drops strings yet (LOOT-008): this one is for testing." }))
    check("a string")
    scene.window.update(vm({ journal = 1234, includeJournal = true, zones = 12, sources = 345, seen = 6789 }))
    check("big numbers")
    scene.window.update(vm({ text = string.rep("x", 60000) }))
    check("a very long string")
  end
end)
