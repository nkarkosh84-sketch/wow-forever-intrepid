-- Intrepid Manager: the drops window (/im drops). Frames only: it shows the drops string it was given and calls the callbacks it was
-- given; the engine decides which zones the string holds (core/Drops.lua builds it from the drop log).
--
-- The loot master copies the string (the box takes the keyboard and selects everything when it is clicked, or Select all does it; the
-- box cannot be edited) for the Raid Desk's drop list import. The window says what the string holds, and a box adds DungeonJournal's
-- lists when the player has that addon.
--
-- The view-model (read only; the engine builds it):
--   vm = {
--     text        = "IM1:drops:j:...",   -- the drops string, or nil or "" when there is nothing to export
--     zones       = 2, sources = 9,       -- how many zones and creatures it holds
--     seen        = 21,                   -- items seen in the game
--     journal     = 40,                   -- item ids from DungeonJournal
--     scope       = "seen in the last 7 days",  -- which zones (for the sentence)
--     journalAvailable = true,            -- DungeonJournal is installed: the box can be ticked
--     includeJournal   = false,           -- the box "Add DungeonJournal's lists" is ticked
--     notice      = "...",                -- a line in the warning color, or nil
--   }
--
-- The callbacks (each in pcall):
--   journal(on)   the box was ticked or cleared: build the view-model again
--   done()        Done was pressed (the window has closed itself)
--
-- DropsWindow.summary(vm) is the sentence about the string, for the tests and the pictures.

local _, ns = ...

local DropsWindow = {}
ns.UI = ns.UI or {}
ns.UI.DropsWindow = DropsWindow

local NAME = "IntrepidManagerDrops"
local HELP = "Copy the drops string below for the Raid Desk's drop list import. It says which creatures dropped which items, never who looted them."
local HINT = "Click in the box and press Ctrl+C (Cmd+C on a Mac). Sending the same drops again is harmless: counts are never added twice. "
  .. "Type /im drops list to pick zones, /im drops all for every zone."
local EMPTY = "Nothing to export yet: the drop log records loot windows inside dungeons and raids."

local function number(n)
  return string.format("%.0f", n or 0)
end

local function plural(n, one, many)
  return number(n) .. " " .. (n == 1 and one or many)
end

-- The sentence about what the string holds, and whether there is anything: "2 zones seen in the last 7 days: 9 creatures, 21 items
-- seen in the game, plus 40 from DungeonJournal."
function DropsWindow.summary(vm)
  if not vm.text or vm.text == "" or (vm.zones or 0) == 0 then return EMPTY, false end
  local parts = { plural(vm.sources or 0, "creature", "creatures") }
  if (vm.seen or 0) > 0 then parts[#parts + 1] = plural(vm.seen, "item", "items") .. " seen in the game" end
  local sentence = plural(vm.zones, "zone", "zones") .. (vm.scope and (" " .. vm.scope) or "") .. ": " .. table.concat(parts, ", ")
  if (vm.journal or 0) > 0 then sentence = sentence .. ", plus " .. number(vm.journal) .. " from DungeonJournal" end
  return sentence .. ".", true
end

function DropsWindow.new(kit, callbacks)
  callbacks = callbacks or {}
  local m, colors = kit.m, kit.colors
  local self = {}

  local function call(name, ...)
    local callback = callbacks[name]
    if callback then return callback(...) end
  end

  -- the numbers everything else is placed by
  local pad, gap, header = m.pad, m.gap, m.header
  local width = m.windowWidth - 120
  local inner = width - 10 - pad * 2
  local boxHeight = m.row * 8
  local summaryTop = pad + 2 * header + gap
  local headTop = summaryTop + 2 * header + gap
  local boxTop = headTop + header
  local hintTop = boxTop + boxHeight + gap
  local warnTop = hintTop + 3 * header + gap
  local buttonsTop = warnTop + 2 * header + gap
  local height = buttonsTop + m.button + pad + 28

  local window = kit.window({ name = NAME, title = "Intrepid Manager - Export drops", width = width, height = height })
  local body = window.body

  local intro = kit.label(body, HELP, { wrap = true, width = inner })
  intro:SetPoint("TOPLEFT", pad, -pad)
  local summary = kit.label(body, "", { wrap = true, width = inner })
  summary:SetPoint("TOPLEFT", pad, -summaryTop)
  local heading = kit.label(body, "DROPS STRING", { font = "gold" })
  heading:SetPoint("TOPLEFT", pad, -headTop)
  local count = kit.label(body, "", { width = 160, justify = "RIGHT", color = colors.muted })
  count:SetPoint("TOPRIGHT", -pad, -headTop)

  local area = kit.textArea(body, inner, boxHeight)
  local scroll, edit = area.scroll, area.edit
  area.region:SetPoint("TOPLEFT", pad, -boxTop)

  local hint = kit.label(body, HINT, { wrap = true, width = inner, color = colors.muted })
  hint:SetPoint("TOPLEFT", pad, -hintTop)
  local warning = kit.label(body, "", { wrap = true, width = inner, color = colors.warn })
  warning:SetPoint("TOPLEFT", pad, -warnTop)

  local journal = kit.check(body, "Add DungeonJournal's lists")
  journal:SetPoint("TOPLEFT", pad, -buttonsTop)
  local doneButton = kit.button(body, "Done", { primary = true, width = 70 })
  doneButton:SetPoint("TOPRIGHT", -pad, -buttonsTop)
  local selectButton = kit.button(body, "Select all", { width = 90 })
  selectButton:SetPoint("TOPRIGHT", doneButton, "TOPLEFT", -gap, 0)

  local shown = "" -- the string in the box: the box is read only, whatever is typed is put back

  local function selectAll()
    edit:SetFocus()
    edit:HighlightText()
  end

  edit:SetScript("OnTextChanged", kit.safe(function(_, userInput)
    if userInput and edit:GetText() ~= shown then
      edit:SetText(shown)
      edit:HighlightText()
    end
  end))
  edit:SetScript("OnEditFocusGained", kit.safe(function() edit:HighlightText() end))
  area.scroll:SetScript("OnMouseDown", kit.safe(selectAll))
  selectButton:SetScript("OnClick", kit.safe(selectAll))
  doneButton:SetScript("OnClick", kit.safe(function()
    window.hide()
    call("done")
  end))
  journal:SetScript("OnClick", kit.safe(function(box) call("journal", box:GetChecked() == true) end))

  function self.update(vm)
    vm = vm or {}
    local sentence, any = DropsWindow.summary(vm)
    summary:SetText(sentence)
    local color = any and colors.good or colors.muted
    summary:SetTextColor(color[1], color[2], color[3])
    shown = any and vm.text or ""
    edit:SetText(shown)
    scroll:SetVerticalScroll(0)
    count:SetText(shown ~= "" and kit.characters(#shown) or "")
    journal:SetChecked(vm.includeJournal == true)
    if vm.journalAvailable then journal:Enable() else journal:Disable() end
    warning:SetText(vm.notice or "")
    if any then selectButton:Enable() else selectButton:Disable() end
  end

  -- Show the window with this view-model; the string is ready to copy.
  function self.open(vm)
    self.update(vm)
    window.show()
  end

  function self.show() window.show() end
  function self.hide() window.hide() end
  function self.toggle() window.toggle() end
  function self.isShown() return window.isShown() end
  self.window = window
  self.parts = {
    intro = intro, summary = summary, heading = heading, count = count, region = area.region, scroll = scroll, edit = edit,
    hint = hint, warning = warning, journal = journal, selectButton = selectButton, doneButton = doneButton,
  }

  self.update({})
  window.frame:Hide()
  return self
end
