-- The envelope around every exchange string:  IM1:<kind>:j:<length>:<payload>:<crc32>
-- Spec: docs/spec/exchange-v0.md, section 1. Pure Lua 5.1 with no client calls, so it runs in the unit tests.
--
-- Envelope.read(text, kind)     the addon's import box: exactly one string of `kind`.
-- Envelope.readAll(text, kind)  every string of `kind` in the text (the app's importer reads them all).
-- Envelope.write(kind, payload) wraps a payload (JSON text from Json.encode) in an envelope.
--
-- A read never raises for bad input. It returns
--   { ok = true, kind = ..., schema = n, model = <the decoded payload> }            (readAll: { ok = true, items = {...} })
--   { ok = false, code = "E_...", message = "text for the player" }
-- A bug in this code does not raise either: it comes back as E_PAYLOAD with `internal = true`, so the import box
-- shows an error and the tests can tell a bug from bad input.
--
-- This file checks the envelope and that the payload is a JSON object with a known schema. What is inside the
-- payload (rows, fields, limits) is checked by the code that knows the kind.

local _, ns = ...

local Envelope = {}
ns.Envelope = Envelope

local find, sub, gsub, format = string.find, string.sub, string.gsub, string.format

local Crc32 = ns.Crc32
local Json = ns.Json

-- The newest schema this version reads, per kind. A kind that is not listed is not one of ours.
Envelope.SCHEMAS = { night = 1, awards = 1, drops = 1 }

-- A number as text, without "%d" (which passes through a C long, 32 bits on Windows).
local function number(n)
  return format("%.0f", n)
end

-- Text that came from a pasted string, made safe to show: it is cut short and anything but letters, digits and a
-- few marks becomes "?" (so a pasted "|" can never start an escape code in the game's text).
local function shown(text, limit)
  return (gsub(sub(tostring(text), 1, limit or 24), "[^%w%-_ .:/]", "?"))
end

local function article(word)
  return find(word, "^[aeiouAEIOU]") and "an" or "a"
end

-- Where each kind of string belongs, to tell someone who pasted it in the wrong place.
local HOME = {
  night = "Paste night strings into the addon.",
  awards = "Paste awards strings into the Raid Desk importer.",
  drops = "Paste drops strings into the Raid Desk's drop list import.",
}

-- The messages of the spec (section 1.1), one function per code. They get the details given to `problem`.
local MESSAGES = {
  E_NOT_IM = function()
    return "This is not an Intrepid Manager string."
  end,
  E_VERSION = function()
    return "This string was made by a newer version. Update the addon (or reload the Raid Desk) and try again."
  end,
  E_KIND = function(found, expected)
    local home = HOME[found] and (" " .. HOME[found]) or ""
    return format("This is %s %s string; this box takes %s strings.%s", article(found), shown(found), shown(expected), home)
  end,
  E_ENCODING = function(found)
    return format("This string uses a format this version cannot read (%s). Update the addon (or reload the Raid Desk).", shown(found))
  end,
  E_MALFORMED = function(what)
    return format("This string is damaged (%s). Copy it again from the source.", what)
  end,
  E_TRUNCATED = function(got, expected)
    return format("Only part of the string arrived (%s of %s characters). Copy it again, all of it.", number(got), number(expected))
  end,
  E_CHARS = function(position)
    return format("The string contains characters it should not (character %s; often a word processor or chat app changed quotes). Copy it again from the source.", number(position))
  end,
  E_CHECKSUM = function()
    return "The string was changed after it was copied. Copy it again from the source."
  end,
  E_PAYLOAD = function(detail)
    return format("The string is complete but its contents cannot be read (%s). Tell the addon maintainers.", detail)
  end,
  E_SCHEMA = function(found, supported)
    return format("This string uses schema %s; this version reads up to %s. Update the addon (or reload the Raid Desk).", number(found), number(supported))
  end,
  E_MULTIPLE = function(kind)
    return format("More than one string was pasted. Paste one %s string.", shown(kind))
  end,
}

-- Every error code, for the tests.
Envelope.CODES = {}
for code in pairs(MESSAGES) do Envelope.CODES[#Envelope.CODES + 1] = code end
table.sort(Envelope.CODES)

-- The text for a player for `code`, with the details that code takes. The content checks (Night, Awards) use it for
-- E_PAYLOAD, so every refusal reads the same.
function Envelope.message(code, ...)
  local make = MESSAGES[code]
  if not make then error("unknown code: " .. tostring(code), 2) end
  return make(...)
end

-- Errors for bad input carry this metatable, so a bug is never mistaken for bad input.
local PROBLEM = {}

local function problem(code, ...)
  error(setmetatable({ code = code, args = { ... } }, PROBLEM), 0)
end

local function guarded(fn)
  local ok, result = pcall(fn)
  if ok then return result end
  if type(result) == "table" and getmetatable(result) == PROBLEM then
    return { ok = false, code = result.code, message = MESSAGES[result.code](unpack(result.args)) }
  end
  return { ok = false, code = "E_PAYLOAD", internal = true, message = MESSAGES.E_PAYLOAD("internal error: " .. shown(result, 160)) }
end

-- Step 1 and 2 of the spec: take out CR, LF and tab, and find the first "IM1:".
local function prepare(text)
  if type(text) ~= "string" then problem("E_NOT_IM") end
  local data = gsub(text, "[\r\n\t]", "")
  local start = find(data, "IM1:", 1, true)
  if not start then
    problem(find(data, "IM%d+:") and "E_VERSION" or "E_NOT_IM")
  end
  return data, start
end

-- Steps 3 to 8: the envelope that starts at `start` (the I of IM1). Returns the model and where to look for the next.
local function readOne(data, start, kind)
  local pos = start + 4
  local header = {}
  for i = 1, 3 do
    local colon = find(data, ":", pos, true)
    if not colon then problem("E_MALFORMED", "the header ends too soon") end
    header[i] = sub(data, pos, colon - 1)
    pos = colon + 1
  end
  local foundKind, encoding, length = header[1], header[2], header[3]
  if not (length == "0" or find(length, "^[1-9]%d*$")) then problem("E_MALFORMED", "the length is not a number") end
  if foundKind ~= kind then problem("E_KIND", foundKind, kind) end
  if encoding ~= "j" then problem("E_ENCODING", encoding) end

  -- The envelope ends 9 characters after the payload: ":" and 8 hex digits. Check the characters first: Lua
  -- counts bytes and JavaScript counts UTF-16 units, so the length is trusted only after everything before it is ASCII.
  local count = tonumber(length)
  local payloadEnd = pos + count - 1
  local last = payloadEnd + 9
  local bad = find(sub(data, start, math.min(last, #data)), "[^ -{}~]")
  if bad then problem("E_CHARS", bad) end
  if #data < last then problem("E_TRUNCATED", #data - start + 1, last - start + 1) end
  local checksum = sub(data, payloadEnd + 2, last)
  if sub(data, payloadEnd + 1, payloadEnd + 1) ~= ":" or not find(checksum, "^[0-9a-f]+$") then
    problem("E_MALFORMED", "the checksum is missing")
  end
  if Crc32.hex(sub(data, start, payloadEnd + 1)) ~= checksum then problem("E_CHECKSUM") end

  local ok, model = Json.decode(sub(data, pos, payloadEnd))
  if not ok then problem("E_PAYLOAD", model) end
  if type(model) ~= "table" or Json.isList(model) then problem("E_PAYLOAD", "the payload is not an object") end
  if not Json.isInteger(model.schema) then problem("E_PAYLOAD", "schema is missing or not a whole number") end
  local supported = Envelope.SCHEMAS[kind]
  if model.schema < 1 or model.schema > supported then problem("E_SCHEMA", model.schema, supported) end
  return model, last + 1
end

local function checkKind(kind)
  if not Envelope.SCHEMAS[kind] then error("unknown kind of string: " .. tostring(kind), 3) end
end

-- The addon's import box takes exactly one string. Another "IM1:" after the first envelope is E_MULTIPLE, whatever
-- follows it; a broken second string is not looked at.
function Envelope.read(text, kind)
  checkKind(kind)
  return guarded(function()
    local data, start = prepare(text)
    local model, nextStart = readOne(data, start, kind)
    if find(data, "IM1:", nextStart, true) then problem("E_MULTIPLE", kind) end
    return { ok = true, kind = kind, schema = model.schema, model = model }
  end)
end

-- Every string in the text, in order. The first error, in whichever string, is the answer.
function Envelope.readAll(text, kind)
  checkKind(kind)
  return guarded(function()
    local data, start = prepare(text)
    local items = {}
    while start do
      local model, nextStart = readOne(data, start, kind)
      items[#items + 1] = { kind = kind, schema = model.schema, model = model }
      start = find(data, "IM1:", nextStart, true)
    end
    return { ok = true, items = items }
  end)
end

-- Wraps JSON text in an envelope. The payload must already be printable ASCII without "|" (Json.encode writes it
-- that way); anything else is a bug in the caller.
function Envelope.write(kind, payload)
  checkKind(kind)
  if type(payload) ~= "string" or find(payload, "[^ -{}~]") then
    error("the payload must be printable ASCII without | (write it with Json.encode)", 2)
  end
  local head = "IM1:" .. kind .. ":j:" .. number(#payload) .. ":" .. payload .. ":"
  return head .. Crc32.hex(head)
end
