import { createHash } from 'node:crypto'
import { isDeepStrictEqual } from 'node:util'
import { FieldValue, Timestamp } from 'firebase-admin/firestore'
import { logger } from 'firebase-functions'

const captureStatuses = ['accept', 'tentative', 'absent', 'late', 'bench']
const groupsBySize = { 10: ['blue', 'yellow', 'red', 'white'], 20: ['green', 'pink'], 40: ['brown'] }
const sizes = Object.keys(groupsBySize).map(Number)
const pageSize = 450
const maxRecordBytes = 700 * 1024
const maxCatchupMillis = 7 * 24 * 60 * 60 * 1000
const jobPageSize = 100
const easternTimeZone = 'America/New_York'

class PermanentAuditError extends Error {
  constructor(message, scheduledStartAt) {
    super(message)
    this.name = 'PermanentAuditError'
    this.code = 'invalid-raid-audit-history'
    this.scheduledStartAt = scheduledStartAt
  }
}

class PermanentCaptureError extends Error {
  constructor(code, message, scheduledStartAt) {
    super(message)
    this.name = 'PermanentCaptureError'
    this.code = code
    this.scheduledStartAt = scheduledStartAt
  }
}

const snapshotRef = (raidRef) => raidRef.collection('snapshots').doc('start')
const failureId = (raidId, startMillis) => createHash('sha256').update(`${raidId}:${startMillis}`).digest('hex')
const failureRef = (guildRef, raidId, startMillis) => guildRef.collection('raidSnapshotFailures').doc(failureId(raidId, startMillis))
const jobRef = (guildRef, raidId) => guildRef.collection('raidSnapshotJobs').doc(raidId)
const toMillis = (value) => value instanceof Timestamp ? value.toMillis() : undefined
const isObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value)
const stringOrNull = (value) => typeof value === 'string' ? value : null
const easternFormatter = new Intl.DateTimeFormat('en-CA', {
  timeZone: easternTimeZone, year: 'numeric', month: '2-digit', day: '2-digit',
  hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
})

function easternDate(value) {
  const parts = Object.fromEntries(easternFormatter.formatToParts(value.toDate()).map(({ type, value: part }) => [type, part]))
  return `${parts.year}-${parts.month}-${parts.day}`
}

function dateOffset(date, days) {
  const shifted = new Date(`${date}T12:00:00Z`)
  shifted.setUTCDate(shifted.getUTCDate() + days)
  return shifted.toISOString().slice(0, 10)
}

function easternBoundary(date) {
  const wallClock = Date.parse(`${date}T21:00:00Z`)
  for (const offsetHours of [4, 5]) {
    const candidate = Timestamp.fromMillis(wallClock + offsetHours * 60 * 60 * 1000)
    if (easternDate(candidate) === date) {
      const parts = Object.fromEntries(easternFormatter.formatToParts(candidate.toDate()).map(({ type, value }) => [type, value]))
      if (parts.hour === '21' && parts.minute === '00') return candidate
    }
  }
  throw new Error(`Could not resolve the 9:00 PM Eastern boundary for ${date}.`)
}

export function initialSnapshotCheckpoint(now) {
  return Timestamp.fromMillis(easternBoundary(dateOffset(easternDate(now), -1)).toMillis() - 1)
}

export function nextSnapshotExecution(now) {
  const date = easternDate(now)
  const today = easternBoundary(date)
  return today.toMillis() > now.toMillis() ? today : easternBoundary(dateOffset(date, 1))
}

function normalize(value) {
  if (value instanceof Timestamp) return { timestampMillis: value.toMillis() }
  if (Array.isArray(value)) return value.map(normalize)
  if (isObject(value)) return Object.fromEntries(Object.keys(value).sort().map((key) => [key, normalize(value[key])]))
  return value
}

function contentHash(value) {
  return createHash('sha256').update(JSON.stringify(normalize(value))).digest('hex')
}

function changedFields(audit) {
  if (!Array.isArray(audit.changed) || !isObject(audit.before) || !isObject(audit.after)) {
    throw new Error('Raid audit history is malformed.')
  }
  return audit.changed
}

