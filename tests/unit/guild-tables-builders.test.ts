// Property tests of the write builders of src/shared/game/guildTables.ts (addItems, takeOffItem, restoreItem, addCreature, setCreatureRemoved,
// renameCreature, moveCreature, addZone, editZone, setZoneInPhase, setFollows), from the spec (PR-texts/Design-loot-tables-phases.md,
// "Edits in the editor", and PR-texts/Design-zone-editor.md). A write is applied to a list of documents the way the audited helper does (support/tableWrites.ts), the lists are merged again
// at the same phase and the intended effect is checked, together with what must stay as it was: the lists of earlier phases, the other creatures and
// zones, the documents of other phases. Every document a write leaves behind is checked against the shape rules of the spec. Single operations on
// random states, then sequences of 2 to 6 operations across phases N and N+1. Deterministic: seeded, and Math.random is replaced while a builder
// that uses it runs. To prove the tests can fail, point GUILD_TABLES_MODULE at a changed copy of the module.
import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import type { LootTableDoc, MergedSource, MergedZone, PhaseTableDoc, SourceTableDoc, TableWrite, ZoneTableDoc } from '../../src/shared/game/guildTables.ts'
import type { LootSourceKind, LootTableCapture } from '../../src/shared/game/lootTables.ts'
import { firstDiff, firstDropDiff } from './support/mergeCompare.ts'
import { chainOf, referenceDropTables, referenceMerge } from './support/mergeReference.ts'
import { applyWrite, rulesProblems } from './support/tableWrites.ts'
import { deepFreeze, formatCase, genCase, makeRng, type Rng } from './support/tablesGen.ts'
import { tables } from './support/tablesUnderTest.ts'

const { mergeTables, dropTablesOf, addItems, takeOffItem, restoreItem, addCreature, setCreatureRemoved, renameCreature, moveCreature, addZone, editZone, setZoneInPhase, setFollows, setZonesInPhase: tablesSetZones, newCreatureKey, newZoneId } = tables

type State = { captures: LootTableCapture[]; docs: LootTableDoc[] }
const ITEMS = [101, 102, 103, 104, 105, 106, 107, 108, 109, 110, 111, 112, 113, 114, 900, 901]
const NAMES = ['Ash', 'Bog', 'Cinder', 'Dusk', 'Ember']
const ZONE_NAMES = ['Alder Hollow', 'Bramble Keep', 'Cinder Vault']
const KINDS: LootSourceKind[] = ['boss', 'rare', 'trash']
const ATTRIBUTES = ['name', 'kind', 'order', 'npcId', 'removed'] as const

// JSON with the keys in order, so that two answers with the same content in a different key order compare equal.
const sortKeys = (value: unknown): unknown => (Array.isArray(value) ? value.map(sortKeys) : value && typeof value === 'object' ? Object.fromEntries(Object.keys(value).sort().map((key) => [key, sortKeys((value as Record<string, unknown>)[key])])) : value)
const json = (value: unknown) => JSON.stringify(sortKeys(value))
const sdoc = (docs: LootTableDoc[], zoneId: number, key: string, phaseNo: number) => docs.find((doc): doc is SourceTableDoc => doc.type === 'source' && doc.zoneId === zoneId && doc.key === key && doc.phaseNo === phaseNo)
const zdoc = (docs: LootTableDoc[], zoneId: number, phaseNo: number) => docs.find((doc): doc is ZoneTableDoc => doc.type === 'zone' && doc.zoneId === zoneId && doc.phaseNo === phaseNo)
const sourceOf = (zone: MergedZone | undefined, key: string) => (key === 'zonewide' ? zone?.zoneWide : zone?.sources.find((candidate) => candidate.key === key))
// The creature an item of the zone is on: one in the lists, then the zone-wide list, then one a leader took out (it keeps its items; drop-list-import.md section 6).
const holderOf = (zone: MergedZone, id: number) => [...zone.sources.filter((candidate) => !candidate.removed), zone.zoneWide, ...zone.sources.filter((candidate) => candidate.removed)].find((candidate) => candidate.itemIds.includes(id))
const withoutDoc = ({ doc: _doc, ...rest }: MergedSource) => rest
const attributesOf = (doc: SourceTableDoc | undefined) => json(ATTRIBUTES.map((field) => doc?.[field]))

// Math.random replaced by the seeded generator while a builder that draws a key or a zone number runs.
function seeded<T>(rng: Rng, run: () => T): T {
  const original = Math.random
  Math.random = () => rng.next()
  try { return run() } finally { Math.random = original }
}

// Things the tests found that the spec does not allow: counted here (FUZZ_VERBOSE=1 prints the first examples) and pinned by the todo tests at the end.
const newFindings = () => ({ renamePinsUnchanged: [] as string[], moveWithTies: [] as string[], moveWithTiesFromCaptures: [] as string[] })
type Findings = ReturnType<typeof newFindings>
const newCounts = () => ({} as Record<string, number>)

