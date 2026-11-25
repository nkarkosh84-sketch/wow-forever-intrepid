import { useState } from 'react'
import { writeLootTables } from '../../guildApi'
import {
  GAME_ID_MAX, TABLE_ITEMS_MAX, TABLE_NAME_MAX, ZONE_WIDE_KEY, addCreature, addItems, followedBy, hasText, itemHolders, moveCreature, parseItemIds, renameCreature, restoreItem,
  setCreatureRemoved, setFollows, setZoneInPhase, setZonesInPhase, takeOffItem, type LootTableDoc, type MergedSource, type MergedZone, type TableSourceKind, type TableWrite,
} from '../../shared/game/guildTables'
import { lootSourceKinds, type LootSourceKind } from '../../shared/game/lootTables'
import { phaseOptions } from '../../shared/game/phases'
import { isMissingItem, peekItem, useItemInfo, useItemInfoVersion } from '../../shared/lib/itemInfo'
import type { TabContext } from '../../shared/tabs/types'
import { ItemTooltip } from '../../shared/ui/ItemTooltip'
import '../../shared/ui/spacing.css'
import '../../shared/ui/zoneColor.css'
import { DropImportPanel } from './DropImportPanel'
import { useMergedTables } from './useDropTables'
import { useZoneColors, zoneStyle } from './useZoneColors'
import { groupZones, openGroupKeys, zonesStartOpen, type ZoneGroup } from '../../shared/game/zoneGroups'
import '../../shared/ui/zoneArt.css'
import './Tables.css'

// The editor for the drop lists of Browse drops (Guild and Raid Leaders). The lists belong to a PHASE, and a phase starts with nothing: at the top, one
// checklist of zones for the current phase and one for the next, each with a "Follows" choice (Nothing, or an earlier phase whose lists it then has, with
// its own changes on top). Below, the creatures and items of one zone of the phase picked there. The built-in lists are never changed; the guild's changes
// sit on top of them. Items can be added to a creature (by item number or Wowhead link, with the real name shown before anything is saved) and taken off
// again, and creatures can be added and moved. (A zone itself is added in Settings, under Zones.) Every change is a write with its entry in the Log (shared/game/guildTables.ts builds them,
// writeLootTables writes them). Nothing is deleted.
const kindLabel = (kind: TableSourceKind) => (kind === 'zonewide' ? 'zone-wide' : kind)
const itemName = (id: number) => { const state = peekItem(id); return state?.status === 'ready' ? state.info.name : `item ${id}` }

type Who = { uid: string; displayName: string }
// `whyNot` is what to say when there is nothing to write (a builder answers nothing when a limit is reached or the thing is already so).
type Run = (writes: TableWrite[], done: string, whyNot?: string) => Promise<boolean>

// One pasted item number, looked up live, so a wrong number shows before it is saved. Only a number Wowhead has no item for is marked wrong: when
// Wowhead could not be reached or was busy the item may well exist, so it shows why, and its tooltip offers Try again.
function PastedItem({ id, heldBy }: { id: number; heldBy?: string }) {
  const state = useItemInfo(id)
  if (isMissingItem(state)) return <li className="tables-pasted tables-bad"><span>{id}</span> {state.message}</li>
  return <li className={heldBy ? 'tables-pasted tables-held' : 'tables-pasted'}><ItemTooltip itemId={id} />{state?.status === 'error' && <span> {state.message}</span>}{heldBy && <span> already on {heldBy}, so it stays there</span>}</li>
}

