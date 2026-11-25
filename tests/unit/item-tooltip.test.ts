import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { itemIconUrl, itemLookupErrorOf, itemLookupErrors, itemSlotLabel, itemTooltipUrl, parseItemTooltip, sanitizeTooltipHtml, slotLabels, tooltipLimits, type TooltipElement, type TooltipNode } from '../../src/shared/game/itemTooltip.ts'

const allowedTags = new Set(['table', 'tbody', 'tr', 'td', 'th', 'b', 'i', 'span', 'div', 'br'])
const allowedClass = /^(q[0-9]?|money(gold|silver|copper)|whtt-[a-z]+)$/
const walk = (nodes: TooltipNode[], visit: (element: TooltipElement, depth: number) => void, depth = 1) => {
  for (const node of nodes) if (typeof node !== 'string') { visit(node, depth); walk(node.children, visit, depth + 1) }
}
const textOf = (nodes: TooltipNode[]): string => nodes.map((node) => (typeof node === 'string' ? node : textOf(node.children))).join('')
// What a hostile or broken answer must never produce, whatever the input: anything but allowed tags, allowed class names and the
// two fields the component reads.
// Table parts nest as HTML requires (React warns about anything else): a table holds only a body, a body only rows, a row only cells.
const allowedInside: Record<string, string[]> = { table: ['tbody'], tbody: ['tr'], tr: ['td', 'th'] }
const assertSafe = (nodes: TooltipNode[]) => walk(nodes, (element) => {
  assert.ok(allowedTags.has(element.tag), `tag ${element.tag}`)
  const allowedChildren = allowedInside[element.tag]
  if (allowedChildren) for (const child of element.children) assert.ok(typeof child !== 'string' && allowedChildren.includes(child.tag), `${element.tag} holds ${typeof child === 'string' ? 'text' : child.tag}`)
  assert.deepEqual(Object.keys(element).filter((key) => !['tag', 'className', 'wide', 'children'].includes(key)), [])
  for (const name of (element.className ?? '').split(' ').filter(Boolean)) assert.match(name, allowedClass)
})

// Public item data from the tooltip endpoint, trimmed.
const weapon = '<table><tr><td><!--nstart--><b class="q3">Rockslicer</b><!--nend--><span class="q"><br>Item Level <!--ilvl-->23</span><!--bo--><br>Binds when picked up<table width="100%"><tr><td>Two-Hand</td><th><!--scstart2:1--><span class="q1">Axe</span><!--scend--></th></tr></table><span><!--stat4-->+7 Strength</span></td></tr></table><table><tr><td>Requires Level <!--rlvl-->18<br /><span id="useText1" class="q2">Use: <a href="/forever/spell=1291896/slicing" class="q2">Slice open a vein.</a></span><br><div class="whtt-sellprice">Sell Price: <span class="moneysilver">31</span> <span class="moneycopper">89</span></div></td></tr></table>'

describe('sanitizeTooltipHtml with a real tooltip', () => {
  const tree = sanitizeTooltipHtml(weapon)
  it('keeps the text, drops the comments, and decodes entities', () => {
    const text = textOf(tree)
    assert.match(text, /Rockslicer/)
    assert.match(text, /Item Level 23/)
    assert.match(text, /Two-Hand/)
    assert.match(text, /Sell Price: 31 89/)
    assert.doesNotMatch(text, /nstart|<!--|-->/)
    assert.equal(textOf(sanitizeTooltipHtml('<span class="q">&quot;Teaches you.&quot; &amp; &#39;more&#39; &#x27;x&#x27;</span>')), '"Teaches you." & \'more\' \'x\'')
  })
  it('keeps the name class and the wide table', () => {
    const classes: string[] = []; let wide = 0
    walk(tree, (element) => { if (element.className) classes.push(element.className); if (element.wide) wide++ })
    assert.ok(classes.includes('q3') && classes.includes('q2') && classes.includes('moneysilver') && classes.includes('whtt-sellprice'))
    assert.equal(wide, 1)
  })
  it('flattens a link to its text and drops its address', () => {
    assert.match(textOf(tree), /Use: Slice open a vein\./)
    assert.doesNotMatch(JSON.stringify(tree), /href|forever|spell=/)
  })
  it('inserts the table body the browser would, so the rows nest validly', () => {
    const tables: TooltipElement[] = []; walk(tree, (element) => { if (element.tag === 'table') tables.push(element) })
    assert.ok(tables.length >= 2)
    for (const table of tables) assert.ok(table.children.every((child) => typeof child !== 'string' && child.tag === 'tbody'))
    walk(tree, (element) => {
      if (element.tag === 'tr') assert.ok(element.children.every((child) => typeof child !== 'string' && (child.tag === 'td' || child.tag === 'th')))
    })
  })
  it('produces only safe output', () => assertSafe(tree))
})

