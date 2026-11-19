// DISCORD-002: one-way raid announcements and reminders in a Discord channel, through a webhook kept as a Function secret (functions/index.js reads it
// at run time and passes it in; it is never logged or stored). A raid that is scheduled, changed or cancelled gets one message, which every later change
// edits; a 5-minute sweep posts the 24-hour and 1-hour reminders and retries what failed. What to post is decided in functions/discordPosts.js.
//
// The state of each raid's post is a server-only document, guilds/{guildId}/discordAnnouncements/{raidId} (no rule matches it, so no client can read or
// write it): the message id, what was last posted, which reminders were sent, the last error and when the sweep should look again (`dueAt`). A lease in
// it keeps two runs from posting the same raid twice; a run that finds the lease taken marks the document so the holder looks again before it lets go.
//
// Nothing here throws out of a trigger or the sweep: a Discord failure is recorded and retried by the sweep, and never touches the raid.
import { randomUUID } from 'node:crypto'
import { FieldValue, Timestamp } from 'firebase-admin/firestore'
import { logger as functionsLogger } from 'firebase-functions'
import {
  announcementPayload, dueReminders, nextDueAt, parseWebhook, payloadHash, planAnnouncement, readRaid, reminderPayload,
  retryDelay, sameAnnouncement, siteAddress, withoutImage, wouldAnnounce, zoneImageUrl,
} from './discordPosts.js'

const COLLECTION = 'discordAnnouncements'
/** A run holds the raid for at most this long; a run that dies is picked up by the sweep once it has passed. */
const LEASE = 3 * 60_000
/** At most this many passes in one run when the raid keeps changing while it posts. */
const MAX_ROUNDS = 3
const REQUEST_TIMEOUT = 10_000
/** A rate limit this short is waited out in the same run; a longer one is left to the sweep. */
const MAX_INLINE_WAIT = 5_000
const SWEEP_LIMIT = 50
const SWEEP_BUDGET = 240_000

const stateRef = (db, guildId, raidId) => db.collection('guilds').doc(guildId).collection(COLLECTION).doc(raidId)
const millis = (value) => (typeof value?.toMillis === 'function' ? value.toMillis() : null)
const stamp = (value) => (value === null || value === undefined ? null : Timestamp.fromMillis(value))
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

/** The options both functions run with, from the secret's value at run time. With no valid webhook address, `webhook` is null and nothing is posted. */
export function discordOptions(secretValue, env = process.env) {
  const allowLocal = env.FUNCTIONS_EMULATOR === 'true'
  const webhook = parseWebhook(secretValue, { allowLocal })
  if (!webhook && typeof secretValue === 'string' && secretValue.trim() && secretValue.trim().toLowerCase() !== 'off') {
    functionsLogger.warn('DISCORD_WEBHOOK_URL is not a Discord webhook address, so Discord posts are off.')
  }
  let projectId = env.GCLOUD_PROJECT
  if (!projectId && env.FIREBASE_CONFIG) {
    try { projectId = JSON.parse(env.FIREBASE_CONFIG).projectId } catch { projectId = undefined }
  }
  return { webhook, siteUrl: siteAddress(projectId), allowLocal }
}

// The state as plain values, as the planning in discordPosts.js reads it. A message posted through another webhook (the secret was changed to another
// channel) is not this channel's: the raid is treated as not yet announced there.
function readState(data, hook) {
  const sameHook = data?.webhookId === hook.id
  const reminder = (record) => (record && Number.isFinite(record.startsAtMillis) ? { startsAtMillis: record.startsAtMillis } : null)
  return {
    messageId: sameHook && typeof data?.messageId === 'string' ? data.messageId : null,
    postedAtMillis: sameHook ? millis(data?.postedAt) : null,
    postedHash: sameHook && typeof data?.posted?.hash === 'string' ? data.posted.hash : null,
    reminders: { day: reminder(data?.reminders?.day), hour: reminder(data?.reminders?.hour) },
    failures: Number.isInteger(data?.failures) ? data.failures : 0,
  }
}

