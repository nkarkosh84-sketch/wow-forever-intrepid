// The envelope of the exchange strings the addon and the Raid Desk pass by paste (docs/spec/exchange-v0.md sections 1 to 3): the CRC-32 that seals
// them and the reader the app's importers share. The night string's writer (features/loot/nightString.ts) uses the CRC from here; the drop list
// import (LOOT-008) reads drops strings with readEnvelopes, and the award import (LOOT-005) will read awards strings with it.
//
// The Python reference reader (addon/tools/exchange_fixtures.py) and the addon's Lua reader give the same answers on every case of
// docs/spec/fixtures/cases/: the unit tests run them all. A string is untrusted until its preview is confirmed: this only says whether it reads.
// No runtime imports, so Node runs its tests directly.

export type ExchangeKind = 'night' | 'awards' | 'drops'

/** The newest schema of each kind this version reads (section 9): a newer one is E_SCHEMA. */
export const EXCHANGE_SCHEMAS: Record<ExchangeKind, number> = { night: 1, awards: 1, drops: 1 }

export type ExchangeCode =
  | 'E_NOT_IM' | 'E_VERSION' | 'E_KIND' | 'E_ENCODING' | 'E_MALFORMED' | 'E_TRUNCATED' | 'E_CHARS' | 'E_CHECKSUM' | 'E_PAYLOAD' | 'E_SCHEMA' | 'E_MULTIPLE'

/** Why a pasted string doesn't read: one of section 1.1's codes, and the details its message adds. */
export class ExchangeReadError extends Error {
  readonly code: ExchangeCode
  readonly detail: string
  readonly found?: string // the kind found, for E_KIND
  constructor(code: ExchangeCode, detail = '', found?: string) {
    super(`${code}${detail ? ` ${detail}` : ''}`)
    this.code = code
    this.detail = detail
    if (found !== undefined) this.found = found
  }
}

let crcTable: Uint32Array | undefined
const table = () => {
  if (crcTable) return crcTable
  crcTable = new Uint32Array(256)
  for (let n = 0; n < 256; n++) {
    let c = n
    for (let bit = 0; bit < 8; bit++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    crcTable[n] = c >>> 0
  }
  return crcTable
}

/** CRC-32 (zlib, PNG) of the text's UTF-8 bytes, as 8 lowercase hex digits. An envelope is ASCII, so its bytes are its characters. */
export function crc32(text: string): string {
  const bytes = new TextEncoder().encode(text)
  const lookup = table()
  let c = 0xffffffff
  for (const byte of bytes) c = lookup[(c ^ byte) & 0xff]! ^ (c >>> 8)
  return ((c ^ 0xffffffff) >>> 0).toString(16).padStart(8, '0')
}

// ---- Reading (section 1.1)

/** What a string holds once it reads: its payload with section 3's reader rules applied, and the rows the content check rejected. */
export type ReadEnvelope = { kind: ExchangeKind; model: Record<string, unknown>; rowErrors: string[] }
/**
 * The content check of one kind (step 9): the row errors in the order met, or ExchangeReadError E_PAYLOAD for a broken top level. The importers pass their own;
 * without one, a string that passes steps 1 to 8 reads with no row errors.
 */
export type ContentCheck = (model: Record<string, unknown>) => string[]

const MAX_DEPTH = 16 // levels of lists and objects, the top-level object counting as the first (section 3)
const allowed = (code: number) => code >= 0x20 && code <= 0x7e && code !== 0x7c

/** Section 3's integers: whole numbers between -2^53 and 2^53 (so 2.0 is 2, and 2.5 is a wrong type). */
export const isExchangeInt = (value: unknown): value is number => typeof value === 'number' && Number.isInteger(value) && Math.abs(value) <= 2 ** 53

// A high surrogate not followed by a low one, or a low one not after a high one (a loop: lookbehind isn't in every browser the guild uses).
function hasLoneSurrogate(text: string): boolean {
  for (let index = 0; index < text.length; index++) {
    const code = text.charCodeAt(index)
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = text.charCodeAt(index + 1)
      if (!(next >= 0xdc00 && next <= 0xdfff)) return true
      index++
    } else if (code >= 0xdc00 && code <= 0xdfff) return true
  }
  return false
}

