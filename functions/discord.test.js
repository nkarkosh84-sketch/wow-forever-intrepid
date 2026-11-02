// DISCORD-002 against the local Firestore emulator and a fake Discord: a small HTTP server on 127.0.0.1 that answers like a webhook (a post with
// ?wait=true returns the message and its id, an edit of a message it does not have is a 404) and can be told to fail. No request leaves the machine.
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { createServer } from 'node:http'
import { setTimeout as delay } from 'node:timers/promises'
import { after, afterEach, before, beforeEach, describe, test } from 'node:test'
import { deleteApp, initializeApp } from 'firebase-admin/app'
import { FieldValue, getFirestore, Timestamp } from 'firebase-admin/firestore'
import { discordOptions, handleRaidWrite, runDiscordSweep, syncRaidAnnouncement } from './discord.js'
import { HOUR, MINUTE, parseWebhook } from './discordPosts.js'

const host = process.env.FIRESTORE_EMULATOR_HOST
if (!host || !/^(127\.0\.0\.1|localhost):\d+$/.test(host)) throw new Error('Discord tests require a local Firestore emulator.')

const app = initializeApp({ projectId: 'demo-intrepid' }, 'discord-announcement-tests')
const db = getFirestore(app)

const WEBHOOK_ID = '4242'
const TOKEN = 'invented-webhook-token'
const SITE = 'https://raid-desk.example.test/'
const DAY = 24 * HOUR
// 9:00 PM Eastern on December 8, 2026.
const START = Date.parse('2026-12-09T02:00:00.000Z')
const unix = (millis) => Math.floor(millis / 1000)
const NO_PINGS = { parse: [], users: [], roles: [], replied_user: false }

// The fake Discord. `fail` queues answers for the next requests that match; everything else is answered like a webhook.
const fake = { requests: [], messages: new Map(), scripted: [], delayMs: 0, next: 1300000000000000000n }
fake.server = createServer(async (req, res) => {
  let raw = ''
  for await (const chunk of req) raw += chunk
  const url = new URL(req.url, 'http://127.0.0.1')
  const entry = { method: req.method, path: url.pathname, wait: url.searchParams.get('wait'), body: raw ? JSON.parse(raw) : null, at: Date.now() }
  fake.requests.push(entry)
  const reply = (status, body, headers = {}) => {
    res.writeHead(status, { 'Content-Type': 'application/json', ...headers })
    res.end(body === undefined ? '' : JSON.stringify(body))
  }
  const scripted = fake.scripted.findIndex((step) => step.when(entry))
  if (scripted >= 0) {
    const [step] = fake.scripted.splice(scripted, 1)
    return reply(step.status, step.body, step.headers)
  }
  if (fake.delayMs) await delay(fake.delayMs)
  const match = /^\/api\/v10\/webhooks\/([0-9]+)\/([^/]+)(?:\/messages\/([0-9]+))?$/.exec(url.pathname)
  if (!match || match[1] !== WEBHOOK_ID || match[2] !== TOKEN) return reply(401, { code: 50027, message: 'Invalid Webhook Token' })
  if (req.method === 'POST' && !match[3]) {
    const id = String(fake.next++)
    fake.messages.set(id, entry.body)
    return reply(200, { id, ...entry.body })
  }
  if (req.method === 'PATCH' && match[3]) {
    if (!fake.messages.has(match[3])) return reply(404, { code: 10008, message: 'Unknown Message' })
    fake.messages.set(match[3], { ...fake.messages.get(match[3]), ...entry.body })
    return reply(200, { id: match[3], ...fake.messages.get(match[3]) })
  }
  return reply(405, { message: '405: Method Not Allowed' })
})
const fail = (step) => fake.scripted.push({ when: () => true, ...step })
const posts = () => fake.requests.filter((request) => request.method === 'POST')
const edits = () => fake.requests.filter((request) => request.method === 'PATCH')
const reminders = () => posts().filter((request) => typeof request.body?.content === 'string')

let webhook
let guild
let raid
let clockNow
let logs

const logger = {
  info: (...args) => logs.push(['info', ...args]),
  warn: (...args) => logs.push(['warn', ...args]),
  error: (...args) => logs.push(['error', ...args]),
}
const options = (overrides = {}) => ({ webhook, siteUrl: SITE, allowLocal: false, clock: () => clockNow, logger, ...overrides })
const state = async () => (await guild.collection('discordAnnouncements').doc(raid.id).get()).data()
const sweep = (at, overrides) => {
  clockNow = at
  return runDiscordSweep(db, options(overrides))
}