const blankState = (raidId) => ({
  schemaVersion: 1, raidId, webhookId: null, messageId: null, postedAt: null, posted: null,
  reminders: { day: null, hour: null }, lastError: null, failures: 0, dueAt: null, lease: null, dirty: false,
})

// Takes the raid for this run. Returns null when there is nothing to do: the raid is gone, or it has never been announced and would not be now (cancelled,
// started, no start time), in which case no state document is created. Returns 'busy' when another run holds it.
async function claim(db, guildId, raidId, hook, now) {
  const ref = stateRef(db, guildId, raidId)
  const raidRef = db.collection('guilds').doc(guildId).collection('raids').doc(raidId)
  return db.runTransaction(async (tx) => {
    const [raidSnap, stateSnap] = await Promise.all([tx.get(raidRef), tx.get(ref)])
    const raid = readRaid(raidSnap.data())
    const stored = stateSnap.data()
    if (!stored && (!raid || !wouldAnnounce(raid, now))) return null
    if (!raid) {
      tx.update(ref, { dueAt: null, updatedAt: FieldValue.serverTimestamp() })
      return null
    }
    if (stored && millis(stored.lease?.until) > now) {
      tx.update(ref, { dirty: true, updatedAt: FieldValue.serverTimestamp() })
      return 'busy'
    }
    const lease = { id: randomUUID(), until: Timestamp.fromMillis(now + LEASE) }
    // Until the run records its result, the sweep looks again once the lease has passed, so a run that dies is not forgotten.
    tx.set(ref, { ...(stored ? {} : blankState(raidId)), lease, dirty: false, dueAt: lease.until, updatedAt: FieldValue.serverTimestamp() }, { merge: true })
    return lease
  })
}

// Reads the seconds Discord asks to wait from a 429: the body's retry_after, else the Retry-After header.
async function retryAfter(response) {
  let seconds = null
  try {
    const body = await response.json()
    if (typeof body?.retry_after === 'number') seconds = body.retry_after
  } catch { /* an unreadable body falls back to the header */ }
  if (seconds === null) {
    const header = Number(response.headers.get('retry-after'))
    if (Number.isFinite(header)) seconds = header
  }
  return seconds === null || seconds < 0 ? null : Math.ceil(seconds * 1000)
}

// One request to the webhook: a new message (with ?wait=true, so Discord answers with the message and its id) or an edit of `messageId`. Never throws;
// the result is { ok: true, id } or { ok: false, code, status, retryAfterMs }. The error codes never contain the address.
async function send(hook, payload, messageId, { request, sleep }) {
  const url = messageId ? `${hook.url}/messages/${messageId}` : `${hook.url}?wait=true`
  for (let attempt = 0; ; attempt += 1) {
    let response
    try {
      response = await request(url, {
        method: messageId ? 'PATCH' : 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
        redirect: 'error',
        signal: AbortSignal.timeout(REQUEST_TIMEOUT),
      })
    } catch (error) {
      return { ok: false, code: error?.name === 'TimeoutError' ? 'timeout' : 'network', status: null }
    }
    if (response.status === 429) {
      const wait = await retryAfter(response)
      if (wait !== null && wait <= MAX_INLINE_WAIT && attempt < 2) {
        await sleep(wait)
        continue
      }
      return { ok: false, code: 'rate-limited', status: 429, retryAfterMs: wait }
    }
    if (!response.ok) {
      await response.body?.cancel().catch(() => {})
      return { ok: false, code: response.status === 404 ? 'not-found' : 'http', status: response.status }
    }
    let data = null
    try { data = await response.json() } catch { data = null }
    if (typeof data?.id !== 'string' || !/^[0-9]{1,25}$/.test(data.id) || (messageId && data.id !== messageId)) {
      return { ok: false, code: 'invalid-receipt', status: response.status }
    }
    return { ok: true, id: data.id }
  }
}

// The raid's post: an edit of its message, or a new one when it has none or Discord no longer has it (404: someone deleted it). A post with a picture that
// Discord refuses (400) goes again without the picture, so a picture can never keep the announcement out.
async function deliverAnnouncement(hook, payload, messageId, io) {
  let created = !messageId
  let result = await send(hook, payload, messageId, io)
  if (!result.ok && result.code === 'not-found' && messageId) {
    created = true
    result = await send(hook, payload, null, io)
  }
  let image = Boolean(payload.embeds[0].image)
  if (!result.ok && result.status === 400 && image) {
    image = false
    result = await send(hook, withoutImage(payload), created ? null : messageId, io)
  }
  return { ...result, created, image }
}