function applyAudit(state, audit, fields) {
  const next = { ...state }
  for (const field of fields) {
    const value = audit.after[field]
    if (value === null || value === undefined) delete next[field]
    else next[field] = value
  }
  return next
}

function reverseAudit(state, audit, fields) {
  const previous = { ...state }
  for (const field of fields) {
    const value = audit.before[field]
    if (value === null || value === undefined) delete previous[field]
    else previous[field] = value
  }
  return previous
}

async function raidAudits(tx, guildRef, raidId, raid) {
  const revision = raid.rev ?? 0
  const scheduledStartAt = raid.startsAt instanceof Timestamp ? raid.startsAt : undefined
  if (!Number.isSafeInteger(revision) || revision < 0) throw new PermanentAuditError('Raid revision is malformed.', scheduledStartAt)
  if (revision === 0) return []
  const refs = Array.from({ length: revision }, (_, index) => guildRef.collection('auditLog').doc(`raid_${raidId}_${index + 1}`))
  const docs = []
  for (let index = 0; index < refs.length; index += 100) {
    const snapshots = await Promise.all(refs.slice(index, index + 100).map((ref) => tx.get(ref)))
    docs.push(...snapshots)
  }
  if (docs.some((entry) => !entry.exists)) throw new PermanentAuditError('Raid audit history is incomplete.', scheduledStartAt)
  const audits = docs.map((entry) => entry.data()).sort((left, right) => left.rev - right.rev)
  let previousAt = -Infinity
  for (let index = 0; index < audits.length; index++) {
    const audit = audits[index]
    if (!Number.isSafeInteger(audit.rev) || audit.rev !== index + 1 || !(audit.at instanceof Timestamp)
      || audit.at.toMillis() < previousAt || !Array.isArray(audit.changed)
      || audit.changed.some((field) => typeof field !== 'string') || new Set(audit.changed).size !== audit.changed.length
      || !isObject(audit.before) || !isObject(audit.after)) {
      throw new PermanentAuditError('Raid audit history is malformed or out of order.', scheduledStartAt)
    }
    previousAt = audit.at.toMillis()
  }
  return audits
}

function dueRaidVersion(raid, audits, now) {
  let initial = { ...raid }
  for (let index = audits.length - 1; index >= 0; index--) {
    const audit = audits[index]
    initial = reverseAudit(initial, audit, changedFields(audit))
  }

  const intervals = []
  let state = initial
  let from = raid.createdAt instanceof Timestamp ? raid.createdAt.toMillis() : 0
  for (const audit of audits) {
    const at = audit.at.toMillis()
    intervals.push({ state, from, to: at })
    state = applyAudit(state, audit, changedFields(audit))
    from = at
  }
  intervals.push({ state, from, to: now.toMillis() + 1 })

  // The version in effect at its start is due unless it was cancelled. A raid marked complete (RAID-019) was started, so it is captured like any started raid: the rules
  // allow 'complete' only once the start has passed, so the version at the start is normally still 'scheduled', and a 'complete' one (written outside the app) counts too.
  const candidates = intervals.flatMap(({ state: version, from: start, to: end }) => {
    const scheduledStartAt = version.startsAt
    const millis = toMillis(scheduledStartAt)
    if (millis === undefined || millis > now.toMillis() || start > millis || millis > end
      || (version.status && !['scheduled', 'complete'].includes(version.status))) return []
    return [{ version, scheduledStartAt }]
  })
  candidates.sort((left, right) => left.scheduledStartAt.toMillis() - right.scheduledStartAt.toMillis())
  return candidates[0]
}

function assertDocumentSize(path, value, scheduledStartAt) {
  if (Buffer.byteLength(JSON.stringify(normalize(value)), 'utf8') > maxRecordBytes) {
    throw new PermanentCaptureError('snapshot-record-too-large', `Snapshot record at ${path} is too large to store safely.`, scheduledStartAt)
  }
}

