import { useMemo, useState } from 'react'
import { saveZoneColors, writeLootTables } from '../../guildApi'
import type { CandidateZone, ItemEvidence } from '../../shared/game/dropsString'
import type { TableWrite } from '../../shared/game/guildTables'
import { dropTables as builtIn } from '../../shared/lib/dropTables'
import { isMissingItem, useItemInfo } from '../../shared/lib/itemInfo'
import type { TabContext } from '../../shared/tabs/types'
import { ItemTooltip } from '../../shared/ui/ItemTooltip'
import {
  JOURNAL_ITEMS_SAVED, applyWrites, buildImportSave, importReason, importStoppedText, journalReason, noAnswers, takenZoneIds, type CreatureRow, type ImportAnswers,
  type ImportSetup, type ItemRow, type ZoneRow,
} from './dropImport'
import {
  answerSameAs, answerSubject, chooseZone, colorMadeZones, confirmHolds, creatureBlockKey, confirmLabel, countsLine, countsText, journalToTick, keptColorText, madeZonesWritten, nextPhaseHint, nothingToSave, plural, previewOf, readFileText, readPaste,
  sameAsValue, tickItem, tickJournal, zoneChip, zoneOpen, zoneSelects, type ConfirmFor,
} from './dropImportView'
import './DropImport.css'

// "Import a drop list" (LOOT-008, docs/design/drop-list-import.md section 7), at the top of Edit the drop lists. A leader pastes the addon's drops
// strings (/im drops) or a capture file, answers what isn't clear, and saves into the phase picked in the editor, in one confirm. The browser reads the
// text itself and never stores it. dropImport.ts does the matching and builds the writes; this holds the answers and runs the save.

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']
const shortDate = (date: string) => `${MONTHS[Number(date.slice(5, 7)) - 1] ?? ''} ${Number(date.slice(8, 10))}`

function evidenceText(evidence: ItemEvidence, trash: boolean): string[] {
  const parts: string[] = []
  const seen = evidence.seen
  if (seen) parts.push(`${seen.via === 'roll' ? 'rolled for' : 'seen'} ${seen.n === 1 ? 'once' : `${seen.n} times`}, last ${shortDate(seen.last)}`)
  if (evidence.ej) parts.push("the game's journal lists it")
  if (evidence.journal) parts.push(seen || evidence.capture ? 'DungeonJournal lists it' : 'DungeonJournal lists it, not seen in the game')
  if (evidence.capture) parts.push('in the capture file')
  if (seen?.quest) parts.push('starts a quest')
  if (trash && seen?.boe) parts.push('may be a world drop')
  return parts
}

function statusText(row: ItemRow, phase: string): string | undefined {
  switch (row.status) {
    case 'already': return 'already listed'
    case 'elsewhere': return `on ${row.where}`
    case 'takenOff': return 'taken off by a leader'
    case 'claimed': return `under ${row.where} in this import`
    case 'zoneWide': return 'offered for the zone-wide list'
    case 'noRoom': return `no room left in ${phase}: the next phase can add it`
    default: return undefined
  }
}

type Answering = { ticks: (id: string, value: boolean) => void; answers: ImportAnswers; update: (next: ImportAnswers) => void; busy: boolean; phase: string }

function ItemLine({ row, creature, trash, set }: { row: ItemRow; creature: CreatureRow; trash: boolean; set: Answering }) {
  const state = useItemInfo(row.itemId)
  const gameName = row.evidence.seen?.name
  const status = statusText(row, set.phase)
  const notes = [...evidenceText(row.evidence, trash), ...(status ? [status] : [])]
  return <li className={`import-item${row.tickable ? '' : ' import-item-off'}`}>
    {row.tickable
      ? <input type="checkbox" checked={row.ticked} disabled={set.busy} aria-label={`Add item ${gameName ?? row.itemId}`} onChange={(event) => set.update(tickItem(set.answers, creature, row, event.target.checked))} />
      : <span className="import-tick-space" aria-hidden="true" />}
    <ItemTooltip itemId={row.itemId} {...(gameName ? { fallbackName: gameName } : {})} />
    {isMissingItem(state) && <small className="import-note">not on Wowhead yet</small>}
    {state?.status === 'error' && !isMissingItem(state) && <small className="import-note tables-bad">{state.message}</small>}
    {notes.length > 0 && <small className="import-note">{notes.join('; ')}</small>}
  </li>
}