function makeRun(seed: number, initial: State, base: number, rng: Rng, findings: Findings, counts: Record<string, number>) {
  const fromCaptures = initial.docs.length === 0 // every document there will be comes from the builders
  let state = initial
  let phase = base
  let keyNumber = 0
  const trail: string[] = []
  const fail = (message: string): never => {
    throw new assert.AssertionError({ message: `${message}\nseed ${seed}, base phase ${base}, now writing phase ${phase}\ninitial state:\n${formatCase(initial.captures, initial.docs)}\noperations so far:\n${trail.join('\n') || '(none)'}` })
  }
  const check = (condition: unknown, message: string) => { if (!condition) fail(message) }
  const same = (expected: unknown, actual: unknown, message: string) => {
    if (json(expected) !== json(actual)) fail(`${message}\n  expected ${json(expected)}\n  actual   ${json(actual)}`)
  }
  const merged = (from: State, phaseNo: number) => mergeTables(from.captures, deepFreeze(from.docs), phaseNo)
  const zoneIn = (from: State, phaseNo: number, zoneId: number) => merged(from, phaseNo).find((zone) => zone.zoneId === zoneId)
  // A change in this phase reaches the next phase only when the next phase follows this one (directly, or through the phases it follows).
  const reaches = () => chainOf(state.docs, phase + 1).includes(phase)

  // Applies the writes of one operation and checks what every write must satisfy, whatever it was meant to do.
  function commit(writes: TableWrite[]): State {
    let docs = state.docs
    for (const write of writes) {
      let next: LootTableDoc[]
      try { next = applyWrite(docs, write) } catch (error) { return fail(String(error)) }
      const doc = next.find((candidate) => candidate.id === write.id)!
      check(doc.phaseNo === phase, `a write to ${write.id}, a document of phase ${doc.phaseNo}, while editing phase ${phase}`)
      const problems = rulesProblems(doc, 'create' in write)
      check(problems.length === 0, `the rules would refuse the document ${json(doc)}: ${problems.join('; ')}`)
      docs = next
    }
    const post = { captures: state.captures, docs }
    same(state.docs.filter((doc) => doc.phaseNo !== phase), post.docs.filter((doc) => doc.phaseNo !== phase), 'a write changed a document of another phase')
    for (let earlier = 0; earlier < phase; earlier += 1) same(merged(state, earlier), merged(post, earlier), `the lists of phase ${earlier} changed by a write in phase ${phase}`)
    for (const at of [phase, phase + 1]) {
      const zones = merged(post, at)
      const diff = firstDiff(referenceMerge(post.captures, post.docs, at), zones, false) ?? firstDropDiff(referenceDropTables(post.captures, post.docs, at), dropTablesOf(post.captures, deepFreeze(post.docs), at), zones.map((zone) => zone.zoneId))
      check(!diff, `after the write the merge of phase ${at} differs from the reference: ${diff ? `${diff.path}: reference ${json(diff.expected)}, merge ${json(diff.actual)}` : ''}`)
    }
    state = post
    return post
  }

  type Op = () => boolean // false: not applicable to this state
  const pickZone = () => rng.pick(merged(state, phase))
  const pickItemSource = (zone: MergedZone) => rng.pick([...zone.sources.filter((candidate) => !candidate.removed), zone.zoneWide])

  const ops: Record<string, { weight: number; run: Op }> = {
    addItems: {
      weight: 3,
      run: () => {
        const zone = pickZone()
        const source = pickItemSource(zone)
        const ids = rng.sample(ITEMS, 1 + rng.int(3))
        const result = addItems(zone, source, ids)
        trail.push(`addItems zone ${zone.zoneId} ${source.key} [${ids}] at ${phase}`)
        const held = ids.filter((id) => holderOf(zone, id) !== undefined)
        same([...held].sort(), result.alreadyIn.map((entry) => entry.id).sort(), 'alreadyIn is exactly the items a creature of the zone already drops')
        for (const entry of result.alreadyIn) check(entry.where === holderOf(zone, entry.id)!.name, `alreadyIn names ${entry.where} for ${entry.id}, the holder is ${holderOf(zone, entry.id)!.name}`)
        same(ids.filter((id) => !held.includes(id)).sort(), [...result.added].sort(), 'added is exactly the items no creature of the zone drops')
        check(!result.tooMany, 'tooMany with so few items')
        if (result.added.length === 0) { check(result.write === null, 'a write although nothing is added'); return true }
        check(result.write !== null, 'items to add but no write')
        const before = state
        commit([result.write!])
        const zoneAfter = zoneIn(state, phase, zone.zoneId)!
        const sourceAfter = sourceOf(zoneAfter, source.key)!
        for (const id of result.added) check(sourceAfter.itemIds.includes(id), `item ${id} reported added is not in the creature`)
        same(source.itemIds, sourceAfter.itemIds.filter((id) => !result.added.includes(id)), 'the items the creature had are not kept as they were')
        for (const id of ITEMS) if (!result.added.includes(id)) same(holderOf(zone, id)?.name, holderOf(zoneAfter, id)?.name, `item ${id} moved to another creature`)
        same(zone.sources.filter((candidate) => candidate.key !== source.key), zoneAfter.sources.filter((candidate) => candidate.key !== source.key), 'another creature changed')
        if (source.key !== 'zonewide') same(zone.zoneWide, zoneAfter.zoneWide, 'the zone-wide list changed')
        same(merged(before, phase).filter((candidate) => candidate.zoneId !== zone.zoneId), merged(state, phase).filter((candidate) => candidate.zoneId !== zone.zoneId), 'another zone changed')
        same(attributesOf(sdoc(before.docs, zone.zoneId, source.key, phase)), attributesOf(sdoc(state.docs, zone.zoneId, source.key, phase)), 'adding items wrote an attribute (name, kind, place, number, removed) into the document')
        // a change in this phase reaches the next one unless the next phase's own document says something about the item
        const next = sdoc(state.docs, zone.zoneId, source.key, phase + 1)
        for (const id of result.added) if (reaches() && !next?.itemIds.includes(id) && !next?.hiddenItemIds.includes(id)) check(sourceOf(zoneIn(state, phase + 1, zone.zoneId), source.key)!.itemIds.includes(id), `item ${id} added in phase ${phase} is not in phase ${phase + 1}`)
        return true
      },
    },

    takeOffItem: {
      weight: 3,
      run: () => {
        const zone = pickZone()
        const source = pickItemSource(zone)
        const id = source.itemIds.length > 0 && rng.chance(0.8) ? rng.pick(source.itemIds) : rng.pick(ITEMS)
        const write = takeOffItem(zone, source, id)
        trail.push(`takeOffItem zone ${zone.zoneId} ${source.key} ${id} at ${phase}`)
        if (!source.itemIds.includes(id)) { check(write === null, 'a write to take off an item the creature does not drop'); return true }
        check(write !== null, `no write to take off ${id}, which the creature drops`)
        const before = state
        commit([write!])
        const zoneAfter = zoneIn(state, phase, zone.zoneId)!
        const sourceAfter = sourceOf(zoneAfter, source.key)!
        check(!sourceAfter.itemIds.includes(id), `item ${id} is still there after it was taken off`)
        same(source.itemIds.filter((candidate) => candidate !== id), sourceAfter.itemIds, 'the other items did not stay as they were')
        const wasBefore = source.beforeItemIds.includes(id)
        // An item this phase added and takes off again is remembered as taken off too (docs/design/drop-list-import.md section 6), so it can be brought back.
        check(sourceAfter.hiddenItemIds.includes(id), wasBefore ? 'an item of the earlier phases taken off is not reported as taken off by this phase' : 'an item this phase added and took off again is not reported as taken off')
        check(!sourceAfter.addedItemIds.includes(id), 'an item taken off is still reported as added by this phase')
        same(source.hiddenItemIds.filter((candidate) => candidate !== id), sourceAfter.hiddenItemIds.filter((candidate) => candidate !== id), 'the items taken off before did not stay taken off')
        check(!sourceAfter.goneItemIds.includes(id), 'an item this phase took off is listed as gone')
        // the phase it follows keeps it
        const followed = chainOf(state.docs, phase).at(-2)
        if (wasBefore && followed !== undefined) check(sourceOf(zoneIn(state, followed, zone.zoneId), source.key)!.itemIds.includes(id), `item ${id} is gone from phase ${followed} too`)
        for (let earlier = 0; earlier < phase; earlier += 1) same(sourceOf(zoneIn(before, earlier, zone.zoneId), source.key)?.itemIds, sourceOf(zoneIn(state, earlier, zone.zoneId), source.key)?.itemIds, `the items of phase ${earlier} changed`)
        same(zone.sources.filter((candidate) => candidate.key !== source.key), zoneAfter.sources.filter((candidate) => candidate.key !== source.key), 'another creature changed')
        same(attributesOf(sdoc(before.docs, zone.zoneId, source.key, phase)), attributesOf(sdoc(state.docs, zone.zoneId, source.key, phase)), 'taking an item off wrote an attribute into the document')
        const next = sdoc(state.docs, zone.zoneId, source.key, phase + 1)
        if (reaches() && !next?.itemIds.includes(id) && !next?.hiddenItemIds.includes(id)) check(!sourceOf(zoneIn(state, phase + 1, zone.zoneId), source.key)!.itemIds.includes(id), `item ${id} taken off in phase ${phase} is back in phase ${phase + 1}`)
        return true
      },
    },

    restoreItem: {
      weight: 2,
      run: () => {
        const zone = pickZone()
        const source = pickItemSource(zone)
        const id = source.hiddenItemIds.length > 0 && rng.chance(0.8) ? rng.pick(source.hiddenItemIds) : rng.pick(ITEMS)
        const write = restoreItem(zone, source, id)
        trail.push(`restoreItem zone ${zone.zoneId} ${source.key} ${id} at ${phase}`)
        if (!source.hiddenItemIds.includes(id)) { check(write === null, 'a write to put back an item this phase did not take off'); return true }
        if (holderOf(zone, id)) { check(write === null, `a write to put back ${id}, which ${holderOf(zone, id)!.name} has now`); return true }
        check(write !== null, `no write to put back ${id}`)
        const before = state
        commit([write!])
        const sourceAfter = sourceOf(zoneIn(state, phase, zone.zoneId), source.key)!
        check(sourceAfter.itemIds.includes(id), `item ${id} is not back`)
        check(!sourceAfter.hiddenItemIds.includes(id), `item ${id} is still reported as taken off`)
        // one this phase added and took off again comes back as added in this phase; one it had before comes back as it was
        check(sourceAfter.addedItemIds.includes(id) === !source.beforeItemIds.includes(id), `item ${id} is back ${sourceAfter.addedItemIds.includes(id) ? 'as added' : 'as not added'} by this phase`)
        same(source.itemIds, sourceAfter.itemIds.filter((candidate) => candidate !== id), 'the other items did not stay as they were')
        same(source.hiddenItemIds.filter((candidate) => candidate !== id), sourceAfter.hiddenItemIds, 'the other items taken off did not stay taken off')
        same(attributesOf(sdoc(before.docs, zone.zoneId, source.key, phase)), attributesOf(sdoc(state.docs, zone.zoneId, source.key, phase)), 'putting an item back wrote an attribute into the document')
        const next = sdoc(state.docs, zone.zoneId, source.key, phase + 1)
        if (reaches() && !next?.itemIds.includes(id) && !next?.hiddenItemIds.includes(id)) check(sourceOf(zoneIn(state, phase + 1, zone.zoneId), source.key)!.itemIds.includes(id), `item ${id} put back in phase ${phase} is not in phase ${phase + 1}`)
        return true
      },
    },

    takeOffThenRestore: {
      weight: 1,
      run: () => {
        const zone = pickZone()
        const source = pickItemSource(zone)
        if (source.itemIds.length === 0) return false
        // an item it had before, or (since docs/design/drop-list-import.md section 6) one this phase added
        const id = rng.pick(source.itemIds)
        const addedHere = !source.beforeItemIds.includes(id)
        trail.push(`takeOffItem then restoreItem zone ${zone.zoneId} ${source.key} ${id} at ${phase}`)
        commit([takeOffItem(zone, source, id)!])
        const taken = zoneIn(state, phase, zone.zoneId)!
        const back = restoreItem(taken, sourceOf(taken, source.key)!, id)
        // (an item two creatures came to have stays with the other one: putting it back would make it two again)
        if (holderOf(taken, id)) { check(back === null, `a write to put back ${id}, which ${holderOf(taken, id)!.name} has too`); return true }
        check(back !== null, `no write to put back ${id} right after it was taken off`)
        commit([back!])
        const after = sourceOf(zoneIn(state, phase, zone.zoneId), source.key)!
        // An item this phase added comes back at the end of what the phase adds, so only the order of the added items may differ.
        const settled = (merged: MergedSource) => (addedHere ? { ...withoutDoc(merged), itemIds: [...merged.itemIds].sort(), addedItemIds: [...merged.addedItemIds].sort() } : withoutDoc(merged))
        same(settled(source), settled(after), `taking ${id} off and putting it back does not leave the creature as it was`)
        return true
      },
    },

    addCreature: {
      weight: 2,
      run: () => {
        const zone = pickZone()
        const name = rng.chance(0.3) ? ` ${rng.pick(NAMES)} ` : rng.pick(NAMES)
        const kind = rng.pick(KINDS)
        const npcId = rng.chance(0.5) ? 50 + rng.int(10) : undefined
        keyNumber += 1
        const key = `cq${keyNumber}`
        const write = addCreature(zone, { name, kind, ...(npcId === undefined ? {} : { npcId }) }, key)
        trail.push(`addCreature zone ${zone.zoneId} ${key} "${name}" ${kind} npc ${npcId ?? '-'} at ${phase}`)
        const others = zone.sources.map((candidate) => candidate.order)
        commit([write])
        const zoneAfter = zoneIn(state, phase, zone.zoneId)!
        const added = sourceOf(zoneAfter, key)
        check(added, 'the new creature does not exist')
        check(added!.name === name.trim() && added!.kind === kind && added!.npcId === npcId && !added!.removed && !added!.builtIn, `the new creature is not as asked: ${json(withoutDoc(added!))}`)
        check(added!.itemIds.length === 0 && added!.doc?.id === write.id && added!.introducedAt === phase, 'the new creature has items, no document or the wrong introducedAt')
        check(added!.order >= Math.max(0, ...others), `the new creature (place ${added!.order}) is not met after the others (${others})`)
        if (added!.order > Math.max(0, ...others)) check(zoneAfter.sources[zoneAfter.sources.length - 1].key === key, 'the new creature is not the last in the list')
        same(zone.sources, zoneAfter.sources.filter((candidate) => candidate.key !== key), 'another creature changed')
        const create = 'create' in write ? (write.create as Record<string, unknown>) : {}
        same(['type', 'zoneId', 'key', 'phaseNo', 'name', 'kind', 'order', 'itemIds', 'hiddenItemIds', ...(npcId === undefined ? [] : ['npcId'])].sort(), Object.keys(create).filter((field) => create[field] !== undefined).sort(), 'the first document of a creature does not say exactly what it should')
        const next = sourceOf(zoneIn(state, phase + 1, zone.zoneId), key)
        if (reaches()) check(next && next.name === name.trim() && next.kind === kind && next.order === added!.order, 'the new creature is not in the next phase as it is in this one')
        return true
      },
    },

    setCreatureRemoved: {
      weight: 2,
      run: () => {
        const zone = pickZone()
        const source = rng.pick([...zone.sources, zone.zoneWide])
        const removed = rng.chance(0.7) ? !source.removed : source.removed
        const write = setCreatureRemoved(zone, source, removed)
        trail.push(`setCreatureRemoved zone ${zone.zoneId} ${source.key} ${removed} at ${phase}`)
        const locked = source.builtIn || source.key === 'zonewide'
        if (locked || source.removed === removed) { check(write === null, locked ? 'a write to take out or bring back a creature of the captures or the zone-wide list' : 'a write that changes nothing'); return true }
        check(write !== null, 'no write to take out or bring back a creature the guild added')
        const before = state
        commit([write!])
        const zoneAfter = zoneIn(state, phase, zone.zoneId)!
        const sourceAfter = sourceOf(zoneAfter, source.key)!
        check(sourceAfter.removed === removed, `removed is ${sourceAfter.removed}, not ${removed}`)
        same({ ...withoutDoc(source), removed: undefined }, { ...withoutDoc(sourceAfter), removed: undefined }, 'taking a creature out or bringing it back changed more than removed')
        same(source.itemIds, sourceAfter.itemIds, 'taking a creature out or bringing it back lost its items')
        same(json(ATTRIBUTES.filter((field) => field !== 'removed').map((field) => sdoc(before.docs, zone.zoneId, source.key, phase)?.[field])), json(ATTRIBUTES.filter((field) => field !== 'removed').map((field) => sdoc(state.docs, zone.zoneId, source.key, phase)?.[field])), 'removal wrote another attribute into the document')
        const next = sdoc(state.docs, zone.zoneId, source.key, phase + 1)
        if (reaches() && typeof next?.removed !== 'boolean') check(sourceOf(zoneIn(state, phase + 1, zone.zoneId), source.key)!.removed === removed, `removed (${removed}) set in phase ${phase} does not reach phase ${phase + 1}`)
        return true
      },
    },

    renameCreature: {
      weight: 2,
      run: () => {
        const zone = pickZone()
        const source = rng.pick([...zone.sources, zone.zoneWide])
        const name = rng.chance(0.4) ? source.name : rng.chance(0.3) ? ` ${rng.pick(NAMES)} ` : rng.pick(NAMES)
        const kind = rng.chance(0.4) && source.kind !== 'zonewide' ? source.kind : rng.pick(KINDS)
        const write = renameCreature(zone, source, name, kind)
        trail.push(`renameCreature zone ${zone.zoneId} ${source.key} "${name}" ${kind} at ${phase}`)
        const locked = source.builtIn || source.key === 'zonewide'
        const nameChanged = name.trim() !== source.name
        const kindChanged = kind !== source.kind
        if (locked || (!nameChanged && !kindChanged)) { check(write === null, locked ? 'a write to rename a creature of the captures or the zone-wide list' : 'a write that changes nothing'); return true }
        check(write !== null, 'no write to rename a creature the guild added')
        const before = state
        commit([write!])
        const zoneAfter = zoneIn(state, phase, zone.zoneId)!
        const sourceAfter = sourceOf(zoneAfter, source.key)!
        check(sourceAfter.name === name.trim() && sourceAfter.kind === kind, `renamed to ${sourceAfter.name}/${sourceAfter.kind}, not ${name.trim()}/${kind}`)
        same({ ...withoutDoc(source), name: 0, kind: 0 }, { ...withoutDoc(sourceAfter), name: 0, kind: 0 }, 'renaming changed more than the name and the kind')
        const docBefore = sdoc(before.docs, zone.zoneId, source.key, phase)
        const docAfter = sdoc(state.docs, zone.zoneId, source.key, phase)!
        if ((!nameChanged && docBefore?.name === undefined && docAfter.name !== undefined) || (!kindChanged && docBefore?.kind === undefined && docAfter.kind !== undefined)) {
          findings.renamePinsUnchanged.push(`${source.key}: name ${source.name} -> "${name}", kind ${source.kind} -> ${kind}; document ${json({ name: docAfter.name, kind: docAfter.kind })}`)
        }
        // what the rename changed reaches the next phase unless that phase's own document sets it
        const next = sdoc(state.docs, zone.zoneId, source.key, phase + 1)
        const nextSource = sourceOf(zoneIn(state, phase + 1, zone.zoneId), source.key)!
        if (reaches() && nameChanged && next?.name === undefined) check(nextSource.name === name.trim(), `the new name does not reach phase ${phase + 1}`)
        if (reaches() && kindChanged && next?.kind === undefined) check(nextSource.kind === kind, `the new kind does not reach phase ${phase + 1}`)
        return true
      },
    },

    moveCreature: {
      weight: 3,
      run: () => {
        const zone = pickZone()
        const live = zone.sources.filter((candidate) => !candidate.removed)
        if (live.length === 0) return false
        const source = rng.pick(live)
        const direction = rng.pick([-1, 1] as const)
        const index = live.indexOf(source)
        const writes = moveCreature(zone, source, direction)
        trail.push(`moveCreature zone ${zone.zoneId} ${source.key} ${direction} at ${phase}`)
        if (!live[index + direction]) { check(writes.length === 0, 'a move past the end of the list'); return true }
        check(writes.length >= 1, `a move gave ${writes.length} writes`)
        const before = state
        commit(writes)
        const zoneAfter = zoneIn(state, phase, zone.zoneId)!
        const expected = live.map((candidate) => candidate.key)
        ;[expected[index], expected[index + direction]] = [expected[index + direction], expected[index]]
        const actual = zoneAfter.sources.filter((candidate) => !candidate.removed).map((candidate) => candidate.key)
        if (json(expected) !== json(actual)) {
          check(false, `a move does not swap two neighbors: expected ${json(expected)}, got ${json(actual)}`)
          if (fromCaptures) findings.moveWithTiesFromCaptures.push(`seed ${seed}: ${trail.join(' | ')}`)
          findings.moveWithTies.push(`orders ${json(live.map((candidate) => [candidate.key, candidate.name, candidate.order]))}, move ${source.key} ${direction}: expected ${json(expected)}, got ${json(actual)}`)
        }
        for (const write of writes) {
          const key = ('create' in write ? (write.create as { key: string }).key : (write.existing as SourceTableDoc).key)
          const docBefore = sdoc(before.docs, zone.zoneId, key, phase)
          const docAfter = sdoc(state.docs, zone.zoneId, key, phase)!
          same(json(ATTRIBUTES.filter((field) => field !== 'order').map((field) => docBefore?.[field])), json(ATTRIBUTES.filter((field) => field !== 'order').map((field) => docAfter[field])), 'a move wrote another attribute into a document')
          same(docBefore?.itemIds ?? [], docAfter.itemIds, 'a move changed the items in a document')
        }
        same(zone.sources.filter((candidate) => candidate.removed), zoneAfter.sources.filter((candidate) => candidate.removed), 'a move changed a removed creature')
        return true
      },
    },

    addZone: {
      weight: 1,
      run: () => {
        const taken = [...state.captures.map((capture) => capture.zoneId), ...state.docs.flatMap((doc) => (doc.type === 'phase' ? [] : [doc.zoneId]))]
        const name = rng.chance(0.3) ? ` ${rng.pick(ZONE_NAMES)} ` : rng.pick(ZONE_NAMES)
        const kind = rng.pick(['dungeon', 'raid'] as const)
        const players = rng.pick([5, 10, 25, 40])
        const { zoneId, write } = seeded(rng, () => addZone({ name, kind, players }, taken, phase))
        trail.push(`addZone ${zoneId} "${name}" ${kind} ${players} at ${phase}`)
        check(zoneId >= 50_000_000 && zoneId <= 100_000_000 && !taken.includes(zoneId), `new zone number ${zoneId}`)
        check(write.id === `z${zoneId}_${phase}` && 'create' in write, 'the new zone is not a create of its own document')
        const before = state
        commit([write])
        const zone = zoneIn(state, phase, zoneId)
        check(zone, 'the new zone does not exist')
        check(zone!.name === name.trim() && zone!.kind === kind && zone!.players === players && zone!.custom && !zone!.inPhase && zone!.introducedAt === phase && zone!.sources.length === 0, `the new zone is not as asked: ${json(zone)}`)
        same(['kind', 'name', 'phaseNo', 'players', 'type', 'zoneId'], Object.keys((write as { create: object }).create).sort(), 'the first document of a zone does not say exactly name, kind and size')
        same(merged(before, phase), merged(state, phase).filter((candidate) => candidate.zoneId !== zoneId), 'another zone changed')
        const next = zoneIn(state, phase + 1, zoneId)
        check(next && next.name === zone!.name && next.kind === kind && next.players === players, 'the new zone is not in the next phase')
        return true
      },
    },

    editZone: {
      weight: 2,
      run: () => {
        const zone = pickZone()
        const name = rng.chance(0.4) ? zone.name : rng.chance(0.3) ? ` ${rng.pick(ZONE_NAMES)} ` : rng.pick(ZONE_NAMES)
        const kind = rng.chance(0.5) ? zone.kind : rng.pick(['dungeon', 'raid'] as const)
        const players = rng.chance(0.5) ? zone.players : rng.pick([5, 10, 25, 40])
        const write = editZone(zone, { name, kind, players })
        trail.push(`editZone ${zone.zoneId} "${name}" ${kind} ${players} at ${phase}`)
        const changes = { name: name.trim() !== zone.name, kind: kind !== zone.kind, players: players !== zone.players }
        if (!zone.custom || !(changes.name || changes.kind || changes.players)) { check(write === null, !zone.custom ? 'a write to edit a zone of the captures' : 'a write that changes nothing'); return true }
        check(write !== null, 'no write to edit a zone the guild made')
        const before = state
        commit([write!])
        const after = zoneIn(state, phase, zone.zoneId)!
        check(after.name === name.trim() && after.kind === kind && after.players === players, `the zone is ${after.name}/${after.kind}/${after.players}, not ${name.trim()}/${kind}/${players}`)
        same(zone.sources, after.sources, 'editing a zone changed its creatures')
        check(after.inPhase === zone.inPhase, 'editing a zone changed whether it is in the lists')
        const docBefore = zdoc(before.docs, zone.zoneId, phase)
        const docAfter = zdoc(state.docs, zone.zoneId, phase)!
        for (const field of ['name', 'kind', 'players'] as const) check((docAfter[field] !== undefined) === (docBefore?.[field] !== undefined || changes[field]), `the document ${changes[field] ? 'lacks the changed' : 'gained the unchanged'} field ${field}`)
        check(docAfter.removed === docBefore?.removed, 'editing a zone changed removed in the document')
        const next = zdoc(state.docs, zone.zoneId, phase + 1)
        const nextZone = zoneIn(state, phase + 1, zone.zoneId)!
        if (changes.name && next?.name === undefined) check(nextZone.name === name.trim(), `the new name does not reach phase ${phase + 1}`)
        if (changes.kind && next?.kind === undefined) check(nextZone.kind === kind, `the new kind does not reach phase ${phase + 1}`)
        if (changes.players && next?.players === undefined) check(nextZone.players === players, `the new size does not reach phase ${phase + 1}`)
        return true
      },
    },

    setZoneInPhase: {
      weight: 2,
      run: () => {
        const zone = pickZone()
        const inPhase = rng.chance(0.7) ? !zone.inPhase : zone.inPhase
        const write = setZoneInPhase(zone, inPhase)
        trail.push(`setZoneInPhase ${zone.zoneId} ${inPhase} at ${phase}`)
        if (zone.inPhase === inPhase) { check(write === null, 'a write that changes nothing'); return true }
        check(write !== null, 'no write to take a zone out of the lists or put it back')
        const before = state
        commit([write!])
        const after = zoneIn(state, phase, zone.zoneId)!
        check(after.inPhase === inPhase, `inPhase is ${after.inPhase}, not ${inPhase}`)
        same({ ...zone, inPhase: 0, doc: 0, edited: 0 }, { ...after, inPhase: 0, doc: 0, edited: 0 }, 'taking a zone out or putting it back changed more than inPhase')
        const docBefore = zdoc(before.docs, zone.zoneId, phase)
        const docAfter = zdoc(state.docs, zone.zoneId, phase)!
        same(json([docBefore?.name, docBefore?.kind, docBefore?.players]), json([docAfter.name, docAfter.kind, docAfter.players]), 'taking a zone out or putting it back wrote another attribute into the document')
        const next = zdoc(state.docs, zone.zoneId, phase + 1)
        if (reaches() && typeof next?.removed !== 'boolean') check(zoneIn(state, phase + 1, zone.zoneId)!.inPhase === inPhase, `inPhase (${inPhase}) set in phase ${phase} does not reach phase ${phase + 1}`)
        return true
      },
    },

    setFollows: {
      weight: 2,
      run: () => {
        if (phase === 0) return false // nothing is earlier than the first phase
        const follows = rng.pick([undefined, ...Array.from({ length: phase }, (_, no) => no)])
        const stored = state.docs.find((doc): doc is PhaseTableDoc => doc.type === 'phase' && doc.phaseNo === phase)?.follows
        const write = setFollows(state.docs, phase, follows)
        trail.push(`setFollows phase ${phase} -> ${follows ?? 'nothing'}`)
        if (stored === follows) { check(write === null, 'a write that changes nothing'); return true }
        check(write !== null, `no write to make phase ${phase} follow ${follows ?? 'nothing'}`)
        check(write!.id === `p${phase}`, `the phase document is filed under ${write!.id}`)
        const before = state
        commit([write!])
        const chain = chainOf(state.docs, phase)
        same(follows === undefined ? [phase] : [...chainOf(state.docs, follows), phase], chain, 'the chain of the phase is not what it was made to follow')
        same(before.docs.filter((doc) => doc.type !== 'phase' || doc.phaseNo !== phase), state.docs.filter((doc) => doc.type !== 'phase' || doc.phaseNo !== phase), 'following changed a document that is not the phase document')
        const created = 'create' in write! ? (write as { create: Record<string, unknown> }).create : {}
        if ('create' in write!) same(['follows', 'phaseNo', 'type'], Object.keys(created).filter((field) => created[field] !== undefined).sort(), 'the first document of a phase does not say exactly what it follows')
        return true
      },
    },

    tickEveryZone: {
      weight: 1,
      run: () => {
        const zones = merged(state, phase)
        const inPhase = rng.chance(0.7)
        const writes = tablesSetZones(zones, inPhase)
        trail.push(`setZonesInPhase ${inPhase} at ${phase}`)
        same(zones.filter((zone) => zone.inPhase !== inPhase).map((zone) => zone.zoneId), writes.map((write) => Number(write.id.slice(1, write.id.indexOf('_')))), 'one write for every zone that is not already so, and none for the others')
        if (writes.length === 0) return true
        commit(writes)
        check(merged(state, phase).every((zone) => zone.inPhase === inPhase), `not every zone is ${inPhase ? 'in' : 'out of'} the lists`)
        return true
      },
    },
  }

  const names = Object.keys(ops)
  const weighted = names.flatMap((name) => Array.from({ length: ops[name].weight }, () => name))
  return {
    // One random operation at phase `at`; returns its name.
    step(at: number): string {
      phase = at
      for (let attempt = 0; attempt < 40; attempt += 1) {
        const name = rng.pick(weighted)
        if (ops[name].run()) { counts[name] = (counts[name] ?? 0) + 1; return name }
        trail.pop()
      }
      return 'none'
    },
    // After a sequence: nothing but phases base and base + 1 changed, and the lists of earlier phases are what they were.
    finish() {
      phase = base
      same(initial.docs.filter((doc) => doc.phaseNo !== base && doc.phaseNo !== base + 1), state.docs.filter((doc) => doc.phaseNo !== base && doc.phaseNo !== base + 1), 'a document of another phase changed')
      for (let earlier = 0; earlier < base; earlier += 1) same(merged(initial, earlier), merged(state, earlier), `the lists of phase ${earlier} changed`)
    },
    state: () => state,
  }
}