const thumbPath = () => `guilds/${guild.id}/zone-art/emberimg1/thumb-2.jpg`
const thumbUrl = () => `https://firebasestorage.googleapis.com/v0/b/demo-intrepid.firebasestorage.app/o/${encodeURIComponent(thumbPath())}?alt=media&token=invented-file-token`

function raidData(fields = {}) {
  return {
    name: 'Emberforge Night', date: '2026-12-08', time: '21:00', size: 40, description: 'Bring fire resistance.',
    zones: [{ id: 'z409', name: 'Ember Hollow', size: 40 }, { id: 'zone-glass', name: 'Glass Spire', size: 20 }],
    startsAt: Timestamp.fromMillis(START), createdBy: 'leader-uid', createdAt: Timestamp.fromMillis(0), ...fields,
  }
}

// What the raid trigger does for a new raid and for an audited edit: the write, then the handler with the document before and after it.
async function createRaid(at, fields = {}, overrides = {}) {
  clockNow = at
  await raid.set(raidData(fields))
  return handleRaidWrite(db, { guildId: guild.id, raidId: raid.id, before: undefined, after: (await raid.get()).data() }, options(overrides))
}

async function changeRaid(at, fields, overrides = {}) {
  clockNow = at
  const previous = (await raid.get()).data()
  await raid.update({ ...fields, rev: (previous.rev ?? 0) + 1, updatedBy: 'leader-uid', updatedAt: Timestamp.fromMillis(at) })
  return handleRaidWrite(db, { guildId: guild.id, raidId: raid.id, before: previous, after: (await raid.get()).data() }, options(overrides))
}

before(() => new Promise((resolve) => fake.server.listen(0, '127.0.0.1', resolve)))

beforeEach(async () => {
  Object.assign(fake, { requests: [], scripted: [], delayMs: 0 })
  fake.messages.clear()
  logs = []
  webhook = parseWebhook(`http://127.0.0.1:${fake.server.address().port}/api/webhooks/${WEBHOOK_ID}/${TOKEN}`, { allowLocal: true })
  guild = db.collection('guilds').doc(`discord-test-${randomUUID()}`)
  raid = guild.collection('raids').doc('raid-one')
  await guild.collection('settings').doc('zoneArt').set({
    images: {
      emberimg1: {
        name: 'Ember Hollow', rev: 2, bytes: 4000, width: 1200, height: 600, full: `guilds/${guild.id}/zone-art/emberimg1/full-2.jpg`,
        fullUrl: 'https://firebasestorage.googleapis.com/v0/b/demo-intrepid.firebasestorage.app/o/full?alt=media', thumb: thumbPath(), thumbUrl: thumbUrl(),
      },
    },
    art: { 409: 'emberimg1' },
  })
})

afterEach(async () => {
  await db.recursiveDelete(guild)
})

after(async () => {
  await new Promise((resolve) => fake.server.close(resolve))
  await deleteApp(app)
})

