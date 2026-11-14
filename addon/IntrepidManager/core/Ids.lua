-- Ids and revision numbers for the awards the addon makes (docs/spec/exchange-v0.md, sections 2 and 6.1).
-- Pure Lua: the clock and the random numbers come in as arguments, so the unit tests are exact.

local _, ns = ...

local Ids = {}
ns.Ids = Ids

local DIGITS = "0123456789abcdefghijklmnopqrstuvwxyz"
local MAX_INTEGER = 2 ^ 53

local function isWhole(value)
  return type(value) == "number" and value == value and value % 1 == 0 and value >= -MAX_INTEGER and value <= MAX_INTEGER
end

-- 1796866200 -> "tpt2u0". For whole numbers from 0 to 2^53.
function Ids.base36(number)
  if not isWhole(number) or number < 0 then
    error("base36 needs a whole number from 0 to 2^53, got " .. tostring(number), 2)
  end
  if number == 0 then return "0" end
  local digits = {}
  while number > 0 do
    local rest = number % 36
    digits[#digits + 1] = string.sub(DIGITS, rest + 1, rest + 1)
    number = (number - rest) / 36
  end
  return string.reverse(table.concat(digits)) -- the digits were collected from the last one
end

-- Four random base-36 characters: "q4tz". `random(36)` returns a whole number from 1 to 36, as math.random(36) does.
-- The addon makes one when it loads and uses it for every session of that load (spec 6.1, "Making ids"); an export
-- makes its own.
function Ids.randomPart(random)
  local characters = {}
  for index = 1, 4 do
    local pick = random(36)
    if not isWhole(pick) or pick < 1 or pick > 36 then
      error("the random function must give a whole number from 1 to 36, got " .. tostring(pick), 2)
    end
    characters[index] = string.sub(DIGITS, pick, pick)
  end
  return table.concat(characters)
end

local function checkPart(part)
  if type(part) ~= "string" or string.find(part, "^[0-9a-z][0-9a-z][0-9a-z][0-9a-z]$") == nil then
    error("the random part must be four characters from 0-9 and a-z, got " .. tostring(part), 3)
  end
end

-- A loot session: "s-", its start time in base 36, "-", the load's random part. "s-tpt2u0-q4tz".
function Ids.sessionId(startTime, part)
  checkPart(part)
  return "s-" .. Ids.base36(startTime) .. "-" .. part
end

-- Award number `n` (1, 2, ...) of a session: the session id, "-", the number. "s-tpt2u0-q4tz-1".
function Ids.awardId(sessionId, n)
  if type(sessionId) ~= "string" or not Ids.isId(sessionId) then error("not a session id: " .. tostring(sessionId), 2) end
  if not isWhole(n) or n < 1 then error("an award number is a whole number from 1, got " .. tostring(n), 2) end
  return sessionId .. "-" .. string.format("%.0f", n)
end

-- An export: "a-", its time in base 36, "-", four random characters. "a-tpt9k0-8vbn".
function Ids.exportId(time, random)
  return "a-" .. Ids.base36(time) .. "-" .. Ids.randomPart(random)
end

-- The id of a drops string: "d-tpt9k0-8vbn" (docs/design/drop-list-import.md, section 5).
function Ids.dropsId(time, random)
  return "d-" .. Ids.base36(time) .. "-" .. Ids.randomPart(random)
end

-- Whether `text` is an id of the spec: 1 to 64 characters from A-Z a-z 0-9 _ -.
function Ids.isId(text)
  return type(text) == "string" and #text >= 1 and #text <= 64 and string.find(text, "^[A-Za-z0-9_%-]+$") ~= nil
end

-- The revision for a change: max(previous + 1, server time now). `previous` is nil for a new award, which starts at
-- the server time. It rises with every change, also after a crash that lost the last write (the clock has moved on
-- since) and also when the clock is wrong (the previous revision wins).
function Ids.nextRev(previous, now)
  if not isWhole(now) or now < 1 then error("the server time must be a whole number from 1, got " .. tostring(now), 2) end
  if previous == nil then return now end
  if not isWhole(previous) or previous < 1 then error("a revision is a whole number from 1, got " .. tostring(previous), 2) end
  -- 2^53 + 1 is not a number a double can hold, so the largest revision is the end of the road
  if previous >= MAX_INTEGER then error("the revision cannot rise any further", 2) end
  return math.max(previous + 1, now)
end