function validatePlan(plan, raidVersion, scheduledStartAt) {
  if (!plan || plan.schemaVersion !== 1 || !Number.isSafeInteger(plan.revision) || plan.revision < 1
    || !Array.isArray(plan.invitations) || !Array.isArray(plan.lineups)) {
    throw new PermanentCaptureError('invalid-working-roster', 'RAID-011 working roster is missing or invalid.', scheduledStartAt)
  }
  if (raidVersion.zones !== undefined && !Array.isArray(raidVersion.zones)) {
    throw new PermanentCaptureError('invalid-raid-details', 'Scheduled raid lineup sizes are invalid.', scheduledStartAt)
  }
  const zones = raidVersion.zones ?? []
  const usedSizes = [...new Set(zones.length ? zones.map((zone) => zone?.size) : [raidVersion.size])]
  if (!usedSizes.length || usedSizes.some((size) => !sizes.includes(size))) {
    throw new PermanentCaptureError('invalid-raid-sizes', 'The scheduled raid has invalid lineup sizes.', scheduledStartAt)
  }
  if (typeof raidVersion.name !== 'string' || typeof raidVersion.date !== 'string'
    || (raidVersion.time !== undefined && (typeof raidVersion.time !== 'string' || !/^([01]\d|2[0-3]):[0-5]\d$/.test(raidVersion.time)))
    || !sizes.includes(raidVersion.size)
    || zones.some((zone) => !zone || typeof zone.id !== 'string' || typeof zone.name !== 'string' || !sizes.includes(zone.size))) {
    throw new PermanentCaptureError('invalid-raid-details', 'Scheduled raid details are invalid and cannot be snapshotted.', scheduledStartAt)
  }

  const lineups = []
  for (const size of usedSizes) {
    const matches = plan.lineups.filter((entry) => entry?.size === size)
    if (matches.length !== 1 || !Array.isArray(matches[0].teams) || !Array.isArray(matches[0].bench)) {
      throw new PermanentCaptureError('invalid-working-roster', `RAID-011 working roster has no unique valid ${size}-player lineup.`, scheduledStartAt)
    }
    const lineup = matches[0]
    if (lineup.teams.length !== groupsBySize[size].length
      || groupsBySize[size].some((key) => lineup.teams.filter((team) => team?.key === key).length !== 1)) {
      throw new PermanentCaptureError('invalid-working-roster', `RAID-011 ${size}-player team groups are incomplete or duplicated.`, scheduledStartAt)
    }
    const placed = new Set()
    const teams = lineup.teams.map((team) => {
      if (!team || typeof team.key !== 'string' || typeof team.name !== 'string' || !Array.isArray(team.characterIds)
        || team.characterIds.some((characterId) => typeof characterId !== 'string' || !characterId || characterId.includes('/') || characterId.length > 1500)) {
        throw new PermanentCaptureError('invalid-working-roster', `RAID-011 ${size}-player team data is invalid.`, scheduledStartAt)
      }
      for (const characterId of team.characterIds) {
        if (placed.has(characterId)) throw new PermanentCaptureError('invalid-working-roster', `Character ${characterId} appears more than once in the ${size}-player lineup.`, scheduledStartAt)
        placed.add(characterId)
      }
      return { key: team.key, name: team.name, characterIds: [...team.characterIds] }
    })
    if (lineup.bench.some((characterId) => typeof characterId !== 'string' || !characterId || characterId.includes('/') || characterId.length > 1500)) {
      throw new PermanentCaptureError('invalid-working-roster', `RAID-011 ${size}-player bench data is invalid.`, scheduledStartAt)
    }
    for (const characterId of lineup.bench) {
      if (placed.has(characterId)) throw new PermanentCaptureError('invalid-working-roster', `Character ${characterId} appears more than once in the ${size}-player lineup.`, scheduledStartAt)
      placed.add(characterId)
    }
    lineups.push({ size, teams, bench: [...lineup.bench] })
  }

  const invitations = []
  const invitedUids = new Set()
  for (const invitation of plan.invitations) {
    if (!invitation || typeof invitation.uid !== 'string' || !invitation.uid || invitation.uid.includes('/') || invitation.uid.length > 1500
      || typeof invitation.mainId !== 'string' || !invitation.mainId || invitation.mainId.includes('/') || invitation.mainId.length > 1500
      || invitedUids.has(invitation.uid)) {
      throw new PermanentCaptureError('invalid-working-roster', 'RAID-011 invitation data is invalid.', scheduledStartAt)
    }
    invitedUids.add(invitation.uid)
    invitations.push({ uid: invitation.uid, mainId: invitation.mainId })
  }
  return { lineups, invitations }
}