describe('sanitizeTooltipHtml with hostile input', () => {
  const vectors: Record<string, string> = {
    script: '<script>alert(1)</script>after',
    'script upper case': '<SCRIPT SRC=//evil.test/x.js></SCRIPT>after',
    'script never closed': '<b class="q3">Name</b><script>alert(1)',
    'image with handler': '<img src=x onerror=alert(1)>after',
    'javascript link': '<a href="javascript:alert(1)" onclick="x()">click</a>after',
    'event handler on a kept tag': '<span class="q3" onmouseover="alert(1)" style="position:fixed">after</span>',
    'class that the app uses': '<div class="q3 modal-backdrop sidebar app-shell">after</div>',
    style: '<style>body{display:none}</style>after',
    iframe: '<iframe src="https://evil.test"></iframe>after',
    svg: '<svg><script>alert(1)</script><a xlink:href="javascript:1">x</a></svg>after',
    'math and template': '<math><mi xlink:href="javascript:1">x</mi></math><template><b>t</b></template>after',
    form: '<form action="https://evil.test"><input name="p"><button>go</button></form>after',
    'doctype and processing': '<!DOCTYPE html><?xml version="1.0"?>after',
    'entity encoded tag': '&lt;script&gt;alert(1)&lt;/script&gt;after',
    'broken tag': '<b class="q3" <script>alert(1)</script>after',
    'unterminated attribute': '<span class="q3 onmouseover=alert(1)>after',
    'null and bidi characters': 'a\u0000b\u202ec\u2066d',
  }
  // Safety is structural: whatever the text says, the tree holds only allowed tags and class names, and React shows text as text.
  for (const [name, html] of Object.entries(vectors)) it(`${name}: only safe output`, () => assertSafe(sanitizeTooltipHtml(html)))
  // Where the dangerous part is markup, none of it is left, not even as text.
  const leftOver: Record<string, string> = {
    script: 'after', 'script upper case': 'after', 'script never closed': 'Name', 'image with handler': 'after', 'javascript link': 'clickafter',
    'event handler on a kept tag': 'after', 'class that the app uses': 'after', style: 'after', iframe: 'after', svg: 'after', 'math and template': 'after',
    form: 'after', 'doctype and processing': 'after',
  }
  for (const [name, text] of Object.entries(leftOver)) it(`${name}: leaves only "${text}"`, () => assert.equal(textOf(sanitizeTooltipHtml(vectors[name])), text))
  it('keeps no attribute at all but a class, and no style', () => {
    const tree = sanitizeTooltipHtml(vectors['event handler on a kept tag'])
    assert.deepEqual(tree, [{ tag: 'span', className: 'q3', children: ['after'] }])
  })
  it('keeps an encoded tag as plain text, never as an element', () => {
    const tree = sanitizeTooltipHtml(vectors['entity encoded tag'])
    assert.deepEqual(tree, ['<script>alert(1)</script>after'])
  })
  it('drops class names it does not know and keeps the ones it does', () => {
    const tree = sanitizeTooltipHtml(vectors['class that the app uses'])
    assert.equal((tree[0] as TooltipElement).className, 'q3')
  })
  it('removes control and bidirectional override characters', () => assert.equal(textOf(sanitizeTooltipHtml(vectors['null and bidi characters'])), 'abcd'))
  it('treats a lone less-than sign as text', () => assert.equal(textOf(sanitizeTooltipHtml('a < b and c <3')), 'a < b and c <3'))
  it('keeps numeric entities for characters, but not for control codes', () => assert.equal(textOf(sanitizeTooltipHtml('&#65;&#x42;&#0;&#7;')), 'AB&#0;&#7;'))
})