describe('the announcement', () => {
  test('a new raid is posted once, with its name, start as Discord timestamps, zones and sizes, description, a link and the first zone\'s picture', async () => {
    assert.deepEqual(await createRaid(START - 3 * DAY), ['posted'])
    assert.equal(fake.requests.length, 1)
    const [request] = fake.requests
    assert.equal(request.method, 'POST')
    assert.equal(request.wait, 'true')
    assert.equal(request.path, `/api/v10/webhooks/${WEBHOOK_ID}/${TOKEN}`)
    const [embed] = request.body.embeds
    assert.equal(embed.title, 'Emberforge Night')
    assert.equal(embed.url, SITE)
    assert.ok(embed.description.includes(`<t:${unix(START)}:F> (<t:${unix(START)}:R>)`))
    assert.ok(embed.description.includes('**Zones** Ember Hollow (40), Glass Spire (20)'))
    assert.ok(embed.description.includes('Bring fire resistance.'))
    assert.ok(embed.description.includes(`[Open the Raid Desk](${SITE})`))
    assert.deepEqual(embed.image, { url: thumbUrl() })
    assert.deepEqual(request.body.allowed_mentions, NO_PINGS)

    const stored = await state()
    assert.equal(stored.messageId, [...fake.messages.keys()][0])
    assert.equal(stored.webhookId, WEBHOOK_ID)
    assert.equal(stored.postedAt.toMillis(), START - 3 * DAY)
    assert.equal(stored.posted.status, 'scheduled')
    assert.equal(stored.posted.image, true)
    assert.deepEqual(stored.posted.payload, request.body)
    assert.deepEqual(stored.reminders, { day: null, hour: null })
    assert.equal(stored.lastError, null)
    assert.equal(stored.lease, null)
    assert.equal(stored.dueAt.toMillis(), START - DAY)
  })

  test('a change edits the same message; a save that changes nothing it shows sends nothing', async () => {
    await createRaid(START - 3 * DAY)
    const messageId = (await state()).messageId
    assert.deepEqual(await changeRaid(START - 2 * DAY, { name: 'Emberforge Night, late start', time: '22:00', startsAt: Timestamp.fromMillis(START + HOUR), description: 'New plan.' }), ['edited'])
    assert.equal(posts().length, 1)
    assert.equal(edits().length, 1)
    assert.equal(edits()[0].path, `/api/v10/webhooks/${WEBHOOK_ID}/${TOKEN}/messages/${messageId}`)
    assert.equal(fake.messages.size, 1)
    const [embed] = fake.messages.get(messageId).embeds
    assert.equal(embed.title, 'Emberforge Night, late start')
    assert.ok(embed.description.includes(`<t:${unix(START + HOUR)}:F>`))
    assert.ok(embed.description.includes('New plan.'))
    assert.equal((await state()).dueAt.toMillis(), START + HOUR - DAY)

    assert.equal(await changeRaid(START - 2 * DAY + MINUTE, { size: 40 }), 'unchanged')
    assert.equal(fake.requests.length, 2)
  })

  test('cancel and restore edit the same message, and a cancelled raid gets no reminders', async () => {
    await createRaid(START - 3 * DAY)
    const messageId = (await state()).messageId
    await changeRaid(START - 2 * DAY, { status: 'cancelled', cancelReason: 'Not enough healers' })
    assert.equal(edits().length, 1)
    let [embed] = fake.messages.get(messageId).embeds
    assert.equal(embed.title, 'Cancelled: Emberforge Night')
    assert.ok(embed.description.startsWith('**Cancelled.**'))
    assert.ok(!JSON.stringify(fake.messages.get(messageId)).includes('Not enough healers'), 'the cancel reason is not posted')
    assert.equal((await state()).dueAt, null)

    assert.deepEqual(await sweep(START - DAY + MINUTE), { checked: 0 })
    assert.deepEqual(await sweep(START - HOUR + MINUTE), { checked: 0 })
    assert.equal(fake.requests.length, 2)

    // Restored inside the day window: the edit, then the day reminder at once (the announcement went out before the window).
    assert.deepEqual(await changeRaid(START - 23 * HOUR, { status: FieldValue.delete(), cancelReason: FieldValue.delete() }), ['edited', 'reminded-day'])
    ;[embed] = fake.messages.get(messageId).embeds
    assert.equal(embed.title, 'Emberforge Night')
    assert.ok(!embed.description.includes('Cancelled'))
    assert.equal(posts().length, 2)
    assert.equal(fake.messages.size, 2)
  })

  test('a deleted message is posted again', async () => {
    await createRaid(START - 3 * DAY)
    const first = (await state()).messageId
    fake.messages.delete(first)
    assert.deepEqual(await changeRaid(START - 2 * DAY, { description: 'Bring frost resistance too.' }), ['posted'])
    assert.deepEqual(fake.requests.map((request) => request.method), ['POST', 'PATCH', 'POST'])
    const stored = await state()
    assert.notEqual(stored.messageId, first)
    assert.ok(fake.messages.has(stored.messageId))
    assert.equal(stored.postedAt.toMillis(), START - 2 * DAY)
  })

  test('a raid never announced is not announced cancelled or after it starts, and a post stops following its raid 5 hours after the start', async () => {
    assert.equal(await createRaid(START - 3 * DAY, { status: 'cancelled', cancelReason: 'Planned by mistake' }), 'nothing')
    assert.equal(await createRaid(START + 10 * MINUTE), 'nothing')
    assert.equal(await state(), undefined)
    assert.equal(fake.requests.length, 0)

    await createRaid(START - 3 * DAY)
    assert.deepEqual(await changeRaid(START + 6 * HOUR, { description: 'Thanks for coming.' }), [])
    assert.equal(fake.requests.length, 1)
    assert.equal((await state()).dueAt, null)
  })

  test('two runs at once post one message, and a change made meanwhile is edited in', async () => {
    clockNow = START - 3 * DAY
    await raid.set(raidData())
    fake.delayMs = 300
    const first = syncRaidAnnouncement(db, guild.id, raid.id, options())
    for (let i = 0; i < 300 && !fake.requests.length; i += 1) await delay(10)
    fake.delayMs = 0
    await raid.update({ name: 'Emberforge Night, second try', rev: 1 })
    assert.equal(await syncRaidAnnouncement(db, guild.id, raid.id, options()), 'busy')
    assert.deepEqual(await first, ['posted', 'edited'])
    assert.equal(posts().length, 1)
    assert.equal(edits().length, 1)
    assert.equal(fake.messages.size, 1)
    assert.equal([...fake.messages.values()][0].embeds[0].title, 'Emberforge Night, second try')
    const stored = await state()
    assert.equal(stored.lease, null)
    assert.equal(stored.dirty, false)
  })

  test('a raid that keeps changing while it posts is left to the next sweep, not dropped', async () => {
    clockNow = START - 3 * DAY
    await raid.set(raidData())
    fake.delayMs = 200
    const first = syncRaidAnnouncement(db, guild.id, raid.id, options())
    for (const [pass, name] of [[1, 'Second name'], [2, 'Third name'], [3, 'Fourth name']]) {
      for (let i = 0; i < 300 && fake.requests.length < pass; i += 1) await delay(10)
      await raid.update({ name })
      assert.equal(await syncRaidAnnouncement(db, guild.id, raid.id, options()), 'busy')
    }
    assert.deepEqual(await first, ['posted', 'edited', 'edited'])
    fake.delayMs = 0
    const messageId = (await state()).messageId
    assert.equal(fake.messages.get(messageId).embeds[0].title, 'Third name')
    assert.equal((await state()).dueAt.toMillis(), clockNow)
    assert.deepEqual(await sweep(clockNow), { checked: 1 })
    assert.equal(fake.messages.get(messageId).embeds[0].title, 'Fourth name')
    assert.equal(posts().length, 1)
  })
})