function AddItems({ zone, source, busy, run }: { zone: MergedZone; source: MergedSource; busy: boolean; run: Run }) {
  useItemInfoVersion() // so that a number Wowhead does not know blocks the button as soon as the answer arrives
  const [open, setOpen] = useState(false)
  const [pasted, setPasted] = useState('')
  const [unsure, setUnsure] = useState(false)
  const parsed = parseItemIds(pasted)
  const result = addItems(zone, source, parsed.ids)
  const holders = itemHolders(zone)
  const unknown = parsed.ids.filter((id) => isMissingItem(peekItem(id)))
  const blocked = !result.write || result.tooMany || (unknown.length > 0 && !unsure)
  if (!open) return <button type="button" className="button button-secondary tables-small" onClick={() => setOpen(true)} disabled={busy}>Add items</button>
  return <div className="tables-add">
    <label>Item numbers, Wowhead links or item links from the game, one or several
      <textarea value={pasted} onChange={(event) => { setPasted(event.target.value); setUnsure(false) }} rows={2} placeholder="872, https://www.wowhead.com/forever/item=273804/..." aria-label={`Items to add to ${source.name}`} />
    </label>
    {parsed.ignored.length > 0 && <p className="tables-note">Could not read as an item: {parsed.ignored.join(', ')}</p>}
    {parsed.ids.length > 0 && <ul className="tables-preview">{parsed.ids.map((id) => <PastedItem key={id} id={id} heldBy={holders.get(id)} />)}</ul>}
    {result.tooMany && <p className="tables-note tables-bad">A creature can add at most 80 items in one phase.</p>}
    {unknown.length > 0 && <label className="tables-confirm"><input type="checkbox" checked={unsure} onChange={(event) => setUnsure(event.target.checked)} /> Add the {unknown.length} number{unknown.length === 1 ? '' : 's'} Wowhead did not recognize anyway</label>}
    <div className="tables-row-actions">
      <button type="button" className="button button-secondary tables-small" onClick={() => { setOpen(false); setPasted(''); setUnsure(false) }} disabled={busy}>Cancel</button>
      <button type="button" className="button button-primary tables-small" disabled={busy || blocked}
        onClick={async () => { if (result.write && await run([result.write], `Added ${result.added.length} ${result.added.length === 1 ? 'item' : 'items'} to ${source.name}.`)) { setOpen(false); setPasted(''); setUnsure(false) } }}>
        {result.added.length ? `Add ${result.added.length} ${result.added.length === 1 ? 'item' : 'items'}` : 'Add'}
      </button>
    </div>
  </div>
}

