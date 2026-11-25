// The night string's writer (ADDON-002, issue #193): a night model (docs/spec/exchange-v0.md section 5.1) to the one line the loot master pastes into the
// addon's import box. Section 1 is the envelope (IM1:night:j:<length>:<payload>:<crc>), section 3 the canonical JSON. The fixtures in
// docs/spec/fixtures/ are the authority, and the unit tests compare this writer's output with them byte for byte. Its one import, the CRC-32, has no runtime
// imports either, so Node runs the tests directly. copyForAddon.ts builds the model from the app's own data.

import { crc32 } from '../../shared/lib/exchangeString.ts'

export type NightRaid = { id: string; date: string; name?: string; size?: 10 | 20 | 40 }
export type NightKnown = { id: string; rev: number }
export type NightPlayer = { k: number; id: string; name: string; surname?: string; class?: string; role?: string; main?: number; locked?: true }
export type NightBoss = { npcId: number; name: string; zoneId?: number }
export type NightLine = { k: number; awarded?: true } | { name: string; awarded?: true } | { text: string; done?: true }
export type NightPriority = { id: string; item: string; itemId?: number; encounter?: string; npcId?: number; zoneId?: number; note?: string; lines: NightLine[] }
export type NightModel = {
  schema: 1
  id: string
  at: number
  by: string
  phase: number
  raid?: NightRaid
  known?: NightKnown[]
  roster: NightPlayer[]
  bosses?: NightBoss[]
  priorities: NightPriority[]
}

// The canonical field order of every object (the tables of section 5.1; addon/tools/exchange_fixtures.py has the same lists).
const NIGHT = ['schema', 'id', 'at', 'by', 'phase', 'raid', 'known', 'roster', 'bosses', 'priorities']
const RAID = ['id', 'date', 'name', 'size']
const KNOWN = ['id', 'rev']
const PLAYER = ['k', 'id', 'name', 'surname', 'class', 'role', 'main', 'locked']
const BOSS = ['npcId', 'name', 'zoneId']
const PRIORITY = ['id', 'item', 'itemId', 'encounter', 'npcId', 'zoneId', 'note', 'lines']
const LINE = ['k', 'name', 'text', 'awarded', 'done']

type Plain = { [key: string]: unknown }

// One object with its fields in canonical order. An absent value (undefined or null) and `false` are left out (section 3: producers never write null,
// and write a boolean only when it is true). A field the spec does not have is a programming error, as in the reference tool.
function ordered(value: object, fields: readonly string[], where: string): Plain {
  const source = value as Plain
  const unknown = Object.keys(source).filter((key) => !fields.includes(key))
  if (unknown.length > 0) throw new Error(`${where}: unknown fields ${unknown.join(', ')}`)
  const out: Plain = {}
  for (const key of fields) {
    const field = source[key]
    if (field === undefined || field === null || field === false) continue
    out[key] = field
  }
  return out
}

/** The model with every object's fields in canonical order. */
export function canonicalNight(model: NightModel): Plain {
  const out = ordered(model, NIGHT, 'night')
  if (model.raid) out.raid = ordered(model.raid, RAID, 'raid')
  if (model.known) out.known = model.known.map((entry, index) => ordered(entry, KNOWN, `known[${index}]`))
  out.roster = model.roster.map((player, index) => ordered(player, PLAYER, `roster[${index}]`))
  if (model.bosses) out.bosses = model.bosses.map((boss, index) => ordered(boss, BOSS, `bosses[${index}]`))
  out.priorities = model.priorities.map((priority, index) => ({
    ...ordered(priority, PRIORITY, `priorities[${index}]`),
    lines: priority.lines.map((line, at) => ordered(line, LINE, `priorities[${index}].lines[${at}]`)),
  }))
  return out
}

const LONE_SURROGATE = /[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/

// Integers only, and no text a reader must refuse as a whole: a lone surrogate is E_PAYLOAD (section 3), and neither Lua nor Firestore can store one.
function checkValues(value: unknown, where: string): void {
  if (typeof value === 'number') {
    if (!Number.isSafeInteger(value)) throw new Error(`${where}: ${value} is not an integer`)
  } else if (typeof value === 'string') {
    if (LONE_SURROGATE.test(value)) throw new Error(`${where}: a lone surrogate`)
  } else if (Array.isArray(value)) {
    value.forEach((item, index) => checkValues(item, `${where}[${index}]`))
  } else if (value !== null && typeof value === 'object') {
    for (const [key, item] of Object.entries(value)) checkValues(item, `${where}.${key}`)
  }
}

/**
 * Canonical JSON (section 3): no spaces, and ASCII only. JSON.stringify writes `"`, `\`, the short escapes (\b \f \n \r \t) and \u00xx for the other
 * control characters; then `|`, DEL and every non-ASCII character become \uxxxx in lowercase hex. Without the `u` flag, a character above U+FFFF matches
 * as its two halves, each escaped, which is the surrogate pair the spec asks for. `|` and DEL can only occur inside strings, so replacing them
 * everywhere is safe.
 */
export function canonicalJson(value: unknown): string {
  checkValues(value, 'night')
  return JSON.stringify(value).replace(/[\u007f-￿|]/g, (c) => '\\u' + c.charCodeAt(0).toString(16).padStart(4, '0'))
}

// The CRC-32 lives with the reader the importers share (shared/lib/exchangeString.ts); it is exported here too, as before.
export { crc32 }

/** The envelope around a payload (section 1): the checksum covers everything from the `I` of IM1 to the `:` before it. */
export function envelope(kind: 'night' | 'awards', payload: string): string {
  const head = `IM1:${kind}:j:${payload.length}:${payload}:`
  return head + crc32(head)
}

/** The night string for a model, exactly as the fixtures have it. Throws on a field the spec does not have, a number that is not an integer or a lone surrogate. */
export function encodeNight(model: NightModel): string {
  return envelope('night', canonicalJson(canonicalNight(model)))
}