describe('the reminders', () => {
  test('go out once each, 24 hours and 1 hour before the start', async () => {
    await createRaid(START - 3 * DAY)
    assert.deepEqual(await sweep(START - DAY - MINUTE), { checked: 0 })
    assert.deepEqual(await sweep(START - DAY), { checked: 1 })
    assert.equal(reminders().length, 1)
    const day = reminders()[0].body
    assert.equal(day.content, `Reminder: **Emberforge Night** starts <t:${unix(START)}:R>, at <t:${unix(START)}:F>. Sign-ups and rosters are on the Raid Desk: <${SITE}>`)
    assert.deepEqual(day.allowed_mentions, NO_PINGS)
    assert.equal((await state()).reminders.day.startsAtMillis, START)
    assert.equal((await state()).dueAt.toMillis(), START - HOUR)

    assert.deepEqual(await sweep(START - DAY + 5 * MINUTE), { checked: 0 })
    assert.deepEqual(await sweep(START - HOUR + 2 * MINUTE), { checked: 1 })
    assert.equal(reminders().length, 2)
    assert.ok(reminders()[1].body.content.startsWith('Starting soon: **Emberforge Night** starts'))
    assert.deepEqual(await sweep(START + 5 * MINUTE), { checked: 0 })
    assert.equal(reminders().length, 2)
    const stored = await state()
    assert.equal(stored.dueAt, null)
    assert.equal(stored.reminders.hour.sentAt.toMillis(), START - HOUR + 2 * MINUTE)
    assert.ok(fake.messages.has(stored.reminders.hour.messageId))
    assert.equal(edits().length, 0, 'reminders never edit the announcement')
  })

  test('a late sweep sends only the reminder still due', async () => {
    await createRaid(START - 3 * DAY)
    await sweep(START - 50 * MINUTE)
    assert.equal(reminders().length, 1)
    assert.ok(reminders()[0].body.content.startsWith('Starting soon'))
    const stored = await state()
    assert.equal(stored.reminders.day.skipped, true)
    assert.equal(stored.reminders.day.sentAt, null)
    assert.equal(stored.dueAt, null)
  })

  test('a raid announced inside a reminder window gets no reminder for that window', async () => {
    await createRaid(START - 10 * HOUR)
    assert.equal((await state()).reminders.day.skipped, true)
    assert.equal((await state()).dueAt.toMillis(), START - HOUR)
    await sweep(START - HOUR)
    assert.equal(reminders().length, 1)
    assert.ok(reminders()[0].body.content.startsWith('Starting soon'))
  })

  test('a rescheduled raid gets its reminders again for the new start', async () => {
    const later = START + 2 * DAY
    await createRaid(START - 3 * DAY)
    await sweep(START - DAY)
    assert.equal(reminders().length, 1)
    await changeRaid(START - 20 * HOUR, { date: '2026-12-10', startsAt: Timestamp.fromMillis(later) })
    assert.equal(edits().length, 1)
    assert.equal((await state()).dueAt.toMillis(), later - DAY)
    assert.deepEqual(await sweep(START - HOUR), { checked: 0 })
    await sweep(later - DAY)
    await sweep(later - HOUR)
    assert.equal(reminders().length, 3)
    assert.ok(reminders()[1].body.content.includes(`<t:${unix(later)}:R>`))
    assert.ok(reminders()[2].body.content.startsWith('Starting soon'))
  })
})

