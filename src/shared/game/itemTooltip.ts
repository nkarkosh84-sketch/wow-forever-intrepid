// Item tooltips from Wowhead's tooltip endpoint (see data/loot/README.md). The answer is JSON whose `tooltip` is HTML written by a
// third party, so the app never puts that HTML into the page. sanitizeTooltipHtml() reads it into a small tree of allowed elements
// and allowed class names, and the component renders the tree as ordinary React elements. Nothing else survives: no attribute but
// a class from the list below, no link, no image, no script, no event handler.
// This file has no imports so Node can run it directly in the unit tests.

export const itemTooltipUrl = (itemId: number) => `https://nether.wowhead.com/tooltip/item/${itemId}?dataEnv=16&locale=0`
export const itemIconUrl = (icon: string) => `https://wow.zamimg.com/images/wow/icons/medium/${icon}.jpg`

export type TooltipTag = 'table' | 'tbody' | 'tr' | 'td' | 'th' | 'b' | 'i' | 'span' | 'div' | 'br'
export type TooltipElement = { tag: TooltipTag; className?: string; wide?: boolean; children: TooltipNode[] }
export type TooltipNode = string | TooltipElement
export type ItemInfo = { name: string; quality: number; icon: string; tooltip: TooltipNode[] }

const keepTags = new Set<string>(['table', 'tr', 'td', 'th', 'b', 'i', 'span', 'div', 'br'])
const tablePart = (tag: string) => tag === 'table' || tag === 'tbody' || tag === 'tr'
// A tag that is not kept is dropped but its text stays, except for these, whose content is dropped with them.
const dropContentTags = new Set(['script', 'style', 'iframe', 'object', 'embed', 'noscript', 'template', 'svg', 'math', 'textarea', 'title', 'head', 'xmp', 'noembed', 'noframes', 'select', 'option', 'button', 'form'])
// The only class names that survive: quality colors (q, q0 to q9), money, and Wowhead's own tooltip extras. A third party must not be
// able to name a class that the app's own stylesheet uses.
const classPattern = /^(q[0-9]?|money(gold|silver|copper)|whtt-[a-z]+)$/

export const tooltipLimits = { length: 30000, nodes: 3000, depth: 10 }

const namedEntities: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: '\u00a0', ndash: '\u2013', mdash: '\u2014', hellip: '\u2026', bull: '\u2022', middot: '\u00b7' }
// Characters that are removed from any text: control characters (except tab and line feed), line and paragraph separators, and every
// "default ignorable" code point, which covers the characters that reorder or hide text (bidirectional marks, overrides and isolates,
// zero-width and word-joiner characters, the byte order mark, soft hyphen, variation selectors, tag characters) and a few that render
// as blanks.
const unwanted = /[\p{Cc}\p{Default_Ignorable_Code_Point}\u061c\u2028\u2029]/gu
const stripUnwanted = (text: string) => text.replace(unwanted, (character) => (character === '\t' || character === '\n' ? character : ''))

function decodeEntities(text: string) {
  return text.replace(/&(#x[0-9a-f]{1,6}|#[0-9]{1,7}|[a-z]{2,8});/gi, (whole, body: string) => {
    if (body[0] !== '#') return namedEntities[body.toLowerCase()] ?? whole
    const code = body[1] === 'x' || body[1] === 'X' ? parseInt(body.slice(2), 16) : parseInt(body.slice(1), 10)
    return code >= 0x20 && code <= 0x10ffff && !(code >= 0xd800 && code <= 0xdfff) ? String.fromCodePoint(code) : whole
  })
}

const cleanText = (text: string) => stripUnwanted(decodeEntities(text))

function readAttributes(attributes: string) {
  const found: Record<string, string> = {}
  for (const match of attributes.matchAll(/([a-zA-Z_:][-a-zA-Z0-9_:.]*)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+)))?/g)) {
    const name = match[1].toLowerCase()
    if (!(name in found)) found[name] = match[2] ?? match[3] ?? match[4] ?? ''
  }
  return found
}