function buildSnapshotSource({ raidId, raidVersion, scheduledStartAt, plan, signups, roster, members }) {
  const validated = validatePlan(plan, raidVersion, scheduledStartAt)
  if (!(plan.updatedAt instanceof Timestamp)) {
    throw new PermanentCaptureError('invalid-working-roster', 'RAID-011 working roster has no trusted update timestamp.', scheduledStartAt)
  }
  if (plan.updatedAt.toMillis() > scheduledStartAt.toMillis()) {
    throw new PermanentCaptureError('working-roster-changed-after-start', 'RAID-011 working roster changed after its scheduled start; the original lineup cannot be reconstructed safely.', scheduledStartAt)
  }
  const rosterById = new Map(roster.docs.map((entry) => [entry.id, entry.data()]))
  const membersById = new Map(members.docs.map((entry) => [entry.id, entry.data()]))
  const signupsByUid = new Map()
  for (const entry of signups.docs) {
    const response = entry.data()
    if (!entry.id || entry.id.includes('/') || entry.id.length > 1500 || typeof response.characterId !== 'string' || !response.characterId || response.characterId.includes('/') || response.characterId.length > 1500
      || !captureStatuses.includes(response.status)
      || (response.benchKind !== undefined && response.benchKind !== 'self')) {
      throw new PermanentCaptureError('invalid-signup-data', `Signup data for ${entry.id || '(unknown account)'} is invalid.`, scheduledStartAt)
    }
    if (response.updatedAt instanceof Timestamp && response.updatedAt.toMillis() > scheduledStartAt.toMillis()) {
      throw new PermanentCaptureError('signup-changed-after-start', `Signup for ${entry.id} changed after the scheduled start and cannot be reconstructed safely.`, scheduledStartAt)
    }
    signupsByUid.set(entry.id, {
      characterId: response.characterId,
      status: response.status,
      ...(response.benchKind === 'self' ? { benchKind: 'self' } : {}),
    })
  }

  const accountInputs = new Map()
  for (const [invitationOrder, invitation] of validated.invitations.entries()) {
    accountInputs.set(invitation.uid, { invited: true, invitationOrder, invitationMainId: invitation.mainId })
  }
  for (const uid of signupsByUid.keys()) {
    if (!accountInputs.has(uid)) accountInputs.set(uid, { invited: false, invitationOrder: null, invitationMainId: null })
  }

  const characterIds = new Set()
  for (const lineup of validated.lineups) {
    for (const team of lineup.teams) for (const characterId of team.characterIds) characterIds.add(characterId)
    for (const characterId of lineup.bench) characterIds.add(characterId)
  }
  for (const account of accountInputs.values()) {
    if (account.invitationMainId) characterIds.add(account.invitationMainId)
  }
  for (const response of signupsByUid.values()) characterIds.add(response.characterId)

  const characters = [...characterIds].sort().map((characterId) => {
    const character = rosterById.get(characterId)
    if (!character) throw new PermanentCaptureError('missing-character', `Character ${characterId} referenced by the working roster or signup is missing.`, scheduledStartAt)
    if (characterId.includes('/')) throw new PermanentCaptureError('invalid-character-id', `Character id ${characterId} is not a valid document id.`, scheduledStartAt)
    const placements = []
    for (const lineup of validated.lineups) {
      for (const team of lineup.teams) {
        if (team.characterIds.includes(characterId)) placements.push({ size: lineup.size, teamKey: team.key, teamName: team.name, bench: false })
      }
      if (lineup.bench.includes(characterId)) placements.push({ size: lineup.size, teamKey: null, teamName: null, bench: true })
    }
    return {
      id: characterId,
      name: stringOrNull(character.name),
      surname: stringOrNull(character.surname),
      className: stringOrNull(character.className),
      specialization: stringOrNull(character.specialization),
      role: stringOrNull(character.role),
      mainId: stringOrNull(character.mainId),
      accountUid: stringOrNull(character.linkedUid),
      placements,
    }
  })

  const accounts = [...accountInputs.entries()].sort(([left], [right]) => left.localeCompare(right)).map(([uid, invite]) => ({
    uid,
    displayName: stringOrNull(membersById.get(uid)?.displayName),
    invited: invite.invited,
    invitationOrder: invite.invitationOrder,
    invitationMainId: invite.invitationMainId,
    signup: signupsByUid.get(uid) ?? null,
  }))
  const lineups = validated.lineups.map((lineup) => ({
    size: lineup.size,
    teams: lineup.teams,
    bench: lineup.bench,
  }))
  const raid = {
    id: raidId,
    name: stringOrNull(raidVersion.name),
    date: stringOrNull(raidVersion.date),
    time: raidVersion.time ?? '21:00',
    description: stringOrNull(raidVersion.description),
    size: raidVersion.size,
    zones: Array.isArray(raidVersion.zones) ? raidVersion.zones : [],
  }
  const source = { raid, scheduledStartAt, lineups, characters, accounts }
  for (const lineup of lineups) assertDocumentSize(`lineups/${lineup.size}`, lineup, scheduledStartAt)
  for (const character of characters) assertDocumentSize(`characters/${character.id}`, character, scheduledStartAt)
  for (const account of accounts) assertDocumentSize(`accounts/${account.uid}`, account, scheduledStartAt)
  return source
}