const errorRecord = (now, during, result) => ({ at: Timestamp.fromMillis(now), during, code: result.code, status: result.status ?? null })

// One pass: reads the raid, its state and the zone pictures, posts or edits the announcement if it changed, sends the reminders that are due, and returns
// what to record. Never throws for Discord; a Firestore read error is left to the caller.
async function round(db, guildId, raidId, options, now) {
  const { webhook: hook, siteUrl, allowLocal } = options
  const guild = db.collection('guilds').doc(guildId)
  const [raidSnap, stateSnap, zoneArtSnap] = await Promise.all([
    guild.collection('raids').doc(raidId).get(), stateRef(db, guildId, raidId).get(), guild.collection('settings').doc('zoneArt').get(),
  ])
  const raid = readRaid(raidSnap.data())
  if (!raid) return { raid: null, changes: {}, failure: null, actions: [] }
  const state = readState(stateSnap.data(), hook)
  const imageUrl = zoneImageUrl(zoneArtSnap.data(), guildId, raid.zones[0]?.id, { allowLocal })
  const payload = announcementPayload(raid, { siteUrl, imageUrl })
  const hash = payloadHash(payload)
  const changes = {}
  const actions = []
  let failure = null
  let retryAfterMs = null
  const action = planAnnouncement(raid, state, now, hash)
  if (action !== 'none') {
    const result = await deliverAnnouncement(hook, payload, action === 'edit' ? state.messageId : null, options)
    if (result.ok) {
      actions.push(result.created ? 'posted' : 'edited')
      Object.assign(changes, {
        webhookId: hook.id, messageId: result.id,
        posted: { hash, payload, image: result.image, status: raid.status, startsAtMillis: raid.startsAtMillis, at: Timestamp.fromMillis(now) },
      })
      if (result.created) changes.postedAt = Timestamp.fromMillis(now)
      state.messageId = result.id
      if (result.created) state.postedAtMillis = now
    } else {
      failure = errorRecord(now, action === 'edit' ? 'edit' : 'post', result)
      retryAfterMs = result.retryAfterMs ?? null
    }
  }
  if (!failure) {
    const { send: kinds, skip } = dueReminders(raid, state, now)
    // A reminder record is always written whole, so a sent reminder never keeps the `skipped` of an earlier start.
    const mark = (kind, fields) => {
      changes[`reminders.${kind}`] = { startsAtMillis: raid.startsAtMillis, sentAt: null, messageId: null, skipped: false, ...fields }
      state.reminders[kind] = { startsAtMillis: raid.startsAtMillis }
    }
    for (const kind of skip) mark(kind, { skipped: true })
    for (const kind of kinds) {
      const result = await send(hook, reminderPayload(raid, kind, { siteUrl }), null, options)
      if (!result.ok) {
        failure = errorRecord(now, `reminder-${kind}`, result)
        retryAfterMs = result.retryAfterMs ?? null
        break
      }
      actions.push(`reminded-${kind}`)
      mark(kind, { sentAt: Timestamp.fromMillis(now), messageId: result.id })
    }
  }
  return { raid, state, changes, failure, retryAfterMs, actions }
}