function depthOf(value: unknown): number {
  let deepest = 0
  const stack: [unknown, number][] = [[value, 1]]
  while (stack.length) {
    const [item, level] = stack.pop() as [unknown, number]
    if (item === null || typeof item !== 'object') continue
    deepest = Math.max(deepest, level)
    for (const child of Array.isArray(item) ? item : Object.values(item)) stack.push([child, level + 1])
  }
  return deepest
}

// Section 3's reader rules: null and false in a field are absent, null in a list is an error, a lone surrogate is an error. Integers need nothing
// here: JSON.parse already reads 2.0 and 2e0 as 2. Each field is defined, not assigned, so a "__proto__" key is an unknown field (as JSON.parse
// and the reference reader have it) and never sets the object's prototype.
function normalize(value: unknown): unknown {
  if (Array.isArray(value)) {
    if (value.some((entry) => entry === null)) throw new ExchangeReadError('E_PAYLOAD', 'null in a list')
    return value.map(normalize)
  }
  if (value !== null && typeof value === 'object') {
    const out: Record<string, unknown> = {}
    for (const [key, entry] of Object.entries(value)) {
      if (entry !== null && entry !== false) Object.defineProperty(out, key, { value: normalize(entry), enumerable: true, writable: true, configurable: true })
    }
    return out
  }
  if (typeof value === 'string' && hasLoneSurrogate(value)) throw new ExchangeReadError('E_PAYLOAD', 'lone surrogate')
  return value
}

function decodePayload(payload: string): Record<string, unknown> {
  let parsed: unknown
  try {
    parsed = JSON.parse(payload)
  } catch (error) {
    throw new ExchangeReadError('E_PAYLOAD', error instanceof Error ? error.message : 'not JSON')
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) throw new ExchangeReadError('E_PAYLOAD', 'not an object')
  if (depthOf(parsed) > MAX_DEPTH) throw new ExchangeReadError('E_PAYLOAD', 'nested too deeply')
  return normalize(parsed) as Record<string, unknown>
}

// Steps 1 and 2: the pasted text without CR, LF and tab, and where its first envelope starts.
function prepare(text: string): { data: string; start: number } {
  const data = text.replace(/[\r\n\t]/g, '')
  const start = data.indexOf('IM1:')
  if (start < 0) throw new ExchangeReadError(/IM[0-9]+:/.test(data) ? 'E_VERSION' : 'E_NOT_IM')
  return { data, start }
}

// Steps 3 to 9 for the envelope that starts at `start` (the I of IM1).
function readOne(data: string, start: number, box: ExchangeKind, check?: ContentCheck): ReadEnvelope & { end: number } {
  const parts: string[] = []
  let pos = start + 4
  for (let part = 0; part < 3; part++) {
    const end = data.indexOf(':', pos)
    if (end < 0) throw new ExchangeReadError('E_MALFORMED', 'header')
    parts.push(data.slice(pos, end))
    pos = end + 1
  }
  const [kind, encoding, length] = parts as [string, string, string]
  if (!/^(0|[1-9][0-9]*)$/.test(length)) throw new ExchangeReadError('E_MALFORMED', 'length')
  if (kind !== box) throw new ExchangeReadError('E_KIND', kind, kind)
  if (encoding !== 'j') throw new ExchangeReadError('E_ENCODING', encoding)
  const payloadEnd = pos + Number(length)
  const stop = payloadEnd + 9 // the payload, a ":" and 8 hex digits
  // Before the length is trusted: a pasted "smart" quote counts differently in Lua's bytes and JavaScript's units, but everything before it is ASCII,
  // so both readers stop at the same character.
  for (let index = start; index < Math.min(stop, data.length); index++) {
    if (!allowed(data.charCodeAt(index))) throw new ExchangeReadError('E_CHARS', `at character ${index - start + 1}`)
  }
  if (data.length < stop) throw new ExchangeReadError('E_TRUNCATED', `${data.length - start} of ${stop - start}`)
  const crc = data.slice(payloadEnd + 1, stop)
  if (data[payloadEnd] !== ':' || !/^[0-9a-f]{8}$/.test(crc)) throw new ExchangeReadError('E_MALFORMED', 'checksum')
  if (crc32(data.slice(start, payloadEnd + 1)) !== crc) throw new ExchangeReadError('E_CHECKSUM')
  const model = decodePayload(data.slice(pos, payloadEnd))
  const schema = model.schema
  if (!isExchangeInt(schema)) throw new ExchangeReadError('E_PAYLOAD', 'schema')
  if (schema < 1 || schema > EXCHANGE_SCHEMAS[box]) throw new ExchangeReadError('E_SCHEMA', String(schema))
  return { kind: box, model, rowErrors: check ? check(model) : [], end: stop }
}