function Creature({ zone, source, index, count, phase, busy, run }: { zone: MergedZone; source: MergedSource; index: number; count: number; phase: string; busy: boolean; run: Run }) {
  const wide = source.key === ZONE_WIDE_KEY
  const [renaming, setRenaming] = useState(false)
  const [name, setName] = useState(source.name)
  const [kind, setKind] = useState<TableSourceKind>(source.kind)
  const rename = renameCreature(zone, source, name, kind)
  return <section className={`drops-group drops-${wide ? 'zone' : source.kind} tables-source${source.removed ? ' tables-removed' : ''}`}>
    <header>
      <h3>{source.name}</h3>
      <span className="drops-kind">{kindLabel(source.kind)}</span>
      {source.npcId !== undefined && <span className="drops-npc">NPC {source.npcId}</span>}
      {!wide && !source.builtIn && <span className="drops-kind tables-added">added by the guild</span>}
      {source.removed && <span className="drops-kind tables-added">out of {phase}</span>}
      {!wide && <span className="tables-actions">
        <button type="button" className="icon-button tables-move" aria-label={`Move ${source.name} earlier`} title="Move earlier" disabled={busy || index === 0 || source.removed} onClick={() => run(moveCreature(zone, source, -1), `${source.name} moved earlier.`, `${source.name} cannot move any earlier.`)}>{'\u2191'}</button>
        <button type="button" className="icon-button tables-move" aria-label={`Move ${source.name} later`} title="Move later" disabled={busy || index === count - 1 || source.removed} onClick={() => run(moveCreature(zone, source, 1), `${source.name} moved later.`, `${source.name} cannot move any later.`)}>{'\u2193'}</button>
        {!source.builtIn && <button type="button" className="button button-secondary tables-small" disabled={busy || source.removed} onClick={() => { setName(source.name); setKind(source.kind); setRenaming(!renaming) }}>Rename</button>}
        {!source.builtIn && !source.removed && <button type="button" className="button button-secondary tables-small" title={`Takes it out of ${phase}, and out of any phase that follows ${phase}.`} disabled={busy} onClick={() => { const write = setCreatureRemoved(zone, source, true); if (write) void run([write], `${source.name} is out of ${phase}.`) }}>Remove</button>}
        {!source.builtIn && source.removed && <button type="button" className="button button-secondary tables-small" disabled={busy} onClick={() => { const write = setCreatureRemoved(zone, source, false); if (write) void run([write], `${source.name} is back in ${phase}.`) }}>Bring back</button>}
      </span>}
    </header>
    {renaming && <div className="tables-add">
      <label>Name<input value={name} maxLength={TABLE_NAME_MAX} onChange={(event) => setName(event.target.value)} /></label>
      <label>Kind<select value={kind} onChange={(event) => setKind(event.target.value as TableSourceKind)}>{lootSourceKinds.map((option) => <option key={option} value={option}>{option}</option>)}</select></label>
      <div className="tables-row-actions">
        <button type="button" className="button button-secondary tables-small" onClick={() => setRenaming(false)} disabled={busy}>Cancel</button>
        <button type="button" className="button button-primary tables-small" disabled={busy || !rename} onClick={async () => { if (rename && await run([rename], `${source.name} renamed.`)) setRenaming(false) }}>Save</button>
      </div>
    </div>}
    <ul>
      {source.itemIds.map((id) => {
        const addedHere = source.addedItemIds.includes(id)
        return <li key={id} className={addedHere ? 'tables-item tables-item-added' : 'tables-item'}>
          <ItemTooltip itemId={id} />
          <button type="button" className="tables-chip-button" aria-label={`Take ${itemName(id)} off ${source.name}`} title={addedHere ? `Added in ${phase}. Take it back off.` : `Takes it off in ${phase}, and in any phase that follows ${phase}.`} disabled={busy}
            onClick={() => { const write = takeOffItem(zone, source, id); void run(write ? [write] : [], `${itemName(id)} taken off ${source.name} in ${phase}.`, `${itemName(id)} could not be taken off: ${phase} already takes the most items off one creature that it can (${TABLE_ITEMS_MAX}).`) }}>Take off</button>
        </li>
      })}
      {source.hiddenItemIds.map((id) => <li key={`hidden-${id}`} className="tables-item tables-item-hidden">
        <ItemTooltip itemId={id} />
        <button type="button" className="tables-chip-button" aria-label={`Bring ${itemName(id)} back to ${source.name}`} title={`Taken off in ${phase}. Bring it back.`} disabled={busy}
          onClick={() => { const write = restoreItem(zone, source, id); const holder = itemHolders(zone).get(id); void run(write ? [write] : [], `${itemName(id)} is back on ${source.name}.`, holder ? `${itemName(id)} is already on ${holder}, so it stays there.` : `${itemName(id)} could not be brought back: ${source.name} already adds the most items it can in ${phase} (${TABLE_ITEMS_MAX}).`) }}>Bring back</button>
      </li>)}
      {source.itemIds.length === 0 && source.hiddenItemIds.length === 0 && <li className="tables-empty">Nothing yet.</li>}
    </ul>
    {source.goneItemIds.length > 0 && !source.removed && <details className="tables-gone"><summary>Not in {phase} ({source.goneItemIds.length})</summary>
      <ul>{source.goneItemIds.map((id) => <li key={id} className="tables-item tables-item-hidden">
        <ItemTooltip itemId={id} />
        <button type="button" className="tables-chip-button" aria-label={`Add ${itemName(id)} back to ${source.name}`} title={`It was on ${source.name} before. Adds it back in ${phase}.`} disabled={busy}
          onClick={() => { const result = addItems(zone, source, [id]); void run(result.write ? [result.write] : [], `${itemName(id)} is back on ${source.name} in ${phase}.`, result.tooMany ? `${source.name} already adds the most items it can in ${phase} (${TABLE_ITEMS_MAX}).` : result.alreadyIn.length ? `${itemName(id)} is already on ${result.alreadyIn[0].where}, so it stays there.` : `${itemName(id)} could not be added back.`) }}>Add back</button>
      </li>)}</ul>
    </details>}
    {!source.removed && <div className="tables-foot"><AddItems zone={zone} source={source} busy={busy} run={run} /></div>}
  </section>
}