describe('failures', () => {
  test('Discord down leaves the raid untouched, and the sweep posts it later', async () => {
    fail({ status: 503, body: { message: 'Service Unavailable' } })
    const created = START - 3 * DAY
    assert.deepEqual(await createRaid(created), [])
    const raidBefore = (await raid.get()).data()
    let stored = await state()
    assert.equal(stored.messageId, null)
    assert.deepEqual({ ...stored.lastError, at: stored.lastError.at.toMillis() }, { at: created, during: 'post', code: 'http', status: 503 })
    assert.equal(stored.failures, 1)
    assert.equal(stored.dueAt.toMillis(), created + 4 * MINUTE)
    assert.ok(logs.some(([level, message]) => level === 'warn' && message.includes('the sweep will retry')))

    assert.deepEqual(await sweep(created + 5 * MINUTE), { checked: 1 })
    stored = await state()
    assert.ok(fake.messages.has(stored.messageId))
    assert.equal(stored.lastError, null)
    assert.equal(stored.failures, 0)
    assert.equal(stored.dueAt.toMillis(), START - DAY)
    assert.equal(posts().length, 2)
    assert.equal(fake.messages.size, 1)
    assert.deepEqual((await raid.get()).data(), raidBefore, 'nothing is written to the raid')
  })

  test('a Discord that cannot be reached never throws out of the trigger, and retries back off', async () => {
    const closed = createServer()
    await new Promise((resolve) => closed.listen(0, '127.0.0.1', resolve))
    const port = closed.address().port
    await new Promise((resolve) => closed.close(resolve))
    const unreachable = parseWebhook(`http://127.0.0.1:${port}/api/webhooks/${WEBHOOK_ID}/${TOKEN}`, { allowLocal: true })
    const created = START - 3 * DAY
    assert.deepEqual(await createRaid(created, {}, { webhook: unreachable }), [])
    assert.equal((await state()).lastError.code, 'network')
    await sweep(created + 5 * MINUTE, { webhook: unreachable })
    const stored = await state()
    assert.equal(stored.failures, 2)
    assert.equal(stored.dueAt.toMillis(), created + 5 * MINUTE + 9 * MINUTE)
  })

  test('a rate limit is waited out when short and left to the sweep when long', async () => {
    fail({ status: 429, body: { message: 'You are being rate limited.', retry_after: 0.05, global: false } })
    assert.deepEqual(await createRaid(START - 3 * DAY), ['posted'])
    assert.equal(posts().length, 2)
    assert.ok(posts()[1].at - posts()[0].at >= 45)

    await db.recursiveDelete(guild.collection('discordAnnouncements'))
    fake.requests = []
    fail({ status: 429, body: { message: 'You are being rate limited.', retry_after: 900, global: false } })
    const at = START - 2 * DAY
    clockNow = at
    assert.deepEqual(await syncRaidAnnouncement(db, guild.id, raid.id, options()), [])
    const stored = await state()
    assert.equal(stored.lastError.code, 'rate-limited')
    assert.equal(stored.dueAt.toMillis(), at + 900_000)
  })

  test('a picture Discord refuses is left out, and the raid is still announced', async () => {
    fake.scripted.push({ when: (request) => Boolean(request.body?.embeds?.[0]?.image), status: 400, body: { code: 50035, message: 'Invalid Form Body' } })
    assert.deepEqual(await createRaid(START - 3 * DAY), ['posted'])
    assert.equal(posts().length, 2)
    assert.equal(posts()[1].body.embeds[0].image, undefined)
    assert.equal((await state()).posted.image, false)
    await sweep(START - DAY)
    assert.equal(edits().length, 0, 'the post is not edited again for its picture')
    assert.equal(reminders().length, 1)
  })
})