const startState = (rng: Rng, empty: boolean): State => {
  const generated = genCase(rng, { reachable: true, density: 0.3 })
  return { captures: generated.captures, docs: empty ? [] : generated.docs }
}

describe('the write builders keep to the spec', () => {
  const findings = newFindings()
  const counts = newCounts()

  it('one operation on a random state (3000 cases), at phase N or N + 1', () => {
    for (let seed = 1; seed <= 3000; seed += 1) {
      const rng = makeRng(seed * 7919)
      const initial = startState(rng, rng.chance(0.2))
      const base = rng.int(8)
      const run = makeRun(seed, initial, base, rng, findings, counts)
      run.step(rng.chance(0.6) ? base : base + 1)
      run.finish()
    }
  })

  it('sequences of 2 to 6 operations across phases N and N + 1 (3000 cases)', () => {
    for (let seed = 1; seed <= 3000; seed += 1) {
      const rng = makeRng(seed * 104729 + 17)
      const initial = startState(rng, rng.chance(0.4))
      const base = rng.int(8)
      const run = makeRun(100_000 + seed, initial, base, rng, findings, counts)
      const length = 2 + rng.int(5)
      for (let index = 0; index < length; index += 1) run.step(rng.chance(0.5) ? base : base + 1)
      run.finish()
    }
    // every kind of operation was exercised many times
    for (const name of ['addItems', 'takeOffItem', 'restoreItem', 'takeOffThenRestore', 'addCreature', 'setCreatureRemoved', 'renameCreature', 'moveCreature', 'addZone', 'editZone', 'setZoneInPhase', 'setFollows', 'tickEveryZone']) {
      assert.ok((counts[name] ?? 0) > 400, `coverage: ${name} ran ${counts[name] ?? 0} times`)
    }
    if (process.env.FUZZ_VERBOSE) {
      console.log(`builders: operations ${JSON.stringify(counts)}; renames that pin an unchanged attribute ${findings.renamePinsUnchanged.length}; moves out of order in a tie ${findings.moveWithTies.length} (${findings.moveWithTiesFromCaptures.length} in runs that started from the captures alone)`)
      console.log([...findings.moveWithTies.slice(0, 2), ...findings.renamePinsUnchanged.slice(0, 2)].join('\n'))
    }
  })

  // ---- Boundaries and keys

  it('addItems stops at 80 added items in one phase and says so; 80 exactly is allowed', () => {
    const capture: LootTableCapture = { format: 1, zoneId: 5, name: 'Test Hollow', kind: 'dungeon', players: 5, source: 'https://example.test', capturedAt: '2026-10-16', sources: [{ npcId: 1, name: 'Ash', kind: 'boss', itemIds: [1] }], zoneWideItemIds: [] }
    const full: SourceTableDoc = { id: 's5_npc1_1', type: 'source', zoneId: 5, key: 'npc1', phaseNo: 1, itemIds: Array.from({ length: 79 }, (_, index) => 1000 + index), hiddenItemIds: [], rev: 1 }
    const zone = mergeTables([capture], [full], 1)[0]
    const ash = zone.sources[0]
    const one = addItems(zone, ash, [5000])
    assert.equal(one.tooMany, false)
    assert.equal((one.write as { changes: { itemIds: number[] } }).changes.itemIds.length, 80)
    const two = addItems(zone, ash, [5000, 5001])
    assert.equal(two.tooMany, true)
    assert.equal(two.write, null)
    assert.deepEqual(two.added, [])
  })

  it('a key from newCreatureKey is a valid key for a creature the guild adds, and a zone number from newZoneId is in the custom range and free', () => {
    const rng = makeRng(77)
    seeded(rng, () => {
      for (let index = 0; index < 2000; index += 1) {
        const key = newCreatureKey()
        assert.match(key, /^c[A-Za-z0-9]{1,29}$/)
        assert.ok(key !== 'zonewide' && !/^npc[0-9]+$/.test(key))
        const taken = [50_000_000 + rng.int(20), 99_999_990 + rng.int(9)]
        const zoneId = newZoneId(taken)
        assert.ok(zoneId >= 50_000_000 && zoneId <= 99_999_999 && !taken.includes(zoneId))
      }
    })
  })

  // ---- Todo tests: what the tests above found and left out of the assertions

  it('renaming a creature writes only the name (and changing only the kind writes only the kind), so a later change of the other in an earlier phase still reaches this phase', () => {
    // Spec, "A document says only what its phase changes ... a creature's name, kind ... appear in a document only when that phase sets them. This is what
    // makes 'same unless changed' true for attributes too." editZone writes only what changed; renameCreature writes both.
    const capture: LootTableCapture = { format: 1, zoneId: 5, name: 'Test Hollow', kind: 'dungeon', players: 5, source: 'https://example.test', capturedAt: '2026-10-16', sources: [{ npcId: 1, name: 'Ash', kind: 'boss', itemIds: [1] }], zoneWideItemIds: [] }
    const first: SourceTableDoc = { id: 's5_cq1_1', type: 'source', zoneId: 5, key: 'cq1', phaseNo: 1, name: 'Bog', kind: 'boss', order: 30, itemIds: [], hiddenItemIds: [], rev: 1 }
    const zone = mergeTables([capture], [first, { id: 'p2', type: 'phase', phaseNo: 2, follows: 1, rev: 1 }], 2)[0]
    const bog = zone.sources.find((candidate) => candidate.key === 'cq1')!
    const write = renameCreature(zone, bog, 'Bog the Elder', 'boss') // only the name changes
    assert.ok(write && 'create' in write)
    assert.equal((write as { create: Record<string, unknown> }).create.kind, undefined)
  })

  it('moveCreature puts a creature exactly one place off even when the place it hands over is shared, which two edits in two phases can cause', () => {
    // Only the editor's own writes are used. Capture creatures sit at places 10, 20, 30: Ash, Dusk, Cinder.
    const capture: LootTableCapture = {
      format: 1, zoneId: 5, name: 'Test Hollow', kind: 'dungeon', players: 5, source: 'https://example.test', capturedAt: '2026-10-16',
      sources: [{ npcId: 1, name: 'Ash', kind: 'boss', itemIds: [1] }, { npcId: 2, name: 'Dusk', kind: 'boss', itemIds: [2] }, { npcId: 3, name: 'Cinder', kind: 'boss', itemIds: [3] }], zoneWideItemIds: [],
    }
    let docs: LootTableDoc[] = [{ id: 'p2', type: 'phase', phaseNo: 2, follows: 1, rev: 1 }] // phase 2 follows phase 1
    const move = (phaseNo: number, key: string, direction: -1 | 1) => {
      const zone = mergeTables([capture], docs, phaseNo)[0]
      for (const write of moveCreature(zone, zone.sources.find((candidate) => candidate.key === key)!, direction)) docs = applyWrite(docs, write)
    }
    const order = (phaseNo: number) => mergeTables([capture], docs, phaseNo)[0].sources.map((candidate) => candidate.name)
    move(2, 'npc2', -1) // the next phase: Dusk above Ash (Dusk 10, Ash 20)
    move(1, 'npc2', 1) // the current phase: Dusk below Cinder (Cinder 20, Dusk 30); phase 2 now has Ash and Cinder both at 20
    assert.deepEqual(order(2), ['Dusk', 'Ash', 'Cinder'])
    move(2, 'npc2', 1) // Dusk one place down, below Ash: it takes Ash's 20 and Cinder (also 20) comes first by name
    assert.deepEqual(order(2), ['Ash', 'Dusk', 'Cinder'])
  })
})