describe('invisible and look-alike characters', () => {
  // Every one of these can hide text or change how neighboring text is laid out. They are removed from names, from tooltip text and
  // when written as a numeric entity.
  const hidden: Record<string, number> = {
    'Arabic letter mark': 0x061c, 'soft hyphen': 0x00ad, 'combining grapheme joiner': 0x034f, 'Mongolian vowel separator': 0x180e, 'zero-width space': 0x200b,
    'right-to-left override': 0x202e, 'line separator': 0x2028, 'paragraph separator': 0x2029, 'word joiner': 0x2060, 'invisible times': 0x2062,
    'invisible separator': 0x2063, 'first strong isolate': 0x2068, 'Hangul filler': 0x3164, 'half-width Hangul filler': 0xffa0, 'variation selector': 0xfe0f,
    'byte order mark': 0xfeff, 'tag letter a': 0xe0041, 'cancel tag': 0xe007f, 'delete': 0x7f, 'next line': 0x85,
  }
  for (const [name, code] of Object.entries(hidden)) {
    it(`removes the ${name} (U+${code.toString(16).toUpperCase().padStart(4, '0')})`, () => {
      const character = String.fromCodePoint(code)
      assert.equal(parseItemTooltip({ name: `A${character}B` })?.name, 'AB')
      assert.equal(textOf(sanitizeTooltipHtml(`<b>A${character}B</b>`)), 'AB')
      assert.equal(textOf(sanitizeTooltipHtml(`A&#x${code.toString(16)};B`)), 'AB')
    })
  }
  it('keeps tabs, line feeds and ordinary spaces, including the non-breaking space', () => {
    assert.equal(textOf(sanitizeTooltipHtml('a\tb\nc d&nbsp;e')), 'a\tb\nc d\u00a0e')
  })
})

describe('an oversized item name', () => {
  it('is refused without being processed', () => {
    assert.equal(parseItemTooltip({ name: 'x'.repeat(401) }), undefined)
    const started = Date.now()
    assert.equal(parseItemTooltip({ name: 'x'.repeat(10_000_000) }), undefined)
    assert.equal(parseItemTooltip({ name: '&amp;'.repeat(2_000_000) }), undefined)
    assert.ok(Date.now() - started < 200)
  })
})

describe('sanitizeTooltipHtml limits', () => {
  it('never nests deeper than the limit', () => {
    const tree = sanitizeTooltipHtml('<div>'.repeat(200) + 'deep' + '</div>'.repeat(200))
    let deepest = 0; walk(tree, (_, depth) => { deepest = Math.max(deepest, depth) })
    assert.ok(deepest <= tooltipLimits.depth + 1)
    assert.match(textOf(tree), /deep/)
  })
  it('stops at the node limit', () => {
    let count = 0
    const count_ = (nodes: TooltipNode[]) => { for (const node of nodes) { count++; if (typeof node !== 'string') count_(node.children) } }
    count_(sanitizeTooltipHtml('<b>x</b>'.repeat(20000)))
    assert.ok(count <= tooltipLimits.nodes + 1)
  })
  it('reads only the first part of a very long answer, and does not take long', () => {
    const started = Date.now()
    const tree = sanitizeTooltipHtml('<span class="q3">' + 'x'.repeat(1_000_000))
    assert.ok(textOf(tree).length <= tooltipLimits.length)
    assert.ok(Date.now() - started < 1000)
  })
  it('does not take long on many unterminated tags', () => {
    const started = Date.now()
    sanitizeTooltipHtml('<a b="'.repeat(5000))
    sanitizeTooltipHtml('<'.repeat(30000))
    assert.ok(Date.now() - started < 2000)
  })
  it('handles an empty string and text without tags', () => {
    assert.deepEqual(sanitizeTooltipHtml(''), [])
    assert.deepEqual(sanitizeTooltipHtml('plain'), ['plain'])
  })
})