describe('safety', () => {
  test('@everyone, @here and mentions in a raid\'s name or description ping nobody', async () => {
    await createRaid(START - 3 * DAY, { name: '@everyone Emberforge', description: '@here bring <@123456789> and <@&987654321> to <#555>, see https://example.test/plan_b' })
    await sweep(START - DAY)
    assert.equal(fake.requests.length, 2)
    for (const { body } of fake.requests) {
      assert.deepEqual(body.allowed_mentions, NO_PINGS)
      const text = JSON.stringify(body)
      assert.doesNotMatch(text, /@everyone|@here|<@[0-9&!]|<#[0-9]/)
    }
    assert.ok(fake.requests[0].body.embeds[0].description.includes('https://example.test/plan_b'), 'a web address stays a link')
  })

  test('no member, character or account detail is posted', async () => {
    await guild.collection('members').doc('member-uid').set({ role: 'Member', displayName: 'Invented Quillmark', email: 'quill@example.test', playerId: 'player-1' })
    await guild.collection('roster').doc('player-1').set({ name: 'Aldric', className: 'Warrior', specialization: 'Arms', role: 'Melee', linkedUid: 'member-uid' })
    await guild.collection('roster').doc('player-alt').set({ name: 'Elowen', className: 'Druid', specialization: 'Restoration', role: 'Healer', mainId: 'player-1' })
    await createRaid(START - 3 * DAY)
    await raid.collection('signups').doc('member-uid').set({ characterId: 'player-alt', status: 'accept', updatedAt: Timestamp.fromMillis(START - 2 * DAY) })
    await raid.collection('planning').doc('working').set({ schemaVersion: 1, revision: 1, invitations: [{ uid: 'member-uid', mainId: 'player-1' }], lineups: [] })
    await changeRaid(START - 2 * DAY, { description: 'Same night, new plan.' })
    await sweep(START - DAY)
    await sweep(START - HOUR)
    await changeRaid(START - 30 * MINUTE, { status: 'cancelled', cancelReason: 'Aldric and Elowen are away' })
    assert.equal(fake.requests.length, 5)
    const sent = JSON.stringify(fake.requests.map((request) => request.body))
    for (const detail of ['Aldric', 'Elowen', 'Quillmark', 'quill@example.test', 'member-uid', 'leader-uid', 'player-1']) assert.ok(!sent.includes(detail), detail)
  })

  test('the options come from the secret\'s value at run time; anything but a webhook address turns the posts off', () => {
    const production = discordOptions(' https://discord.com/api/webhooks/123/invented-token\n', { GCLOUD_PROJECT: 'invented-project' })
    assert.equal(production.webhook.id, '123')
    assert.equal(production.siteUrl, 'https://invented-project.web.app/')
    assert.equal(production.allowLocal, false)
    assert.equal(discordOptions('https://discord.com/api/webhooks/123/invented-token', { FIREBASE_CONFIG: '{"projectId":"invented-config"}' }).siteUrl, 'https://invented-config.web.app/')
    for (const value of ['', 'off', undefined, 'https://example.test/hook']) assert.equal(discordOptions(value, {}).webhook, null, String(value))
    const local = 'http://127.0.0.1:18999/api/webhooks/1/local-token'
    assert.equal(discordOptions(local, {}).webhook, null, 'a local address only in the Functions emulator')
    assert.equal(discordOptions(local, { FUNCTIONS_EMULATOR: 'true' }).webhook.id, '1')
  })

  test('with no webhook nothing is posted and nothing is kept', async () => {
    assert.equal(await createRaid(START - 3 * DAY, {}, { webhook: null }), 'off')
    assert.deepEqual(await sweep(START - DAY, { webhook: null }), { checked: 0 })
    assert.equal(await state(), undefined)
    assert.equal(fake.requests.length, 0)
  })

  test('the webhook address is never logged or stored', async () => {
    fail({ status: 503, body: { message: 'Service Unavailable' } })
    await createRaid(START - 3 * DAY)
    await sweep(START - 3 * DAY + 5 * MINUTE)
    await sweep(START - DAY)
    assert.ok(logs.length >= 3)
    assert.ok(!JSON.stringify(logs).includes(TOKEN))
    assert.ok(!JSON.stringify(await state()).includes(TOKEN))
    assert.ok(!JSON.stringify(webhook).includes(TOKEN))
  })
})