// Reads tooltip HTML into allowed elements only. Never throws; bad or hostile input gives less output, not an error.
export function sanitizeTooltipHtml(html: string): TooltipNode[] {
  const source = html.length > tooltipLimits.length ? html.slice(0, tooltipLimits.length) : html
  const root: TooltipElement = { tag: 'div', children: [] }
  const stack: TooltipElement[] = [root]
  let nodes = 0
  const top = () => stack[stack.length - 1]
  const add = (node: TooltipNode) => { if (nodes < tooltipLimits.nodes) { top().children.push(node); nodes++ } }
  // A table, its body and its rows hold only the parts of a table. Text between them (the spaces and line breaks in the source) is
  // dropped, as a browser would ignore it; stray text there is dropped too, so the output never nests invalidly.
  const addText = (raw: string) => { const text = cleanText(raw); if (text && !tablePart(top().tag)) add(text) }
  const closeTo = (tag: string) => {
    for (let index = stack.length - 1; index > 0; index--) if (stack[index].tag === tag) { stack.length = index; return }
  }

  let position = 0
  while (position < source.length) {
    const next = source.indexOf('<', position)
    if (next === -1) { addText(source.slice(position)); break }
    if (next > position) addText(source.slice(position, next))
    position = next
    if (source.startsWith('<!--', position)) { const end = source.indexOf('-->', position + 4); position = end === -1 ? source.length : end + 3; continue }
    if (source[position + 1] === '!' || source[position + 1] === '?') { const end = source.indexOf('>', position); position = end === -1 ? source.length : end + 1; continue }
    const match = /^<(\/?)([A-Za-z][A-Za-z0-9]*)((?:"[^"]*"|'[^']*'|[^'">])*)>/.exec(source.slice(position, position + 2000))
    if (!match) { addText('<'); position++; continue }
    position += match[0].length
    const tag = match[2].toLowerCase()

    if (match[1] === '/') { if (keepTags.has(tag) && tag !== 'br') closeTo(tag); continue }
    if (dropContentTags.has(tag)) {
      const end = new RegExp(`</${tag}\\s*>`, 'i').exec(source.slice(position))
      position = end ? position + end.index + end[0].length : source.length
      continue
    }
    if (!keepTags.has(tag)) continue
    if (tag === 'br') { if (!tablePart(top().tag)) add({ tag: 'br', children: [] }); continue }
    if (stack.length > tooltipLimits.depth) continue

    if (tag === 'tr') {
      if (top().tag === 'td' || top().tag === 'th') stack.pop()
      if (top().tag === 'tr') stack.pop()
      if (top().tag === 'table') { const body: TooltipElement = { tag: 'tbody', children: [] }; add(body); stack.push(body) }
      if (top().tag !== 'tbody') continue
    } else if (tag === 'td' || tag === 'th') {
      if (top().tag === 'td' || top().tag === 'th') stack.pop()
      if (top().tag !== 'tr') continue
    }

    // Only rows may sit in a table or its body and only cells in a row: anything else there is dropped (its text moves up and is dropped).
    if (tablePart(top().tag) && tag !== 'tr' && tag !== 'td' && tag !== 'th') continue

    const attributes = readAttributes(match[3])
    const className = (attributes.class ?? '').split(/\s+/).filter((name) => classPattern.test(name)).slice(0, 4).join(' ')
    const element: TooltipElement = { tag: tag as TooltipTag, children: [] }
    if (className) element.className = className
    if (tag === 'table' && attributes.width?.trim() === '100%') element.wide = true
    add(element)
    stack.push(element)
  }
  return root.children
}

// Why looking an item up failed (shared/lib/itemInfo.ts asks the endpoint). Only 'missing' says Wowhead has no such item. The others are about the
// connection or the answer, so the item may well exist and asking again can find it: 'unreachable' (no answer), 'busy' (Wowhead asked to come back
// later) and 'refused' (an error answer, or one the app does not accept). The import of drop lists shows only 'missing' as an unknown item
// (docs/design/drop-list-import.md section 7).
export type ItemLookupReason = 'missing' | 'unreachable' | 'busy' | 'refused'
export type ItemLookupError = { reason: ItemLookupReason; message: string }
export const itemLookupErrors: Record<'missing' | 'unreachable' | 'busy' | 'tooLarge', ItemLookupError> = {
  missing: { reason: 'missing', message: 'Wowhead has no item with this id.' }, // also a good answer with no usable name (parseItemTooltip)
  unreachable: { reason: 'unreachable', message: 'Could not reach Wowhead.' },
  busy: { reason: 'busy', message: 'Wowhead is busy. Try again in a moment.' },
  tooLarge: { reason: 'refused', message: 'Wowhead sent an unexpected answer.' },
}

/** What an answer that is not a good one means, by its HTTP status: no such item (404), busy for now (429 and 5xx, worth asking again), or refused. */
export const itemLookupErrorOf = (status: number): ItemLookupError =>
  status === 404 ? itemLookupErrors.missing : status === 429 || status >= 500 ? itemLookupErrors.busy : { reason: 'refused', message: `Wowhead answered with an error (${status}).` }

// Reads the answer of the tooltip endpoint. Returns undefined when it has no usable name. Everything is checked: the answer comes
// from a third party.
export function parseItemTooltip(data: unknown): ItemInfo | undefined {
  if (typeof data !== 'object' || data === null) return undefined
  const record = data as Record<string, unknown>
  // Checked before any work is done on it: a hostile answer could carry a name of many megabytes.
  if (typeof record.name !== 'string' || record.name.length > 400) return undefined
  const name = cleanText(record.name).trim()
  if (!name || name.length > 120) return undefined
  const quality = typeof record.quality === 'number' && Number.isInteger(record.quality) && record.quality >= 0 && record.quality <= 5 ? record.quality : 1
  const icon = typeof record.icon === 'string' && /^[a-z0-9_]{1,80}$/i.test(record.icon) ? record.icon.toLowerCase() : ''
  const tooltip = typeof record.tooltip === 'string' ? sanitizeTooltipHtml(record.tooltip) : []
  return { name, quality, icon, tooltip }
}

// The slot an item goes in, as the tooltip words it. It sits alone in a table cell of the tooltip ("Finger", "Two-Hand", "Held In Off-hand"),
// next to the armor or weapon type. Items that go in no slot (bags, recipes, mounts, keys) have none, and give undefined.
export const slotLabels = [
  'Head', 'Neck', 'Shoulder', 'Back', 'Chest', 'Robe', 'Wrist', 'Hands', 'Waist', 'Legs', 'Feet', 'Finger', 'Trinket',
  'One-Hand', 'Main Hand', 'Two-Hand', 'Off Hand', 'Held In Off-hand', 'Ranged', 'Thrown', 'Relic',
]

export function itemSlotLabel(tooltip: TooltipNode[]): string | undefined {
  const known = new Map(slotLabels.map((label) => [label.toLowerCase(), label]))
  const textOf = (nodes: TooltipNode[]): string => nodes.map((node) => (typeof node === 'string' ? node : textOf(node.children))).join('')
  const find = (nodes: TooltipNode[]): string | undefined => {
    for (const node of nodes) {
      if (typeof node === 'string') continue
      if (node.tag === 'td') { const label = known.get(textOf(node.children).trim().toLowerCase()); if (label) return label }
      const inner = find(node.children)
      if (inner) return inner
    }
    return undefined
  }
  return find(tooltip)
}