type SetupPhase = { no: number; name: string; kind: string }

// One group of the checklist (dungeons, 10-man raids, ...): a collapsible list of zones with a checkbox each, ticked when the zone is in the phase's lists.
// Whether it starts open is decided once, when the phase is picked (`startOpen`), so ticking a zone does not close or open another group under the cursor.
function ZoneGroupList({ group, phase, startOpen, colorOf, busy, run }: { group: ZoneGroup<MergedZone>; phase: SetupPhase; startOpen: boolean; colorOf: (zoneId: number) => string; busy: boolean; run: Run }) {
  const [open] = useState(startOpen)
  const chosen = group.zones.filter((zone) => zone.inPhase).length
  return <details className="tables-group" open={open}>
    <summary><span>{group.label}</span><small>{chosen} of {group.zones.length}</small></summary>
    <ul className="tables-checklist">
      {group.zones.map((zone) => <li key={zone.zoneId}><label>
        <input type="checkbox" checked={zone.inPhase} disabled={busy} onChange={(event) => { const write = setZoneInPhase(zone, event.target.checked); void run(write ? [write] : [], event.target.checked ? `${zone.name} is in ${phase.name}.` : `${zone.name} is out of ${phase.name}.`) }} />
        <span className="zone-dot" style={zoneStyle(colorOf(zone.zoneId))}>{zone.name}</span>{zone.custom && <small>added by the guild</small>}
      </label></li>)}
    </ul>
    <div className="tables-row-actions">
      <button type="button" className="button button-secondary tables-small" disabled={busy || chosen === group.zones.length} aria-label={`Tick all ${group.label}`} onClick={() => void run(setZonesInPhase(group.zones, true), `Every zone in ${group.label} is in ${phase.name}.`)}>Tick all</button>
      <button type="button" className="button button-secondary tables-small" disabled={busy || chosen === 0} aria-label={`Untick all ${group.label}`} onClick={() => void run(setZonesInPhase(group.zones, false), `No zone in ${group.label} is in ${phase.name} now.`)}>Untick all</button>
    </div>
  </details>
}