/**
 * The app's importer (step 10): every envelope in the pasted text, in order, so two loot masters' strings pasted together both read. The whole paste
 * fails with the first error, whichever string it is in: a damaged paste is copied again, never half imported.
 */
export function readEnvelopes(text: string, box: ExchangeKind, check?: ContentCheck): ReadEnvelope[] {
  const { data, start } = prepare(text)
  const found: ReadEnvelope[] = []
  for (let at = start; at >= 0;) {
    const { end, ...envelope } = readOne(data, at, box, check)
    found.push(envelope)
    at = data.indexOf('IM1:', end)
  }
  return found
}

/** The addon's import box: exactly one envelope. Another "IM1:" after it is E_MULTIPLE, whatever follows, so a broken second string is never read. */
export function readSingleEnvelope(text: string, box: ExchangeKind, check?: ContentCheck): ReadEnvelope {
  const { data, start } = prepare(text)
  const { end, ...envelope } = readOne(data, start, box, check)
  if (data.indexOf('IM1:', end) >= 0) throw new ExchangeReadError('E_MULTIPLE')
  return envelope
}

// ---- The messages (section 1.1's table, the same on both sides)

const KIND_LABEL: Record<ExchangeKind, string> = { night: 'night', awards: 'awards', drops: 'drops' }
const WHERE_IT_GOES: Record<ExchangeKind, string> = {
  night: 'Paste night strings into the addon.',
  awards: 'Paste awards strings into the Raid Desk importer.',
  drops: "Paste drops strings into the Raid Desk's drop list import.",
}
const article = (word: string) => (/^[aeiou]/i.test(word) ? 'an' : 'a')
const isKind = (value: string | undefined): value is ExchangeKind => value === 'night' || value === 'awards' || value === 'drops'

/** What the person who pasted reads: the spec's message for the code, with its details in parentheses where the table has them. */
export function exchangeMessage(error: ExchangeReadError, box: ExchangeKind): string {
  switch (error.code) {
    case 'E_NOT_IM': return 'This is not an Intrepid Manager string.'
    case 'E_VERSION': return 'This string was made by a newer version. Update the addon (or reload the Raid Desk) and try again.'
    case 'E_KIND': {
      const found = error.found ?? error.detail
      const base = `This is ${article(found)} ${found} string; this box takes ${KIND_LABEL[box]} strings.`
      return isKind(found) ? `${base} ${WHERE_IT_GOES[found]}` : base
    }
    case 'E_ENCODING': return 'This string uses a format this version cannot read. Update the addon (or reload the Raid Desk).'
    case 'E_MALFORMED': return 'This string is damaged. Copy it again from the source.'
    case 'E_TRUNCATED': {
      const [got, expected] = error.detail.split(' of ')
      return `Only part of the string arrived (${got} of ${expected} characters). Copy it again, all of it.`
    }
    case 'E_CHARS': return 'The string contains characters it should not (often a word processor or chat app changed quotes). Copy it again from the source.'
    case 'E_CHECKSUM': return 'The string was changed after it was copied. Copy it again from the source.'
    case 'E_PAYLOAD': return `The string is complete but its contents cannot be read (${error.detail || 'unknown'}). Tell the addon maintainers.`
    case 'E_SCHEMA': return `This string uses schema ${error.detail}; this version reads up to ${EXCHANGE_SCHEMAS[box]}. Update the addon (or reload the Raid Desk).`
    case 'E_MULTIPLE': return 'More than one string was pasted. Paste one night string.'
  }
}