function CreatureBlock({ zone, row, set }: { zone: ZoneRow; row: CreatureRow; set: Answering }) {
  const journal = journalToTick(row)
  const chips = [
    row.kind === 'zonewide' ? 'zone-wide' : row.kind,
    ...(row.npcId !== undefined ? [`NPC ${row.npcId}`] : []),
    ...(row.status === 'new' ? ['new'] : []),
    ...(row.guessed ? ['guessed from the encounter'] : []),
    ...(row.status === 'takenOut' ? [`taken out of ${set.phase}`] : []),
  ]
  return <section className={`import-creature${row.saved ? '' : ' import-creature-off'}`}>
    <header>
      {row.creatureTickable
        ? <label className="import-creature-name"><input type="checkbox" checked={row.saved} disabled={set.busy} aria-label={row.status === 'takenOut' ? `Bring back ${row.name}` : `Add ${row.name}`} onChange={(event) => set.ticks(row.id, event.target.checked)} /><strong>{row.name}</strong></label>
        : <strong className="import-creature-name">{row.name}</strong>}
      {chips.map((chip) => <span key={chip} className="drops-kind">{chip}</span>)}
    </header>
    {row.near.length > 0 && zone.status !== 'unmatched' && <label className="import-answer">Same as
      <select value={sameAsValue(row)} disabled={set.busy} onChange={(event) => set.update(answerSameAs(set.answers, row, event.target.value))}>
        <option value="">Choose</option>
        {row.near.map((option) => <option key={option.key} value={option.key}>{option.name}</option>)}
        <option value="new">A new creature</option>
      </select>
    </label>}
    {row.differs && <label className="import-answer import-check"><input type="checkbox" checked={row.rename} disabled={set.busy} onChange={(event) => set.update({ ...set.answers, renames: { ...set.answers.renames, [row.id]: event.target.checked } })} />
      Rename to {row.differs.name ?? row.name}{row.differs.kind ? ` (${row.differs.kind})` : ''}</label>}
    <ul className="import-items">{row.items.map((item) => <ItemLine key={item.id} row={item} creature={row} trash={row.kind === 'trash'} set={set} />)}</ul>
    {journal.length > 0 && <button type="button" className="button button-secondary tables-small" disabled={set.busy} onClick={() => set.update(tickJournal(set.answers, row))}>Tick DungeonJournal&rsquo;s {plural(journal.length, 'item', 'items')}</button>}
  </section>
}

function ZoneBlock({ zone, candidates, setup, set, canMake }: { zone: ZoneRow; candidates: CandidateZone[]; setup: ImportSetup; set: Answering; canMake: boolean }) {
  const choose = (answerKey: string, value: string) => set.update(chooseZone(set.answers, answerKey, value, answerSubject(answerKey, candidates), takenZoneIds(setup)))
  const chip = zoneChip(zone, set.phase)
  const unmatchedWhy = zone.unmatchedWhy === 'tie' ? 'More than one zone has this name.' : zone.unmatchedWhy === 'catalog' ? "It's in the older raid list, which can't hold drop lists." : undefined
  return <details className={`import-zone import-${zone.status}`} open={zoneOpen(zone)}>
    <summary>
      <strong>{zone.status === 'new' ? zone.name : zone.appName ?? zone.name}</strong>
      <span>{zone.players}-player {zone.kind}</span>
      {zone.appName && <span className="import-note">as {zone.name} in the paste</span>}
      {chip && <span className={chip.added ? 'drops-kind tables-added' : 'drops-kind'}>{chip.text}</span>}
    </summary>
    <div className="import-zone-body">
      {zoneSelects(zone).map(({ answerKey, label }) => {
        const answer = set.answers.zones[answerKey]
        return <label key={answerKey} className="import-answer">{label}
          <select value={answer ? ('pick' in answer ? String(answer.pick) : 'new') : ''} disabled={set.busy} onChange={(event) => choose(answerKey, event.target.value)}>
            <option value="">Choose</option>
            {zone.options.map((option) => <option key={option.zoneId} value={option.zoneId}>{option.name} ({option.players}-player {option.kind})</option>)}
            {canMake && <option value="new">Make a new zone</option>}
          </select>
        </label>
      })}
      {unmatchedWhy && <p className="import-note">{unmatchedWhy}</p>}
      {zone.status === 'new' && <p className="import-note">{zone.kind === 'raid' && [10, 20, 40].includes(zone.players) ? 'A zone is permanent, and a raid of this size can be scheduled.' : 'A zone is permanent.'}</p>}
      {zone.takenOut && <label className="import-answer import-check"><input type="checkbox" checked={zone.zoneTicked} disabled={set.busy} onChange={(event) => set.ticks(zone.tickKey, event.target.checked)} />Put it back in {set.phase}</label>}
      {zone.journalPartial && <p className="import-note">DungeonJournal calls its list for this dungeon incomplete.</p>}
      {zone.creatures.map((creature) => <CreatureBlock key={creatureBlockKey(creature)} zone={zone} row={creature} set={set} />)}
    </div>
  </details>
}