// The body of the Zones section for one phase: which earlier phase it follows, and its zones in groups. A phase starts with nothing ticked. Following a
// phase shows that phase's zones ticked too; unticking one here takes it out of this phase only. Keyed by the phase, so each phase opens its own groups.
function ZonesBody({ phase, zones, docs, earlier, colorOf, busy, run }: { phase: SetupPhase; zones: MergedZone[]; docs: LootTableDoc[]; earlier: SetupPhase[]; colorOf: (zoneId: number) => string; busy: boolean; run: Run }) {
  const follows = followedBy(docs, phase.no)
  const followed = earlier.find((option) => option.no === follows)
  const chosen = zones.filter((zone) => zone.inPhase)
  const groups = groupZones(zones)
  // Which groups start open is decided when the phase is picked; a group that was not there then (the first zone of a new size, just added) starts open.
  const [first] = useState(() => ({ keys: new Set(groups.map((group) => group.key)), open: openGroupKeys(groups, (zone) => zone.inPhase) }))
  const choose = (value: string) => {
    const next = value === '' ? undefined : Number(value)
    const write = setFollows(docs, phase.no, next)
    const target = earlier.find((option) => option.no === next)
    void run(write ? [write] : [], target ? `${phase.name} now follows ${target.name}.` : `${phase.name} follows nothing now. It has only what it says itself.`)
  }
  return <div className="tables-zones-body">
    <label className="tables-follow">{phase.name} follows
      <select value={followed ? follows : ''} onChange={(event) => choose(event.target.value)} disabled={busy || earlier.length === 0} aria-label={`What ${phase.name} follows`}>
        <option value="">Nothing</option>
        {earlier.map((option) => <option key={option.no} value={option.no}>{option.name}</option>)}
      </select>
    </label>
    <p className="tables-note">{followed
      ? `${phase.name} has the zones, creatures and items of ${followed.name}, as they stand and as they change until ${followed.name} is finished. What you change in ${phase.name} sits on top.`
      : `${phase.name} has only the zones ticked here, and the creatures and items you set for it.`}</p>
    {groups.map((group) => <ZoneGroupList key={group.key} group={group} phase={phase} startOpen={!first.keys.has(group.key) || first.open.has(group.key)} colorOf={colorOf} busy={busy} run={run} />)}
    {zones.length === 0 && <p className="tables-empty">There are no zones yet. A Guild Leader adds them in Settings, under Zones.</p>}
    {groups.length > 1 && <div className="tables-setup-foot">
      <span className="tables-note">{chosen.length} of {zones.length} zones in all</span>
      <span className="tables-actions">
        <button type="button" className="button button-secondary tables-small" disabled={busy || chosen.length === zones.length} onClick={() => void run(setZonesInPhase(zones, true), `Every zone is in ${phase.name}.`)}>Tick every zone</button>
        <button type="button" className="button button-secondary tables-small" disabled={busy || chosen.length === 0} onClick={() => void run(setZonesInPhase(zones, false), `No zone is in ${phase.name} now.`)}>Untick every zone</button>
      </span>
    </div>}
  </div>
}

// The Zones section: collapsible (it starts open only for a phase with nothing set up), with the phase to set the zones of picked inside it, so the list
// stays one phase long however many phases there are. The phase picked here is the one the creatures and items below are for as well.
function ZonesSection({ phases, selected, onPhase, zones, docs, earlier, colorOf, busy, run }: { phases: SetupPhase[]; selected: SetupPhase; onPhase: (no: number) => void; zones: MergedZone[]; docs: LootTableDoc[]; earlier: SetupPhase[]; colorOf: (zoneId: number) => string; busy: boolean; run: Run }) {
  const followed = earlier.find((option) => option.no === followedBy(docs, selected.no))
  const chosen = zones.filter((zone) => zone.inPhase).length
  const [open] = useState(() => zonesStartOpen(chosen, followed !== undefined))
  return <details className="tables-zones" open={open}>
    <summary><span className="tables-zones-title">Zones</span><span className="tables-zones-summary">{selected.name}: {chosen} of {zones.length} {zones.length === 1 ? 'zone' : 'zones'}{followed ? `, follows ${followed.name}` : ''}</span></summary>
    <div className="tables-zones-inner">
      {phases.length > 1 && <label className="tables-follow">Set the zones of
        <select className="drops-zone-select phase-select" value={selected.no} onChange={(event) => onPhase(Number(event.target.value))} disabled={busy} aria-label="Phase to set the zones of">
          {phases.map((option) => <option key={option.no} value={option.no}>{option.name} ({option.kind})</option>)}
        </select>
      </label>}
      <ZonesBody key={selected.no} phase={selected} zones={zones} docs={docs} earlier={earlier} colorOf={colorOf} busy={busy} run={run} />
    </div>
  </details>
}