function recordsFor(raidRef, source) {
  const root = snapshotRef(raidRef)
  return [
    ...source.lineups.map((data) => ({ ref: root.collection('lineups').doc(String(data.size)), data })),
    ...source.characters.map((data) => ({ ref: root.collection('characters').doc(data.id), data })),
    ...source.accounts.map((data) => ({ ref: root.collection('accounts').doc(data.uid), data })),
  ]
}

async function writeRecords(db, records) {
  for (let index = 0; index < records.length; index += pageSize) {
    const page = records.slice(index, index + pageSize)
    const batch = db.batch()
    for (const record of page) batch.create(record.ref, record.data)
    try {
      await batch.commit()
    } catch (error) {
      const existing = await db.getAll(...page.map((record) => record.ref))
      if (existing.some((entry, recordIndex) => !entry.exists || !isDeepStrictEqual(entry.data(), page[recordIndex].data))) {
        if (existing.some((entry) => entry.exists)) {
          throw new PermanentCaptureError('snapshot-record-conflict', 'An incomplete snapshot already contains conflicting immutable records.')
        }
        throw error
      }
    }
  }
}

const checkpointRef = (db) => db.collection('system').doc('raidStartSnapshotSweep')

async function getCheckpoint(db, now) {
  const ref = checkpointRef(db)
  await db.runTransaction(async (tx) => {
    const current = await tx.get(ref)
    if (!current.exists) {
      tx.create(ref, { coveredThrough: initialSnapshotCheckpoint(now), updatedAt: FieldValue.serverTimestamp() })
    }
  })
  const checkpoint = await ref.get()
  const value = checkpoint.data()?.coveredThrough
  if (!(value instanceof Timestamp)) throw new Error('Raid snapshot sweep checkpoint is malformed.')
  return value
}

async function advanceCheckpoint(db, previous, coveredThrough) {
  await db.runTransaction(async (tx) => {
    const ref = checkpointRef(db)
    const current = await tx.get(ref)
    if (!current.exists || !(current.data().coveredThrough instanceof Timestamp)) {
      throw new Error('Raid snapshot sweep checkpoint disappeared or is malformed.')
    }
    if (current.data().coveredThrough.isEqual(previous)) {
      tx.update(ref, { coveredThrough, updatedAt: FieldValue.serverTimestamp() })
    }
  })
}