// `nextPhase` is the next phase's name, given only when the phase picked is the current (live) one.
export function DropImportPanel({ live, phaseNo, phase, nextPhase }: { live: TabContext; phaseNo: number; phase: string; nextPhase?: string }) {
  const [text, setText] = useState('')
  const [answers, setAnswers] = useState<ImportAnswers>(noAnswers)
  const [confirm, setConfirm] = useState<ConfirmFor | null>(null)
  const [message, setMessage] = useState<{ text: string; error: boolean } | null>(null)
  const { busy, setBusy, setMutationError } = live.feedback
  const docs = live.data.lootTables
  const paste = useMemo(() => readPaste(text), [text])
  const setup: ImportSetup = useMemo(() => ({
    captures: builtIn, docs, catalog: live.data.raidZoneCatalog, currentPhase: live.data.settings.phaseHistory?.length ?? 0, phaseNo,
    journalSaving: JOURNAL_ITEMS_SAVED, canMakeZones: live.identity.canEditRoster,
  }), [docs, live.data.raidZoneCatalog, live.data.settings.phaseHistory, phaseNo, live.identity.canEditRoster])
  const built = useMemo(() => (paste && 'zones' in paste ? previewOf(paste.zones, setup, answers) : null), [paste, setup, answers])
  const preview = built && 'preview' in built ? built.preview : null
  const pasteErrors = paste && 'errors' in paste ? paste.errors : built && 'errors' in built ? built.errors : []
  const previewing = live.identity.isPreviewing
  const counts = preview?.counts
  const nothing = nothingToSave(counts)
  const hint = counts ? nextPhaseHint(counts, phase, nextPhase) : undefined
  // The confirm step is for one phase and one text: picking another phase in the editor or loading a file closes it, and going back doesn't reopen it.
  const confirming = confirmHolds(confirm, phaseNo, text)
  if (confirm && !confirming) setConfirm(null)

  const update = (next: ImportAnswers) => { setAnswers(next); setConfirm(null) }
  const set: Answering = { answers, update, busy, phase, ticks: (id, value) => update({ ...answers, ticks: { ...answers.ticks, [id]: value } }) }

  async function save() {
    if (!preview || !paste || !('zones' in paste) || live.identity.isPreviewing) return // VIEW AS never saves
    const plan = buildImportSave(preview, setup)
    // The second call is built from the documents as the first leaves them, so the whole save is known before anything is sent.
    const second = plan.second(applyWrites(docs, plan.first))
    const total = plan.first.length + second.ticks.length + second.journal.reduce((sum, call) => sum + call.writes.length, 0)
    const who = { uid: live.identity.uid, displayName: live.identity.displayName }
    const reason = importReason(paste.from, paste.ids)
    let written = 0
    const madeWritten: number[] = [] // zones the first call made whose document has landed
    let keptColor = 0 // zones the import made that keep the automatic color: their colors couldn't be saved
    setBusy(true)
    setConfirm(null)
    try {
      const count = (ids: string[]) => { written += ids.length; madeWritten.push(...madeZonesWritten(plan.made, ids, setup.phaseNo)) }
      const write = (writes: TableWrite[], why: string) => (writes.length ? writeLootTables(writes, who, count, why) : Promise.resolve())
      try {
        await write(plan.first, reason)
      } finally {
        // A zone the import made gets a suggested color, as one made in Settings does (Guild Leaders), once its document has landed, also when a later batch
        // failed; on Save again, one an earlier save made gets its color if it has none. If that fails, it keeps the automatic color.
        if (setup.canMakeZones) keptColor = await colorMadeZones([...plan.madeBefore, ...madeWritten], setup, live.data.zoneColors, (colors) => saveZoneColors(colors, { uid: live.identity.uid }))
      }
      await write(second.ticks, reason)
      for (const call of second.journal) await write(call.writes, journalReason(call.versions)) // each version of DungeonJournal with its own reason
      setMutationError('')
      setMessage({ text: `Saved to ${phase}: ${countsText(preview.counts)}.${keptColor ? ` ${keptColorText(keptColor)}` : ''}`, error: false })
      setText('')
      setAnswers(noAnswers())
    } catch (error) {
      const stale = (error as { code?: string } | null)?.code === 'permission-denied'
      const why = stale ? 'The change was refused: someone may have changed the same list a moment ago, or the phase may have just started.' : error instanceof Error ? error.message : 'The save stopped.'
      setMessage({ text: importStoppedText(written, Math.max(0, total - written), why, keptColor ? keptColorText(keptColor) : ''), error: true })
    } finally {
      setBusy(false)
    }
  }

  return <details className="tables-import">
    <summary><span className="tables-zones-title">Import a drop list</span></summary>
    <div className="tables-import-inner">
      <div className="tables-add">
        <label>Drops strings from the addon, or a capture file
          <textarea value={text} rows={3} disabled={busy} placeholder="IM1:drops:j:..." onChange={(event) => { setText(event.target.value); setAnswers(noAnswers()); setConfirm(null); setMessage(null) }} />
        </label>
        <label className="import-file">Or a capture file<input type="file" accept=".json,application/json,.txt,text/plain" disabled={busy} onChange={(event) => {
          const file = event.target.files?.[0]
          if (file) void readFileText(file).then((read) => {
            if ('error' in read) { setMessage({ text: read.error, error: true }); return }
            setText(read.text); setAnswers(noAnswers()); setConfirm(null); setMessage(null)
          })
          event.target.value = ''
        }} /></label>
      </div>
      {pasteErrors.length > 0 && <ul className="tables-message tables-bad import-errors" role="alert">{pasteErrors.map((error) => <li key={error}>{error}</li>)}</ul>}
      {paste && 'zones' in paste && paste.skipped > 0 && <p className="import-note">{plural(paste.skipped, 'row of the string could', 'rows of the string could')} not be read and {paste.skipped === 1 ? 'is' : 'are'} left out.</p>}
      {preview && <>
        {preview.zones.map((zone) => <ZoneBlock key={zone.id} zone={zone} candidates={paste && 'zones' in paste ? paste.zones : []} setup={setup} set={set} canMake={setup.canMakeZones} />)}
        <div className="tables-setup-foot">
          <span className="tables-note">{counts ? countsLine(counts, preview.zones, phase) : ''}</span>
          <span className="tables-actions">
            {!confirming && <button type="button" className="button button-primary tables-small" disabled={busy || previewing || nothing} onClick={() => setConfirm({ phaseNo, text })}>Save to {phase}</button>}
            {confirming && <>
              <button type="button" className="button button-secondary tables-small" disabled={busy} onClick={() => setConfirm(null)}>Cancel</button>
              <button type="button" className="button button-primary tables-small" disabled={busy || previewing || nothing} onClick={() => void save()}>{counts ? confirmLabel(phase, counts) : 'Save'}</button>
            </>}
          </span>
        </div>
        {confirming && hint && <p className="import-note">{hint}</p>}
        {previewing && <p className="import-note">Saving is off in VIEW AS.</p>}
      </>}
      {message && <p className={message.error ? 'tables-message tables-bad' : 'tables-message'} role={message.error ? 'alert' : 'status'}>{message.text}</p>}
    </div>
  </details>
}
