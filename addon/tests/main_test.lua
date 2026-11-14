-- The entry point (IntrepidManager/IntrepidManager.lua) with a stand-in for the game: /im, /im selftest and the
-- saved variables. Invented names only. See AGENTS.md.

local MODULES = { "Crc32", "Json", "Envelope", "Names", "Ids", "Check", "Night", "Marks", "Awards", "Council", "Version", "SelfTestSamples", "SelfTest", "DropLog", "Drops" }

-- Loads the entry point the way the client does, with its own global environment made of stand-ins.
-- `options` can set inCombat, noTimer, noBuildInfo and a stand-in `bit`.
local function newGame(options)
  options = options or {}
  local game = { printed = {}, handlers = {}, events = {} }
  local env = setmetatable({
    print = function(text) game.printed[#game.printed + 1] = text end,
    SlashCmdList = {},
    CreateFrame = function()
      return {
        RegisterEvent = function(_, event) game.events[event] = true end,
        SetScript = function(_, name, handler) game.handlers[name] = handler end,
      }
    end,
    C_AddOns = { GetAddOnMetadata = function(_, field) return field == "Version" and "9.9.9" or nil end },
    InCombatLockdown = function() return options.inCombat == true end,
    GetServerTime = function() return 1796866200 end,
    time = function() return 1796866201 end,
    bit = options.bit,
  }, { __index = _G })
  if not options.noTimer then env.debugprofilestop = function() return os.clock() * 1000 end end
  if not options.noBuildInfo then env.GetBuildInfo = function() return "1.60.1", "70425", "Oct 15 2026", 16001 end end

  local ns = load_core({}, unpack(MODULES))
  local chunk = assert(loadfile("IntrepidManager/IntrepidManager.lua"))
  setfenv(chunk, env)
  chunk("IntrepidManager", ns)
  game.env, game.ns = env, ns
  function game.say(input) env.SlashCmdList.INTREPIDMANAGER(input) end
  function game.output() return table.concat(game.printed, "\n") end
  function game.loaded() game.handlers.OnEvent(nil, "ADDON_LOADED", "IntrepidManager") end
  return game
end

test("the commands are registered", function()
  local game = newGame()
  eq(game.env.SLASH_INTREPIDMANAGER1, "/im")
  eq(game.env.SLASH_INTREPIDMANAGER2, "/intrepidmanager")
  is_true(game.events.ADDON_LOADED)
  is_true(type(game.env.SlashCmdList.INTREPIDMANAGER) == "function")
end)

test("loading sets up the saved variables and records the version", function()
  local game = newGame()
  game.loaded()
  eq(game.env.IntrepidManagerDB.schema, 1)
  eq(game.env.IntrepidManagerDB.addonVersion, "9.9.9")
  -- another addon loading changes nothing
  game.env.IntrepidManagerDB = nil
  game.handlers.OnEvent(nil, "ADDON_LOADED", "SomethingElse")
  eq(game.env.IntrepidManagerDB, nil)
end)

test("/im version and the help line", function()
  local game = newGame()
  game.say("version")
  is_true(game.output():find("version 9.9.9", 1, true) ~= nil)
  game.say("")
  game.say("  nonsense words ")
  is_true(game.output():find("/im selftest [label]", 1, true) ~= nil)
  game.say("VERSION")
  eq(select(2, game.output():gsub("version 9.9.9", "")), 4)
end)

test("/im selftest runs the checks, prints the summary and keeps the result", function()
  local game = newGame()
  game.loaded()
  game.say("selftest mac")
  local text = game.output()
  is_true(text:find("Self-test: ", 1, true) ~= nil)
  is_true(text:find(" 0 failed", 1, true) ~= nil)
  is_true(text:find("/reload", 1, true) ~= nil)
  is_true(text:find("Timer: debugprofilestop", 1, true) ~= nil)
  local db = game.env.IntrepidManagerDB
  eq(db.selftest.failed, 0)
  is_true(db.selftest.passed >= 25)
  eq(db.selftest.label, "mac")
  eq(db.selftest.version, "9.9.9")
  eq(db.selftest.ranAt, 1796866201)
  eq(db.selftest.serverTime, 1796866200)
  eq(db.selftest.client.build, "70425")
  eq(db.selftest.client.interface, 16001)
  eq(db.run.label, "mac")
  eq(db.addonVersion, "9.9.9")
  is_true(#db.selftest.timings.night == 3)
end)

test("the chat output has no pipe characters except the color codes in front", function()
  local game = newGame()
  game.say("selftest pc")
  for _, line in ipairs(game.printed) do
    local rest = line:gsub("^|cff66ccffIntrepid Manager:|r ", "")
    eq(rest:find("|", 1, true), nil)
  end
end)

test("the label is cleaned up, because it ends up in a folder name", function()
  local game = newGame()
  game.say("selftest   pc test #2 / extra!!  ")
  eq(game.env.IntrepidManagerDB.run.label, "pc_test_2_extra_")
  game.say("selftest " .. string.rep("x", 60))
  eq(#game.env.IntrepidManagerDB.run.label, 24)
  game.say("selftest")
  eq(game.env.IntrepidManagerDB.run, nil) -- no label: an old one must not stay
  eq(game.env.IntrepidManagerDB.selftest.label, nil)
end)

test("/im selftest does not run in combat", function()
  local game = newGame({ inCombat = true })
  game.say("selftest mac")
  is_true(game.output():find("Not in combat", 1, true) ~= nil)
  eq(game.env.IntrepidManagerDB, nil)
end)

test("/im selftest without a timer or build info still runs, and says nothing was timed", function()
  local game = newGame({ noTimer = true, noBuildInfo = true })
  game.say("selftest")
  is_true(game.output():find("nothing was timed", 1, true) ~= nil)
  eq(game.env.IntrepidManagerDB.selftest.failed, 0)
  eq(game.env.IntrepidManagerDB.selftest.client, nil)
  eq(#game.env.IntrepidManagerDB.selftest.timings.night, 0)
end)

test("/im selftest with a signed bit library reports it", function()
  local pureXor = load_core({}, "Crc32").Crc32.pureXor
  local signed = { bxor = function(a, b)
    local r = pureXor(a, b)
    if r >= 2147483648 then r = r - 4294967296 end
    return r
  end }
  local game = newGame({ bit = signed })
  game.say("selftest")
  is_true(game.output():find("bit.bxor answers are signed", 1, true) ~= nil)
  eq(game.env.IntrepidManagerDB.selftest.info.hasBxor, true)
  eq(game.env.IntrepidManagerDB.selftest.failed, 0)
end)

test("the help lines have no pipe characters either", function()
  local game = newGame()
  game.say("")
  for _, line in ipairs(game.printed) do
    eq((line:gsub("^|cff66ccffIntrepid Manager:|r ", "")):find("|", 1, true), nil)
  end
  is_true(game.output():find("/im window [session, import, export, icons, picker or confirm] [roomy] [flat], /im facts [label], /im inspect", 1, true) ~= nil)
end)

test("/im window hands the words to the demo windows, which are made once, with the saved variables and the chat", function()
  local game = newGame()
  local words, contexts = {}, {}
  game.ns.UI = {
    Demo = {
      new = function(context)
        contexts[#contexts + 1] = context
        return { open = function(argument) words[#words + 1] = argument end }
      end,
    },
  }
  game.say("window roomy flat")
  game.say("window")
  deep_eq(words, { "roomy flat", "" })
  eq(#contexts, 1)
  eq(contexts[1].db, game.env.IntrepidManagerDB)
  contexts[1].out("hello")
  is_true(game.output():find("|cff66ccffIntrepid Manager:|r hello", 1, true) ~= nil)
end)

test("/im facts opens the sample windows, measures, keeps the result in the saved variables and says what to do next", function()
  local game = newGame()
  local calls, result = {}, { notes = {} }
  local runOptions
  game.ns.UI = {
    Demo = {
      new = function()
        return {
          showAll = function() calls[#calls + 1] = "showAll" return { session = "a frame" } end,
          hideAll = function() calls[#calls + 1] = "hideAll" end,
        }
      end,
    },
    Facts = {
      run = function(options)
        calls[#calls + 1] = "run"
        runOptions = options
        return result
      end,
      summary = function() return { "line one", "line two" } end,
    },
  }
  game.say("facts beta 1")
  deep_eq(calls, { "showAll", "run" })
  eq(runOptions.windows.session, "a frame")
  eq(game.env.IntrepidManagerDB.facts, result)
  eq(result.version, "9.9.9")
  eq(result.label, "beta_1")
  eq(result.ranAt, 1796866201)
  eq(game.env.IntrepidManagerDB.run.label, "beta_1")
  is_true(game.output():find("Measuring the game's widgets", 1, true) ~= nil)
  eq(game.output():find("line one", 1, true), nil) -- nothing more until the measuring is done
  runOptions.done(result)
  deep_eq(calls, { "showAll", "run", "hideAll" })
  is_true(game.output():find("line one", 1, true) ~= nil)
  is_true(game.output():find("line two", 1, true) ~= nil)
  is_true(game.output():find("Type /reload to save the results to a file.", 1, true) ~= nil)
  game.say("facts")
  eq(game.env.IntrepidManagerDB.run, nil) -- no label: an old one must not stay
  eq(result.label, nil)
end)

test("/im facts does not run in combat", function()
  local game = newGame({ inCombat = true })
  game.ns.UI = { Demo = { new = function() error("not to be made") end }, Facts = {} }
  game.say("facts")
  is_true(game.output():find("Not in combat", 1, true) ~= nil)
  eq(game.env.IntrepidManagerDB, nil)
end)

test("an error inside a command is shown, not raised", function()
  local game = newGame()
  game.ns.SelfTest.run = function() error("boom from a stand-in") end
  game.say("selftest")
  is_true(game.output():find("error: ", 1, true) ~= nil)
  is_true(game.output():find("boom from a stand-in", 1, true) ~= nil)
end)

test("the tests load the modules in the order of the TOC", function()
  local toc = read_file("IntrepidManager/IntrepidManager.toc")
  local files = {}
  for name in toc:gmatch("core\\([%w]+)%.lua") do files[#files + 1] = name end
  deep_eq(files, MODULES)
end)