async function queueCandidate(db, guildRef, raidId, now) {
  const ref = jobRef(guildRef, raidId)
  return db.runTransaction(async (tx) => {
    const existing = await tx.get(ref)
    if (existing.exists && ['failed', 'complete'].includes(existing.data().state)) {
      if (existing.data().state === 'failed') return { ref, queued: false }
      const manifest = await tx.get(snapshotRef(guildRef.collection('raids').doc(raidId)))
      if (manifest.exists && manifest.data().status === 'complete') return { ref, queued: false }
    }
    const data = {
      raidId,
      state: 'pending',
      nextAttemptAt: now,
      updatedAt: FieldValue.serverTimestamp(),
      ...(existing.exists ? {} : { discoveredAt: FieldValue.serverTimestamp() }),
    }
    if (existing.exists) tx.set(ref, data, { merge: true })
    else tx.create(ref, data)
    return { ref, queued: true }
  })
}

async function markJob(db, ref, state, now, detail) {
  const update = {
    state,
    updatedAt: FieldValue.serverTimestamp(),
    ...(state === 'pending'
      ? { nextAttemptAt: nextSnapshotExecution(now), lastAttemptAt: FieldValue.serverTimestamp(), lastError: detail.slice(0, 500) }
      : { completedAt: FieldValue.serverTimestamp() }),
  }
  await ref.set(update, { merge: true })
}

async function recordFailure(db, guildRef, raidRef, raidId, scheduledStartAt, error, workRef) {
  const failureKey = scheduledStartAt instanceof Timestamp ? scheduledStartAt.toMillis() : 'audit-history'
  const ref = failureRef(guildRef, raidId, failureKey)
  const detail = error.message.slice(0, 500)
  await db.runTransaction(async (tx) => {
    const reads = [tx.get(ref), tx.get(snapshotRef(raidRef))]
    if (workRef) reads.push(tx.get(workRef))
    const [failure, manifest, work] = await Promise.all(reads)
    if (!failure.exists) {
      tx.create(ref, {
        raidId,
        ...(scheduledStartAt instanceof Timestamp ? { scheduledStartAt } : {}),
        code: error.code ?? 'snapshot-capture-failed',
        detail,
        failedAt: FieldValue.serverTimestamp(),
      })
    }
    if (workRef && work?.exists) {
      tx.update(workRef, { state: 'failed', failureCode: error.code ?? 'snapshot-capture-failed', completedAt: FieldValue.serverTimestamp() })
    }
    if (scheduledStartAt instanceof Timestamp && manifest.exists && manifest.data().status === 'capturing'
      && manifest.data().scheduledStartAt?.isEqual(scheduledStartAt)) {
      tx.update(snapshotRef(raidRef), { status: 'failed', failureCode: error.code ?? 'snapshot-capture-failed', failedAt: FieldValue.serverTimestamp() })
    }
  })
  logger.error('Raid start snapshot capture failed permanently.', {
    guildId: guildRef.id,
    raidId,
    scheduledStartAt: scheduledStartAt instanceof Timestamp ? scheduledStartAt.toDate().toISOString() : undefined,
    code: error.code ?? 'snapshot-capture-failed',
    detail,
  })
}