// Records a pass. Returns true when the raid changed while it was posting (another run marked the document), so the run should look again.
async function record(db, guildId, raidId, lease, outcome, now, again) {
  const ref = stateRef(db, guildId, raidId)
  return db.runTransaction(async (tx) => {
    const stored = (await tx.get(ref)).data()
    if (!stored) return false
    const ours = stored.lease?.id === lease.id
    const rerun = ours && stored.dirty === true && again
    // Changed again during the last pass this run may make: the next sweep posts that change.
    const leftover = ours && stored.dirty === true && !again
    const failures = outcome.failure ? (Number.isInteger(stored.failures) ? stored.failures : 0) + 1 : 0
    // A minute early, so the sweep that runs at the retry time finds it; never before Discord's own retry_after.
    const retryAt = outcome.failure ? now + Math.max(retryDelay(failures) - 60_000, outcome.retryAfterMs ?? 0, 60_000) : null
    const due = leftover ? now : outcome.raid ? nextDueAt(outcome.raid, outcome.state, now, retryAt) : null
    const fields = { ...outcome.changes, lastError: outcome.failure, failures, dueAt: stamp(due), updatedAt: FieldValue.serverTimestamp() }
    if (ours) Object.assign(fields, { lease: rerun ? { id: lease.id, until: Timestamp.fromMillis(now + LEASE) } : null, dirty: false })
    tx.update(ref, fields)
    return rerun
  })
}

/**
 * Brings one raid's Discord post up to date: posts or edits the announcement and sends the reminders that are due. Returns what it did ('off', 'nothing',
 * 'busy' or the list of actions). `options`: { webhook, siteUrl, allowLocal, clock, request, sleep, logger }; tests pass a fake Discord and a fixed clock.
 */
export async function syncRaidAnnouncement(db, guildId, raidId, options) {
  if (!options.webhook) return 'off'
  const io = { request: options.request ?? fetch, sleep: options.sleep ?? pause }
  const log = options.logger ?? functionsLogger
  const clock = options.clock ?? Date.now
  const lease = await claim(db, guildId, raidId, options.webhook, clock())
  if (lease === null) return 'nothing'
  if (lease === 'busy') return 'busy'
  const actions = []
  for (let pass = 1; ; pass += 1) {
    const now = clock()
    const outcome = await round(db, guildId, raidId, { ...options, ...io }, now)
    actions.push(...outcome.actions)
    if (outcome.failure) {
      log.warn('A Discord raid post failed; the sweep will retry it.', { guildId, raidId, during: outcome.failure.during, code: outcome.failure.code, status: outcome.failure.status })
    }
    if (!(await record(db, guildId, raidId, lease, outcome, now, pass < MAX_ROUNDS))) break
  }
  if (actions.length) log.info('Discord raid post updated.', { guildId, raidId, actions })
  return actions
}

/** The raid trigger: on a write that changes what the post shows, brings the post up to date. Never throws, so the trigger is never retried. */
export async function handleRaidWrite(db, { guildId, raidId, before, after }, options) {
  try {
    if (!options.webhook || !after) return 'off'
    if (before && sameAnnouncement(before, after)) return 'unchanged'
    return await syncRaidAnnouncement(db, guildId, raidId, options)
  } catch (error) {
    ;(options.logger ?? functionsLogger).error('A Discord raid post could not be checked.', { guildId, raidId, code: error?.code ?? error?.name ?? 'unknown' })
    return 'error'
  }
}

/**
 * The 5-minute sweep: every raid whose post is due (a reminder, a retry, or a run that did not finish), at most 50 a run. Never throws; one raid's
 * failure does not stop the others.
 */
export async function runDiscordSweep(db, options) {
  if (!options.webhook) return { checked: 0 }
  const log = options.logger ?? functionsLogger
  const clock = options.clock ?? Date.now
  const started = Date.now()
  let due
  try {
    due = await db.collectionGroup(COLLECTION).where('dueAt', '<=', Timestamp.fromMillis(clock())).orderBy('dueAt').limit(SWEEP_LIMIT).get()
  } catch (error) {
    log.error('The Discord sweep could not list due raids.', { code: error?.code ?? error?.name ?? 'unknown' })
    return { checked: 0 }
  }
  let checked = 0
  for (const doc of due.docs) {
    const guild = doc.ref.parent.parent
    if (!guild || guild.parent.id !== 'guilds') continue
    try {
      await syncRaidAnnouncement(db, guild.id, doc.id, options)
    } catch (error) {
      log.error('A Discord raid post could not be checked.', { guildId: guild.id, raidId: doc.id, code: error?.code ?? error?.name ?? 'unknown' })
    }
    checked += 1
    if (Date.now() - started > SWEEP_BUDGET) break
  }
  return { checked }
}