describe('table structure', () => {
  // The shape Wowhead sends for a weapon's damage and speed: line breaks and indentation between the tags.
  const damage = '<table width="100%"><tr>\n    <td><span><!--dmg-->52 - 78 Damage</span></td>\n    <th>Speed <!--spd-->3.30</th>\n</tr></table>'
  it('drops the whitespace between a row and its cells, and keeps the cells', () => {
    const tree = sanitizeTooltipHtml(damage)
    assertSafe(tree)
    assert.equal(textOf(tree), '52 - 78 DamageSpeed 3.30')
  })
  it('drops stray text and elements that cannot sit in a table, a body or a row', () => {
    const tree = sanitizeTooltipHtml('<table>stray<tr>lost<span>nope</span><br><td>kept</td></tr><div>also lost</div></table>after')
    assertSafe(tree)
    assert.equal(textOf(tree), 'keptafter')
  })
  it('keeps text and elements inside a cell', () => {
    const tree = sanitizeTooltipHtml('<table><tr><td>a <b>b</b><br>c<table><tr><td>d</td></tr></table></td></tr></table>')
    assertSafe(tree)
    assert.equal(textOf(tree), 'a bcd')
  })
})

describe('structure repair', () => {
  it('closes rows and cells left open', () => {
    const tree = sanitizeTooltipHtml('<table><tr><td>a<td>b<tr><td>c</table>after')
    assertSafe(tree)
    const rows: string[] = []
    walk(tree, (element) => { if (element.tag === 'tr') rows.push(textOf(element.children)) })
    assert.deepEqual(rows, ['ab', 'c'])
    assert.equal(textOf(tree), 'abcafter')
  })
  it('flattens a cell or row that is not inside a table', () => {
    const tree = sanitizeTooltipHtml('<span><td>x</td><tr>y</tr></span>')
    assertSafe(tree)
    let cells = 0; walk(tree, (element) => { if (element.tag === 'td' || element.tag === 'tr') cells++ })
    assert.equal(cells, 0)
    assert.equal(textOf(tree), 'xy')
  })
  it('ignores a closing tag that was never opened', () => assert.equal(textOf(sanitizeTooltipHtml('a</b></table></span>b')), 'ab'))
})

describe('parseItemTooltip', () => {
  const answer = { name: 'Rockslicer', quality: 3, icon: 'inv_throwingaxe_01', tooltip: weapon, spells: [] }
  it('reads a real answer', () => {
    const info = parseItemTooltip(answer)
    assert.equal(info?.name, 'Rockslicer'); assert.equal(info?.quality, 3); assert.equal(info?.icon, 'inv_throwingaxe_01')
    assert.ok(info && info.tooltip.length > 0)
  })
  it('refuses an answer without a usable name', () => {
    for (const bad of [null, undefined, 'x', 42, [], {}, { name: '' }, { name: '   ' }, { name: 5 }, { name: 'x'.repeat(121) }]) assert.equal(parseItemTooltip(bad), undefined)
  })
  it('falls back to a plain item when quality, icon or tooltip are not usable', () => {
    const info = parseItemTooltip({ name: 'Plain', quality: 99, icon: '../../etc/passwd', tooltip: 5 })
    assert.deepEqual(info, { name: 'Plain', quality: 1, icon: '', tooltip: [] })
    assert.equal(parseItemTooltip({ name: 'X', quality: 2.5 })?.quality, 1)
    assert.equal(parseItemTooltip({ name: 'X', icon: 'has space' })?.icon, '')
  })
  it('lowercases an icon name and cleans the item name', () => {
    assert.equal(parseItemTooltip({ name: 'X', icon: 'INV_Sword_24' })?.icon, 'inv_sword_24')
    assert.equal(parseItemTooltip({ name: ' Fel &amp; Steed\u202e ' })?.name, 'Fel & Steed')
  })
})

describe('urls', () => {
  it('builds the tooltip and icon addresses', () => {
    assert.equal(itemTooltipUrl(872), 'https://nether.wowhead.com/tooltip/item/872?dataEnv=16&locale=0')
    assert.equal(itemIconUrl('inv_sword_24'), 'https://wow.zamimg.com/images/wow/icons/medium/inv_sword_24.jpg')
  })
})