async function prepareCapture(db, guildRef, raidRef, raidId, now) {
  return db.runTransaction(async (tx) => {
    const manifest = await tx.get(snapshotRef(raidRef))
    if (manifest.exists && manifest.data().status === 'complete') return { status: 'complete' }
    if (manifest.exists && manifest.data().status === 'failed') return { status: 'terminal-failure' }
    const [raidDoc, planDoc] = await Promise.all([tx.get(raidRef), tx.get(raidRef.collection('planning').doc('working'))])
    if (!raidDoc.exists) throw new PermanentAuditError('Raid referenced by the snapshot work record no longer exists.')
    const raid = raidDoc.data()
    const audits = await raidAudits(tx, guildRef, raidId, raid)
    const due = dueRaidVersion(raid, audits, now)
    if (!due) return { status: 'not-due' }
    const scheduledStartAt = due.scheduledStartAt
    const failure = await tx.get(failureRef(guildRef, raidId, scheduledStartAt.toMillis()))
    if (failure.exists) return { status: 'terminal-failure' }
    if (!planDoc.exists) {
      throw new PermanentCaptureError('missing-working-roster', 'RAID-011 working roster is missing; standing assignments are never used as a fallback.', scheduledStartAt)
    }
    const [signups, roster, members] = await Promise.all([
      tx.get(raidRef.collection('signups')), tx.get(guildRef.collection('roster')), tx.get(guildRef.collection('members')),
    ])
    const source = buildSnapshotSource({
      raidId,
      raidVersion: due.version,
      scheduledStartAt,
      plan: planDoc.data(),
      signups,
      roster,
      members,
    })
    const hash = contentHash(source)
    const existing = manifest.data()
    if (existing) {
      if (existing.status !== 'capturing' || !existing.scheduledStartAt?.isEqual(scheduledStartAt) || existing.contentHash !== hash) {
        throw new PermanentCaptureError('snapshot-source-changed', 'Snapshot source changed while an incomplete capture was being retried.', scheduledStartAt)
      }
      return { status: 'resume', source, hash, manifest: existing }
    }
    const createdAt = Timestamp.now()
    tx.create(snapshotRef(raidRef), {
      schemaVersion: 1,
      status: 'capturing',
      raidId,
      raid: source.raid,
      scheduledStartAt,
      contentHash: hash,
      lineupSizes: source.lineups.map((lineup) => lineup.size),
      counts: { lineups: source.lineups.length, characters: source.characters.length, accounts: source.accounts.length },
      createdAt,
    })
    return { status: 'capture', source, hash }
  })
}

export async function captureRaidStartSnapshot(db, guildRef, raidRef, raidId, now = Timestamp.now(), workRef) {
  let scheduledStartAt
  try {
    const prepared = await prepareCapture(db, guildRef, raidRef, raidId, now)
    if (['complete', 'terminal-failure', 'missing-raid', 'not-due'].includes(prepared.status)) return prepared.status === 'terminal-failure' ? 'skipped' : prepared.status
    scheduledStartAt = prepared.source?.scheduledStartAt
      ?? prepared.manifest?.scheduledStartAt
    if (!scheduledStartAt) {
      const manifest = await snapshotRef(raidRef).get()
      scheduledStartAt = manifest.data()?.scheduledStartAt
    }
    await writeRecords(db, recordsFor(raidRef, prepared.source))
    await db.runTransaction(async (tx) => {
      const ref = snapshotRef(raidRef)
      const current = await tx.get(ref)
      if (!current.exists) throw new Error('Snapshot manifest disappeared during capture.')
      const data = current.data()
      if (data.status === 'complete') return
      if (data.status !== 'capturing' || data.contentHash !== prepared.hash) {
        throw new PermanentCaptureError('snapshot-manifest-conflict', 'Snapshot manifest changed before publication.', data.scheduledStartAt)
      }
      tx.update(ref, { status: 'complete', capturedAt: FieldValue.serverTimestamp() })
    })
    return 'captured'
  } catch (error) {
    if (error instanceof PermanentCaptureError || error instanceof PermanentAuditError) {
      const start = error.scheduledStartAt ?? scheduledStartAt
      await recordFailure(db, guildRef, raidRef, raidId, start, error, workRef)
      return 'failed'
    }
    logger.error('Raid start snapshot capture will be retried by a later sweep.', {
      guildId: guildRef.id,
      raidId,
      scheduledStartAt: scheduledStartAt?.toDate?.().toISOString(),
      error: error instanceof Error ? error.message : String(error),
    })
    return 'retry'
  }
}

async function processJob(db, ref, now) {
  const guildRef = ref.parent.parent
  const raidId = ref.id
  const raidRef = guildRef.collection('raids').doc(raidId)
  const result = await captureRaidStartSnapshot(db, guildRef, raidRef, raidId, now, ref)
  if (result === 'captured' || result === 'complete') {
    await markJob(db, ref, 'complete', now, '')
  } else if (result === 'not-due' || result === 'missing-raid') {
    await markJob(db, ref, 'complete', now, '')
  } else if (result === 'failed' || result === 'skipped') {
    await markJob(db, ref, 'failed', now, '')
  } else {
    await markJob(db, ref, 'pending', now, 'Transient failure; retrying on the next scheduled execution.')
    logger.error('Raid snapshot work remains pending after a transient failure.', { guildId: guildRef.id, raidId })
  }
  return result
}