export function TablesEditor({ live, phaseNo, onPhaseNo }: { live: TabContext; phaseNo: number; onPhaseNo: (no: number) => void }) {
  const { settings } = live.data
  // Only the current phase and the next one can be written (a finished phase's lists are a record).
  const everyPhase = phaseOptions(settings, true)
  const phases = everyPhase.filter((option) => option.kind !== 'past')
  const selected = phases.find((option) => option.no === phaseNo) ?? phases.find((option) => option.kind === 'current') ?? phases[0]
  const zones = useMergedTables(live.data.lootTables, selected.no)
  const zoneColors = useZoneColors(live.data.lootTables, live.data.zoneColors, live.data.zoneArt)
  const inLists = zones.filter((candidate) => candidate.inPhase)
  const [zoneId, setZoneId] = useState<number | null>(null)
  const [message, setMessage] = useState<{ text: string; error: boolean } | null>(null)
  const [newCreature, setNewCreature] = useState({ name: '', kind: 'boss' as LootSourceKind, npc: '' })
  const { busy, setBusy, setMutationError } = live.feedback
  const zone = inLists.find((candidate) => candidate.zoneId === zoneId) ?? inLists[0]
  const art = zone ? zoneColors.artOfZone(zone.zoneId) : undefined
  const who: Who = { uid: live.identity.uid, displayName: live.identity.displayName }
  const phase = selected.name
  const next = selected.kind === 'current' ? phases.find((option) => option.kind === 'next') : undefined

  // One user action is one or a few audited writes. What was written stays written if a later one fails, and the lists follow what is stored.
  async function run(writes: TableWrite[], done: string, whyNot?: string): Promise<boolean> {
    if (!writes.length) { if (whyNot) setMessage({ text: whyNot, error: true }); return false }
    setBusy(true)
    try {
      await writeLootTables(writes, who)
      setMutationError('')
      setMessage({ text: done, error: false })
      return true
    } catch (error) {
      // The rules refuse a change made from an out-of-date view (two leaders at once, or a phase that started meanwhile) with a bare permission error.
      const stale = (error as { code?: string } | null)?.code === 'permission-denied'
      setMessage({ text: stale ? 'That change was refused. Someone may have changed the same thing a moment ago, or the phase may have just started or been reopened. Close this window, open it again and retry.' : error instanceof Error ? error.message : 'Could not change the drop list.', error: true })
      return false
    } finally {
      setBusy(false)
    }
  }

  // Picking another phase (in the Zones section or above the creatures) closes what was half done for the one before.
  const changePhase = (no: number) => { onPhaseNo(no); setMessage(null) }

  const liveSources = zone ? zone.sources.filter((source) => !source.removed) : []
  const npc = newCreature.npc.trim()
  const npcValid = npc === '' || (/^\d{1,9}$/.test(npc) && Number(npc) > 0 && Number(npc) <= GAME_ID_MAX)
  const creatureReady = hasText(newCreature.name) && newCreature.name.length <= TABLE_NAME_MAX && npcValid

  return <div className="tables-editor">
    <p className="tables-intro">Drop lists are chosen per phase. A phase starts with no zones: tick the zones it has, or make it follow an earlier phase to have that phase&rsquo;s lists. What you change below is in the phase you pick and in any phase that follows it, and never reaches a finished phase. The built-in lists are not changed, every change is in the Log, and nothing is ever deleted.</p>
    <DropImportPanel live={live} phaseNo={selected.no} phase={phase} nextPhase={next?.name} />
    <ZonesSection phases={phases} selected={selected} onPhase={changePhase} zones={zones} docs={live.data.lootTables} earlier={everyPhase.filter((candidate) => candidate.no < selected.no)} colorOf={zoneColors.ofZone} busy={busy} run={run} />
    {message && <p className={message.error ? 'tables-message tables-bad' : 'tables-message'} role={message.error ? 'alert' : 'status'}>{message.text}</p>}
    <h3 className="tables-heading">Creatures and items</h3>
    <p className="tables-intro">Find an item&rsquo;s number in the address of its Wowhead page (<code>.../item=<strong>872</strong>/...</code>), or paste the whole address.</p>
    <div className="drops-controls">
      {phases.length > 1 && <select className="drops-zone-select drops-phase-select phase-select" aria-label="Phase to edit" value={selected.no} onChange={(event) => changePhase(Number(event.target.value))} disabled={busy}>
        {phases.map((option) => <option key={option.no} value={option.no}>{option.name} ({option.kind})</option>)}
      </select>}
      <select className="drops-zone-select" aria-label="Zone to edit" value={zone?.zoneId ?? ''} onChange={(event) => setZoneId(Number(event.target.value))} disabled={inLists.length === 0}>
        {inLists.map((candidate) => <option key={candidate.zoneId} value={candidate.zoneId}>{candidate.name}{candidate.custom ? ' (added by the guild)' : ''}</option>)}
        {inLists.length === 0 && <option value="">No zone in {phase}</option>}
      </select>
    </div>
    {selected.kind === 'current' && <p className="tables-live">{phase} is the live phase: everyone sees what you change here right away.{next ? ` To prepare something for later, pick ${next.name} above.` : ''}</p>}
    {!zone && <p className="drops-empty">{phase} has no zone yet. Tick one in the Zones section above. A Guild Leader adds a zone that is not in the list, in Settings under Zones.</p>}
    {zone && <>
      {art
        // A zone with a picture shows the picture and its name, nothing else.
        ? <>
          <div className="drops-intro drops-banner zone-colored zone-arted" style={zoneStyle(zoneColors.ofZone(zone.zoneId), art)} role="heading" aria-level={3}><strong className="zone-dot">{zone.name}</strong><span>{zone.players}-player {zone.kind}</span></div>
        </>
        : <div className="drops-intro zone-colored" style={zoneStyle(zoneColors.ofZone(zone.zoneId))}>
          <p><strong className="zone-dot">{zone.name}</strong>: {zone.players}-player {zone.kind}{zone.custom ? ', added by the guild.' : '. Built-in list with the guild\u2019s changes on top.'}
        </p>
        </div>}
      {zone.sources.map((source) => <Creature key={source.key} zone={zone} source={source} index={liveSources.findIndex((candidate) => candidate.key === source.key)} count={liveSources.length} phase={phase} busy={busy} run={run} />)}
      <Creature zone={zone} source={zone.zoneWide} index={0} count={1} phase={phase} busy={busy} run={run} />
      <div className="tables-add tables-new-creature">
        <h4>Add a creature to {zone.name} in {phase}</h4>
        <label>Name<input value={newCreature.name} maxLength={TABLE_NAME_MAX} onChange={(event) => setNewCreature({ ...newCreature, name: event.target.value })} /></label>
        <label>Kind<select value={newCreature.kind} onChange={(event) => setNewCreature({ ...newCreature, kind: event.target.value as LootSourceKind })}>{lootSourceKinds.map((option) => <option key={option} value={option}>{option}</option>)}</select></label>
        <label>Creature ID (optional)<small className="field-hint">The number after npc= in its Wowhead address (shown as NPC in the lists). Leave empty if you do not know it.</small><input value={newCreature.npc} inputMode="numeric" onChange={(event) => setNewCreature({ ...newCreature, npc: event.target.value })} aria-invalid={!npcValid} /></label>
        <div className="tables-row-actions">
          <button type="button" className="button button-primary tables-small" disabled={busy || !creatureReady} onClick={async () => {
            if (await run([addCreature(zone, { name: newCreature.name, kind: newCreature.kind, ...(npc ? { npcId: Number(npc) } : {}) })], `${newCreature.name.trim()} added to ${zone.name}.`)) setNewCreature({ name: '', kind: 'boss', npc: '' })
          }}>Add the creature</button>
        </div>
      </div>
    </>}
  </div>
}