describe('itemSlotLabel', () => {
  // The slot part of real tooltips from the endpoint, each wrapped in the table the tooltip puts it in.
  const slotCell = (cell: string, type = '') => `<table><tr><td><b class="q3">Name</b><br>Binds when picked up<table width="100%"><tr><td>${cell}</td>${type ? `<th><span class="q1">${type}</span></th>` : ''}</tr></table><span>+4 Stamina</span></td></tr></table>`
  const slotOf = (html: string) => itemSlotLabel(sanitizeTooltipHtml(html))
  it('reads every slot label, whatever the armor or weapon type beside it', () => {
    for (const [label, type] of [['Head', 'Mail'], ['Neck', ''], ['Shoulder', 'Cloth'], ['Back', ''], ['Chest', 'Mail'], ['Wrist', 'Leather'], ['Hands', 'Leather'], ['Waist', 'Plate'], ['Legs', 'Cloth'], ['Feet', 'Mail'],
      ['Finger', ''], ['Trinket', ''], ['One-Hand', 'Sword'], ['Main Hand', 'Dagger'], ['Two-Hand', 'Axe'], ['Off Hand', 'Shield'], ['Held In Off-hand', ''], ['Ranged', 'Bow'], ['Thrown', 'Thrown'], ['Relic', 'Totem']]) {
      assert.equal(slotOf(slotCell(label, type)), label, label)
    }
  })
  it('knows every label it can read', () => {
    for (const label of slotLabels) assert.equal(slotOf(slotCell(label)), label)
  })
  it('ignores case and spaces around the label', () => assert.equal(slotOf(slotCell('  two-hand ', 'Axe')), 'Two-Hand'))
  it('gives undefined for an item that goes in no slot', () => {
    assert.equal(slotOf('<table><tr><td><b class="q2">Snakeskin Bag</b><br>Binds when picked up<br />10 Slot Bag</td></tr></table>'), undefined)
    assert.equal(slotOf('<table><tr><td><b class="q3">Plans: Golden Scale Boots</b><br>Requires Blacksmithing (200)</td></tr></table>'), undefined)
    assert.equal(itemSlotLabel([]), undefined)
  })
  it('does not take a word in the text for a slot, only a table cell that holds just that word', () => {
    assert.equal(slotOf('<table><tr><td><b>Name</b><br>Equip: Increases healing done. Head of the Hand<br>Finger</td></tr></table>'), undefined)
    assert.equal(slotOf(slotCell('Finger of the Wind')), undefined)
  })
  it('takes the first slot cell it finds', () => assert.equal(slotOf(slotCell('Two-Hand', 'Axe') + slotCell('Finger')), 'Two-Hand'))
})

describe('itemLookupErrorOf and itemLookupErrors', () => {
  // docs/design/drop-list-import.md section 7: only an item Wowhead has no record of is an unknown item; unreachable and busy are shown as that, with a retry.
  it('tells an item Wowhead does not have apart from a busy Wowhead and a refused request', () => {
    assert.deepEqual(itemLookupErrorOf(404), { reason: 'missing', message: 'Wowhead has no item with this id.' })
    for (const status of [429, 500, 502, 503, 504]) assert.deepEqual(itemLookupErrorOf(status), { reason: 'busy', message: 'Wowhead is busy. Try again in a moment.' }, `status ${status}`)
    for (const status of [400, 401, 403, 410, 418]) assert.deepEqual(itemLookupErrorOf(status), { reason: 'refused', message: `Wowhead answered with an error (${status}).` }, `status ${status}`)
  })
  it('keeps the messages the app showed before, one reason each', () => {
    assert.deepEqual(itemLookupErrors, {
      missing: { reason: 'missing', message: 'Wowhead has no item with this id.' },
      unreachable: { reason: 'unreachable', message: 'Could not reach Wowhead.' },
      busy: { reason: 'busy', message: 'Wowhead is busy. Try again in a moment.' },
      tooLarge: { reason: 'refused', message: 'Wowhead sent an unexpected answer.' },
    })
  })
})