async function safelyProcessJob(db, ref, now) {
  try {
    return await processJob(db, ref, now)
  } catch (error) {
    logger.error('Raid snapshot work could not be finalized and remains discoverable for retry.', {
      guildId: ref.parent.parent.id,
      raidId: ref.id,
      error: error instanceof Error ? error.message : String(error),
    })
    return 'retry'
  }
}

async function pendingJobs(db, now, process, onResult) {
  let query = db.collectionGroup('raidSnapshotJobs')
    .where('state', '==', 'pending')
    .where('nextAttemptAt', '<=', now)
    .orderBy('nextAttemptAt')
    .limit(jobPageSize)
  let last = null
  while (true) {
    const page = await (last ? query.startAfter(last) : query).get()
    if (page.empty) return
    for (const snapshot of page.docs) {
      if (!process.has(snapshot.ref.path)) {
        process.add(snapshot.ref.path)
        onResult(await safelyProcessJob(db, snapshot.ref, now))
      }
    }
    if (page.size < jobPageSize) return
    last = page.docs[page.docs.length - 1]
  }
}

export async function runRaidStartSnapshotSweep(db, now = Timestamp.now()) {
  const checkpoint = await getCheckpoint(db, now)
  if (now.toMillis() < checkpoint.toMillis()) throw new Error('Raid snapshot sweep clock is earlier than its checkpoint.')
  const scanEnd = Timestamp.fromMillis(Math.min(now.toMillis(), checkpoint.toMillis() + maxCatchupMillis))
  const [raidsInWindow, auditsInWindow] = await Promise.all([
    db.collectionGroup('raids').where('startsAt', '>', checkpoint).where('startsAt', '<=', scanEnd).get(),
    db.collectionGroup('auditLog').where('targetType', '==', 'raid')
      .where('at', '>', checkpoint).where('at', '<=', scanEnd).get(),
  ])
  const candidates = new Map()
  for (const snapshot of raidsInWindow.docs) candidates.set(snapshot.ref.path, snapshot.ref)
  for (const audit of auditsInWindow.docs) {
    const guildRef = audit.ref.parent.parent
    const raidId = audit.data().targetId
    if (guildRef && typeof raidId === 'string' && raidId && !raidId.includes('/')) {
      const ref = guildRef.collection('raids').doc(raidId)
      candidates.set(ref.path, ref)
    }
  }

  const queued = new Map()
  let allCandidatesDurable = true
  for (const raidRef of candidates.values()) {
    const guildRef = raidRef.parent.parent
    try {
      const result = await queueCandidate(db, guildRef, raidRef.id, scanEnd)
      if (result.queued) queued.set(result.ref.path, result.ref)
    } catch (error) {
      allCandidatesDurable = false
      logger.error('Could not persist raid snapshot work; retaining the previous checkpoint.', {
        guildId: guildRef.id,
        raidId: raidRef.id,
        error: error instanceof Error ? error.message : String(error),
      })
    }
  }

  const processed = new Set()
  const results = { captured: 0, failed: 0, retry: 0, skipped: 0 }
  const countResult = (result) => {
    if (result === 'captured') results.captured++
    else if (result === 'failed') results.failed++
    else if (result === 'retry') results.retry++
    else results.skipped++
  }
  for (const ref of queued.values()) {
    processed.add(ref.path)
    countResult(await safelyProcessJob(db, ref, now))
  }
  await pendingJobs(db, now, processed, countResult)
  if (allCandidatesDurable) await advanceCheckpoint(db, checkpoint, scanEnd)

  logger.info('Raid start snapshot daily sweep finished.', {
    candidates: candidates.size,
    ...results,
    checkpointAdvanced: allCandidatesDurable,
    coveredThrough: scanEnd.toDate().toISOString(),
  })
  return { ...results, candidates: candidates.size, checkpointAdvanced: allCandidatesDurable }
}
