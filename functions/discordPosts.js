// DISCORD-002: the pure half of the raid announcements in Discord. functions/discord.js reads Firestore and talks to Discord; everything here is plain
// data in and out, so tests/unit runs it directly with Node. A post is built from the raid record alone (its name, start, zones, description and
// status) and the guild's zone pictures, never from members, characters or sign-ups, so no member name can be in it.
import { createHash } from 'node:crypto'

export const MINUTE = 60_000
export const HOUR = 60 * MINUTE
/** The reminders, by the time before the start they are due. The day reminder gives way to the hour reminder once that one is due. */
export const REMINDERS = [{ kind: 'day', before: 24 * HOUR }, { kind: 'hour', before: HOUR }]
/** How long after its start a raid's post still follows the raid (the same 5 hours Scheduled Raids lists it). After that nothing is posted, edited or retried. */
export const FOLLOW_AFTER_START = 5 * HOUR
/** The sweep runs this often; a failed post is retried no sooner than this, then less often, up to once an hour. */
export const SWEEP_EVERY = 5 * MINUTE
export const MAX_RETRY_DELAY = HOUR

const SCHEDULED_COLOR = 0x2f6fb0
const CANCELLED_COLOR = 0x7a8a9a
const ZWSP = '​'

/** Mentions that ping nobody: no @everyone or @here, no role, no user (the same value the backlog publisher sends, scripts/discord-backlog.ts). */
export const noMentions = () => ({ parse: [], users: [], roles: [], replied_user: false })

const DISCORD_WEBHOOK = /^https:\/\/discord(?:app)?\.com\/api(?:\/v10)?\/webhooks\/([0-9]{1,25})\/([A-Za-z0-9_.-]{1,200})$/
const LOCAL_WEBHOOK = /^http:\/\/(127\.0\.0\.1|localhost):([0-9]{2,5})\/api(?:\/v10)?\/webhooks\/([0-9]{1,25})\/([A-Za-z0-9_.-]{1,200})$/

// The address carries the webhook's token, so it is kept off the object's enumerable properties: logging or serializing the webhook shows its id only.
/** @returns {{ id: string, url: string }} */
function webhook(id, url) {
  const hook = { id }
  Object.defineProperty(hook, 'url', { value: url, enumerable: false })
  return hook
}

/**
 * The webhook from the secret's value: `{ id, url }`, with the address normalized to `https://discord.com/api/v10/webhooks/<id>/<token>`, or null when the
 * value is not a Discord webhook address (empty, "off", anything else), which turns the posts off. `allowLocal` (the Functions emulator only) also accepts
 * a fake Discord on 127.0.0.1 or localhost.
 */
export function parseWebhook(value, { allowLocal = false } = {}) {
  if (typeof value !== 'string') return null
  const trimmed = value.trim()
  const real = DISCORD_WEBHOOK.exec(trimmed)
  if (real) return webhook(real[1], `https://discord.com/api/v10/webhooks/${real[1]}/${real[2]}`)
  const local = allowLocal ? LOCAL_WEBHOOK.exec(trimmed) : null
  if (local) return webhook(local[3], `http://${local[1]}:${local[2]}/api/v10/webhooks/${local[3]}/${local[4]}`)
  return null
}

/** The site's address for a project: its Firebase Hosting address (the site has no deep links, so a post links to the site). */
export function siteAddress(projectId) {
  return typeof projectId === 'string' && /^[a-z][a-z0-9-]{4,29}$/.test(projectId) ? `https://${projectId}.web.app/` : null
}

/** Text that cannot ping: @everyone, @here and the <@user>, <@&role> and <#channel> forms get an invisible space, so they show as text. */
export function defuseMentions(text) {
  return text.replace(/@(everyone|here)/gi, `@${ZWSP}$1`).replace(/<(@[!&]?|#)/g, `<${ZWSP}$1`)
}

/** Text shown as written in a message (Discord reads markdown there): the markdown characters are escaped, except inside web addresses, which must stay links. */
export function plainText(text) {
  const escaped = text.split(/(https?:\/\/\S+)/g).map((part, index) => (index % 2 ? part : part.replace(/[\\*_~`|[\]]/g, '\\$&'))).join('')
  return defuseMentions(escaped.replace(/^([ \t]*)(-#|#|>)/gm, '$1\\$2'))
}

const clip = (text, max) => (text.length <= max ? text : `${text.slice(0, max - 1)}…`)

/**
 * The part of a raid record a post shows, or null when the raid cannot be announced (no name or no saved start). `startsAt` is a Firestore Timestamp (or
 * anything with toMillis). Zones are kept only when they have a name and a size of 10, 20 or 40.
 */
export function readRaid(data) {
  if (!data || typeof data !== 'object' || typeof data.name !== 'string' || !data.name.trim()) return null
  const startsAtMillis = typeof data.startsAt?.toMillis === 'function' ? data.startsAt.toMillis() : null
  if (!Number.isFinite(startsAtMillis)) return null
  const zones = Array.isArray(data.zones) ? data.zones.filter((zone) => zone && typeof zone.name === 'string' && zone.name.trim() && [10, 20, 40].includes(zone.size))
    .map((zone) => ({ id: typeof zone.id === 'string' ? zone.id : '', name: zone.name.trim(), size: zone.size })) : []
  return {
    name: data.name.trim(),
    description: typeof data.description === 'string' ? data.description.trim() : '',
    zones,
    startsAtMillis,
    status: data.status === 'cancelled' ? 'cancelled' : 'scheduled',
  }
}

/** Whether two versions of a raid record show the same post (a save that changed only the audit fields, or a cancel reason, is not worth an edit). */
export function sameAnnouncement(before, after) {
  return JSON.stringify(readRaid(before)) === JSON.stringify(readRaid(after))
}

const unixSeconds = (millis) => Math.floor(millis / 1000)
/** The start as Discord timestamps: the full date and time and "in 3 days", each shown in the reader's own time zone and language. */
export const startText = (millis) => `<t:${unixSeconds(millis)}:F> (<t:${unixSeconds(millis)}:R>)`

/**
 * The announcement: one embed with the name, the start, the zones and sizes, the leader's description, a link to the site and the first zone's picture.
 * @param {ReturnType<typeof readRaid> & {}} raid
 * @param {{ siteUrl?: string | null, imageUrl?: string | null }} [links]
 */
export function announcementPayload(raid, { siteUrl = null, imageUrl = null } = {}) {
  const cancelled = raid.status === 'cancelled'
  const name = clip(defuseMentions(raid.name), 200)
  const lines = []
  if (cancelled) lines.push('**Cancelled.** This raid will not take place.')
  lines.push(`**Starts** ${startText(raid.startsAtMillis)}`)
  if (raid.zones.length) lines.push(`**Zones** ${raid.zones.map((zone) => `${plainText(zone.name)} (${zone.size})`).join(', ')}`)
  if (raid.description) lines.push('', clip(plainText(raid.description), 2000))
  if (siteUrl) lines.push('', `[Open the Raid Desk](${siteUrl})`)
  const embed = {
    title: cancelled ? `Cancelled: ${name}` : name,
    ...(siteUrl ? { url: siteUrl } : {}),
    description: clip(lines.join('\n'), 4000),
    color: cancelled ? CANCELLED_COLOR : SCHEDULED_COLOR,
    ...(imageUrl ? { image: { url: imageUrl } } : {}),
    footer: { text: 'The start shows in your own time zone.' },
  }
  return { embeds: [embed], allowed_mentions: noMentions() }
}

/**
 * A reminder: one line of text, so it notifies like any message.
 * @param {ReturnType<typeof readRaid> & {}} raid
 * @param {'day' | 'hour'} kind
 * @param {{ siteUrl?: string | null }} [links]
 */
export function reminderPayload(raid, kind, { siteUrl = null } = {}) {
  const lead = kind === 'day' ? 'Reminder' : 'Starting soon'
  const unix = unixSeconds(raid.startsAtMillis)
  const link = siteUrl ? ` Sign-ups and rosters are on the Raid Desk: <${siteUrl}>` : ''
  return { content: clip(`${lead}: **${clip(plainText(raid.name), 300)}** starts <t:${unix}:R>, at <t:${unix}:F>.${link}`, 2000), allowed_mentions: noMentions() }
}

/** The same post without its picture (sent when Discord refuses a post that has one). */
export function withoutImage(payload) {
  if (!payload.embeds?.[0]?.image) return payload
  const [{ image: _image, ...embed }, ...rest] = payload.embeds
  return { ...payload, embeds: [embed, ...rest] }
}

/** A fingerprint of a post, to tell whether the raid's post needs an edit. */
export const payloadHash = (payload) => createHash('sha256').update(JSON.stringify(payload)).digest('hex')

const IMAGE_ID = /^[a-z0-9]{6,40}$/
const ZONE_KEY = /^(?:[0-9]{1,9}|r-[A-Za-z0-9_-]{1,40})$/
const STORAGE_URL = /^https:\/\/firebasestorage\.googleapis\.com\/v0\/b\/[A-Za-z0-9._-]{1,100}\/o\/[A-Za-z0-9%._~-]{1,300}\?[A-Za-z0-9=&%._~-]{1,400}$/
const LOCAL_STORAGE_URL = /^http:\/\/(?:127\.0\.0\.1|localhost):[0-9]{2,5}\/v0\/b\/[A-Za-z0-9._-]{1,100}\/o\/[A-Za-z0-9%._~-]{1,300}\?[A-Za-z0-9=&%._~-]{1,400}$/
const own = (object, key) => object !== null && typeof object === 'object' && Object.hasOwn(object, key) ? object[key] : undefined

/** The key a raid zone is known by in the zone pictures (as src/shared/raids/raidZoneArt.ts): `z<number>` is that number, any other id is `r-<id>`. */
export function raidZoneKey(zoneId) {
  if (typeof zoneId !== 'string') return undefined
  const numbered = /^z([0-9]{1,9})$/.exec(zoneId)
  const key = numbered ? String(Number(numbered[1])) : `r-${zoneId}`
  return ZONE_KEY.test(key) ? key : undefined
}

/**
 * The address of the small copy of a zone's picture, from the guild's `settings/zoneArt` document, or null. As the app does (src/shared/game/zoneArt.ts),
 * a picture is used only when its file is this guild's own small copy at its rev and the address is that file's download address in Cloud Storage.
 */
export function zoneImageUrl(zoneArt, guildId, zoneId, { allowLocal = false } = {}) {
  const key = raidZoneKey(zoneId)
  const imageId = key === undefined ? undefined : own(own(zoneArt, 'art'), key)
  if (typeof imageId !== 'string' || !IMAGE_ID.test(imageId)) return null
  const image = own(own(zoneArt, 'images'), imageId)
  const rev = own(image, 'rev')
  if (!Number.isInteger(rev) || rev < 1 || rev > 1_000_000) return null
  const thumb = `guilds/${guildId}/zone-art/${imageId}/thumb-${rev}.jpg`
  const url = own(image, 'thumbUrl')
  if (own(image, 'thumb') !== thumb || typeof url !== 'string' || url.length > 800) return null
  if (!STORAGE_URL.test(url) && !(allowLocal && LOCAL_STORAGE_URL.test(url))) return null
  return url.split('?')[0].endsWith(`/o/${encodeURIComponent(thumb)}`) ? url : null
}

/**
 * What the raid's post needs: 'post' (a new message), 'edit' (the same message) or 'none'. A raid is announced the first time only while it is scheduled
 * and has not started; once it has a message, every change edits it, cancelled or not, until 5 hours after the start.
 */
export function planAnnouncement(raid, state, now, hash) {
  if (now >= raid.startsAtMillis + FOLLOW_AFTER_START) return 'none'
  if (!state.messageId) return raid.status === 'scheduled' && now < raid.startsAtMillis ? 'post' : 'none'
  return state.postedHash === hash ? 'none' : 'edit'
}

/** Whether a raid with no post yet would be announced now (the state document is created only then). */
export const wouldAnnounce = (raid, now) => raid.status === 'scheduled' && now < raid.startsAtMillis

/**
 * The reminders to send now and the ones to give up on, for an announced, scheduled raid. A reminder belongs to one start: a rescheduled raid gets its
 * reminders again for the new start. It is sent at the first check at or after its time, and given up on when the check comes too late (the day reminder
 * once the hour one is due, the hour reminder at the start) or when the raid's message was first posted inside its window (a raid announced 10 hours
 * ahead gets no day reminder: the announcement just went out).
 */
export function dueReminders(raid, state, now) {
  const send = []
  const skip = []
  if (raid.status !== 'scheduled' || !state.messageId || now >= raid.startsAtMillis) return { send, skip }
  for (const { kind, before } of REMINDERS) {
    if (state.reminders?.[kind]?.startsAtMillis === raid.startsAtMillis) continue
    const at = raid.startsAtMillis - before
    if (now < at) continue
    const until = kind === 'day' ? raid.startsAtMillis - HOUR : raid.startsAtMillis
    if (now >= until || (state.postedAtMillis ?? 0) >= at) skip.push(kind)
    else send.push(kind)
  }
  return { send, skip }
}

/** How long to wait before retrying after this many failures in a row: 5 minutes, then twice as long each time, at most an hour. */
export const retryDelay = (failures) => Math.min(SWEEP_EVERY * 2 ** Math.max(0, failures - 1), MAX_RETRY_DELAY)

/**
 * When the sweep should look at the raid next, or null for never (until the raid changes again). After a failure: the retry, no later than the follow
 * window. Otherwise: the next reminder that is still to come for the current start.
 * @param {number | null} [retryAt]
 * @returns {number | null}
 */
export function nextDueAt(raid, state, now, retryAt = null) {
  if (!raid || now >= raid.startsAtMillis + FOLLOW_AFTER_START) return null
  if (retryAt !== null) return Math.min(retryAt, raid.startsAtMillis + FOLLOW_AFTER_START)
  if (raid.status !== 'scheduled' || !state.messageId || now >= raid.startsAtMillis) return null
  let next = null
  for (const { kind, before } of REMINDERS) {
    if (state.reminders?.[kind]?.startsAtMillis === raid.startsAtMillis) continue
    const at = Math.max(raid.startsAtMillis - before, now)
    next = next === null ? at : Math.min(next, at)
  }
  return next
}
