// DISCORD-002: the pure half of the raid posts in Discord (functions/discordPosts.js): the webhook address, the messages, the zone picture, and when the
// announcement, the reminders and the retries are due. The posting itself is tested against a fake Discord in functions/discord.test.js.
import assert from 'node:assert/strict'
import { describe, test } from 'node:test'
import {
  announcementPayload, defuseMentions, dueReminders, FOLLOW_AFTER_START, HOUR, MINUTE, nextDueAt, noMentions, parseWebhook, payloadHash,
  plainText, planAnnouncement, raidZoneKey, readRaid, reminderPayload, retryDelay, sameAnnouncement, siteAddress, withoutImage, wouldAnnounce,
  zoneImageUrl,
} from '../../functions/discordPosts.js'

const DAY = 24 * HOUR
const START = Date.parse('2026-12-09T02:00:00.000Z')
const SITE = 'https://raid-desk.example.test/'
const stamp = (millis: number) => ({ toMillis: () => millis })
const raidRecord = (fields: Record<string, unknown> = {}) => ({
  name: 'Emberforge Night', description: 'Bring fire resistance.', startsAt: stamp(START), size: 40,
  zones: [{ id: 'z409', name: 'Ember Hollow', size: 40 }, { id: 'zone-glass', name: 'Glass Spire', size: 20 }], ...fields,
})
const raid = (fields: Record<string, unknown> = {}) => readRaid(raidRecord(fields))!
const announced = (fields: Record<string, unknown> = {}) => ({ messageId: '1300000000000000000', postedAtMillis: START - 3 * DAY, postedHash: 'x', reminders: { day: null, hour: null }, ...fields })

describe('the webhook address', () => {
  test('accepts Discord webhook addresses and normalizes them', () => {
    for (const value of ['https://discord.com/api/webhooks/123/invented-token', ' https://discordapp.com/api/v10/webhooks/123/invented-token\n']) {
      const hook = parseWebhook(value)!
      assert.equal(hook.id, '123')
      assert.equal(hook.url, 'https://discord.com/api/v10/webhooks/123/invented-token')
    }
  })

  test('anything else turns the posts off', () => {
    for (const value of [undefined, '', 'off', 'OFF', 'https://example.test/api/webhooks/123/token', 'http://discord.com/api/webhooks/123/token',
      'https://discord.com/api/webhooks/abc/token', 'https://discord.com/api/webhooks/123/token/extra', 'https://discord.com.example.test/api/webhooks/123/token']) {
      assert.equal(parseWebhook(value), null, String(value))
    }
  })

  test('a local fake Discord only when allowed (the Functions emulator)', () => {
    const local = 'http://127.0.0.1:18999/api/webhooks/77/local-token'
    assert.equal(parseWebhook(local), null)
    assert.equal(parseWebhook(local, { allowLocal: true })!.url, 'http://127.0.0.1:18999/api/v10/webhooks/77/local-token')
    assert.equal(parseWebhook('http://10.0.0.5:18999/api/webhooks/77/local-token', { allowLocal: true }), null)
  })

  test('the token stays out of logs and JSON', () => {
    const hook = parseWebhook('https://discord.com/api/webhooks/123/invented-token')!
    assert.equal(JSON.stringify(hook), '{"id":"123"}')
    assert.ok(!Object.keys(hook).includes('url'))
  })

  test('the site address is the project\'s Hosting address', () => {
    assert.equal(siteAddress('demo-intrepid'), 'https://demo-intrepid.web.app/')
    for (const value of [undefined, '', 'Bad_Project', 'a', 'x'.repeat(31)]) assert.equal(siteAddress(value), null)
  })
})

describe('the text', () => {
  test('mentions cannot ping', () => {
    assert.equal(defuseMentions('@everyone and @HERE'), '@​everyone and @​HERE')
    assert.equal(defuseMentions('<@123> <@!123> <@&456> <#789>'), '<​@123> <​@!123> <​@&456> <​#789>')
    assert.equal(defuseMentions('mail me at quill@example.test'), 'mail me at quill@example.test')
  })

  test('markdown shows as written, but web addresses stay links', () => {
    assert.equal(plainText('MC *speed* run_2 ~~ `x` |y| [z] \\'), 'MC \\*speed\\* run\\_2 \\~\\~ \\`x\\` \\|y\\| \\[z\\] \\\\')
    assert.equal(plainText('# Heading\n> quote\n-# small\n- a list stays'), '\\# Heading\n\\> quote\n\\-# small\n- a list stays')
    assert.equal(plainText('see https://example.test/plan_b?x=*1* now_'), 'see https://example.test/plan_b?x=*1* now\\_')
  })
})

describe('the raid record', () => {
  test('keeps what a post shows', () => {
    assert.deepEqual(raid(), {
      name: 'Emberforge Night', description: 'Bring fire resistance.', startsAtMillis: START, status: 'scheduled',
      zones: [{ id: 'z409', name: 'Ember Hollow', size: 40 }, { id: 'zone-glass', name: 'Glass Spire', size: 20 }],
    })
    assert.equal(raid({ status: 'cancelled' }).status, 'cancelled')
    assert.deepEqual(raid({ zones: [{ id: 'a', name: 'Odd', size: 25 }, null, { id: 'b', name: ' ', size: 10 }] }).zones, [])
    assert.equal(raid({ description: undefined }).description, '')
  })

  test('a raid without a name or a saved start cannot be announced', () => {
    assert.equal(readRaid(raidRecord({ name: ' ' })), null)
    assert.equal(readRaid(raidRecord({ startsAt: undefined })), null)
    assert.equal(readRaid(raidRecord({ startsAt: '2026-12-08' })), null)
    assert.equal(readRaid(undefined), null)
  })

  test('only a change to what a post shows needs an edit', () => {
    assert.ok(sameAnnouncement(raidRecord(), raidRecord({ rev: 3, updatedBy: 'leader-uid', cancelReason: 'x', size: 20 })))
    for (const fields of [{ name: 'New' }, { description: 'New' }, { startsAt: stamp(START + HOUR) }, { status: 'cancelled' }, { zones: [] }]) {
      assert.ok(!sameAnnouncement(raidRecord(), raidRecord(fields)), JSON.stringify(fields))
    }
  })
})

describe('the announcement', () => {
  test('one embed with the start as Discord timestamps, zones and sizes, the description, a link and a picture, pinging nobody', () => {
    const payload = announcementPayload(raid(), { siteUrl: SITE, imageUrl: 'https://firebasestorage.googleapis.com/v0/b/b/o/p?alt=media' })
    const unix = START / 1000
    assert.deepEqual(payload, {
      embeds: [{
        title: 'Emberforge Night',
        url: SITE,
        description: `**Starts** <t:${unix}:F> (<t:${unix}:R>)\n**Zones** Ember Hollow (40), Glass Spire (20)\n\nBring fire resistance.\n\n[Open the Raid Desk](${SITE})`,
        color: 0x2f6fb0,
        image: { url: 'https://firebasestorage.googleapis.com/v0/b/b/o/p?alt=media' },
        footer: { text: 'The start shows in your own time zone.' },
      }],
      allowed_mentions: { parse: [], users: [], roles: [], replied_user: false },
    })
  })

  test('a cancelled raid says so; no description, zones, link or picture leaves them out', () => {
    const [embed] = announcementPayload(raid({ status: 'cancelled', description: '', zones: [] })).embeds
    assert.equal(embed.title, 'Cancelled: Emberforge Night')
    assert.equal(embed.description, `**Cancelled.** This raid will not take place.\n**Starts** <t:${START / 1000}:F> (<t:${START / 1000}:R>)`)
    assert.equal(embed.color, 0x7a8a9a)
    assert.ok(!('url' in embed) && !('image' in embed))
  })

  test('names and descriptions cannot ping or break the layout', () => {
    const [embed] = announcementPayload(raid({ name: '@everyone night', description: '@here **loud** <@123>', zones: [{ id: 'z1', name: 'Hall_of *Echoes*', size: 10 }] })).embeds
    assert.equal(embed.title, '@​everyone night')
    assert.ok(embed.description.includes('Hall\\_of \\*Echoes\\* (10)'))
    assert.ok(embed.description.includes('@​here \\*\\*loud\\*\\* <​@123>'))
  })

  test('a long description is cut to fit Discord', () => {
    const [embed] = announcementPayload(raid({ description: 'x'.repeat(5000) }), { siteUrl: SITE }).embeds
    assert.ok(embed.description.length <= 4096)
    assert.ok(embed.description.endsWith(`[Open the Raid Desk](${SITE})`))
  })

  test('without its picture, and the fingerprint tells two posts apart', () => {
    const payload = announcementPayload(raid(), { imageUrl: 'https://firebasestorage.googleapis.com/v0/b/b/o/p?alt=media' })
    const bare = withoutImage(payload)
    assert.ok(!('image' in bare.embeds[0]))
    assert.ok('image' in payload.embeds[0], 'the original is not changed')
    assert.equal(withoutImage(bare), bare)
    assert.equal(payloadHash(payload), payloadHash(announcementPayload(raid(), { imageUrl: 'https://firebasestorage.googleapis.com/v0/b/b/o/p?alt=media' })))
    assert.notEqual(payloadHash(payload), payloadHash(bare))
    assert.match(payloadHash(payload), /^[0-9a-f]{64}$/)
  })

  test('reminders are one line of text that pings nobody', () => {
    const unix = START / 1000
    assert.deepEqual(reminderPayload(raid(), 'day', { siteUrl: SITE }), {
      content: `Reminder: **Emberforge Night** starts <t:${unix}:R>, at <t:${unix}:F>. Sign-ups and rosters are on the Raid Desk: <${SITE}>`,
      allowed_mentions: noMentions(),
    })
    assert.equal(reminderPayload(raid({ name: '@here_now' }), 'hour').content, `Starting soon: **@​here\\_now** starts <t:${unix}:R>, at <t:${unix}:F>.`)
  })
})

describe('the zone picture', () => {
  const guildId = 'guild-local'
  const thumb = `guilds/${guildId}/zone-art/emberimg1/thumb-2.jpg`
  const url = `https://firebasestorage.googleapis.com/v0/b/demo-intrepid.firebasestorage.app/o/${encodeURIComponent(thumb)}?alt=media&token=invented`
  const art = (image: Record<string, unknown> = {}, picks: Record<string, unknown> = { 409: 'emberimg1' }) => ({ images: { emberimg1: { rev: 2, thumb, thumbUrl: url, ...image } }, art: picks })

  test('a raid zone\'s key, as the app finds it', () => {
    assert.equal(raidZoneKey('z409'), '409')
    assert.equal(raidZoneKey('z007'), '7')
    assert.equal(raidZoneKey('zone-glass'), 'r-zone-glass')
    assert.equal(raidZoneKey('z1234567890'), 'r-z1234567890', 'too long for a zone number, so an older raid zone id')
    for (const id of [undefined, '', 'has space', 'x'.repeat(41)]) assert.equal(raidZoneKey(id), undefined, String(id))
  })

  test('is the small copy of the first zone\'s picture', () => {
    assert.equal(zoneImageUrl(art(), guildId, 'z409'), url)
    assert.equal(zoneImageUrl(art({}, { 'r-zone-glass': 'emberimg1' }), guildId, 'zone-glass'), url)
    assert.equal(zoneImageUrl(art(), guildId, 'z410'), null)
    assert.equal(zoneImageUrl(undefined, guildId, 'z409'), null)
  })

  test('is used only when it is this guild\'s own file in Cloud Storage', () => {
    const otherGuild = `guilds/other/zone-art/emberimg1/thumb-2.jpg`
    for (const image of [
      { rev: 3 }, { rev: 0 }, { rev: '2' }, { thumb: otherGuild },
      { thumbUrl: url.replace('firebasestorage.googleapis.com', 'example.test') },
      { thumbUrl: url.replace(encodeURIComponent(thumb), encodeURIComponent(otherGuild)) },
      { thumbUrl: `${url}"onerror` }, { thumbUrl: 42 },
    ]) assert.equal(zoneImageUrl(art(image), guildId, 'z409'), null, JSON.stringify(image))
    assert.equal(zoneImageUrl(art({}, { 409: 'BAD ID' }), guildId, 'z409'), null)
    assert.equal(zoneImageUrl({ images: {}, art: {} }, guildId, 'z409'), null)
    assert.equal(zoneImageUrl({ images: Object.create({ emberimg1: { rev: 2, thumb, thumbUrl: url } }), art: { 409: 'emberimg1' } }, guildId, 'z409'), null, 'inherited entries are not read')
  })

  test('the emulator\'s storage address only when allowed', () => {
    const local = `http://127.0.0.1:19199/v0/b/demo-intrepid.firebasestorage.app/o/${encodeURIComponent(thumb)}?alt=media&token=invented`
    assert.equal(zoneImageUrl(art({ thumbUrl: local }), guildId, 'z409'), null)
    assert.equal(zoneImageUrl(art({ thumbUrl: local }), guildId, 'z409', { allowLocal: true }), local)
  })
})

describe('when to post', () => {
  test('a raid is announced the first time only while scheduled and before its start, then edited until 5 hours after it', () => {
    const none = { messageId: null, postedHash: null }
    assert.equal(planAnnouncement(raid(), none, START - DAY, 'h'), 'post')
    assert.equal(planAnnouncement(raid({ status: 'cancelled' }), none, START - DAY, 'h'), 'none')
    assert.equal(planAnnouncement(raid(), none, START, 'h'), 'none')
    assert.equal(planAnnouncement(raid(), announced({ postedHash: 'h' }), START - DAY, 'h'), 'none')
    assert.equal(planAnnouncement(raid({ status: 'cancelled' }), announced({ postedHash: 'h' }), START - DAY, 'other'), 'edit')
    assert.equal(planAnnouncement(raid(), announced(), START + FOLLOW_AFTER_START - 1, 'other'), 'edit')
    assert.equal(planAnnouncement(raid(), announced(), START + FOLLOW_AFTER_START, 'other'), 'none')
    assert.ok(wouldAnnounce(raid(), START - 1))
    assert.ok(!wouldAnnounce(raid(), START))
    assert.ok(!wouldAnnounce(raid({ status: 'cancelled' }), START - DAY))
  })
})

describe('the reminders', () => {
  test('are due 24 hours and 1 hour before the start, once each', () => {
    assert.deepEqual(dueReminders(raid(), announced(), START - DAY - 1), { send: [], skip: [] })
    assert.deepEqual(dueReminders(raid(), announced(), START - DAY), { send: ['day'], skip: [] })
    assert.deepEqual(dueReminders(raid(), announced({ reminders: { day: { startsAtMillis: START }, hour: null } }), START - DAY + MINUTE), { send: [], skip: [] })
    assert.deepEqual(dueReminders(raid(), announced({ reminders: { day: { startsAtMillis: START }, hour: null } }), START - HOUR), { send: ['hour'], skip: [] })
    assert.deepEqual(dueReminders(raid(), announced({ reminders: { day: { startsAtMillis: START }, hour: { startsAtMillis: START } } }), START - MINUTE), { send: [], skip: [] })
  })

  test('a late check sends only the one still due', () => {
    assert.deepEqual(dueReminders(raid(), announced(), START - 50 * MINUTE), { send: ['hour'], skip: ['day'] })
    assert.deepEqual(dueReminders(raid(), announced(), START), { send: [], skip: [] })
  })

  test('none for a window the announcement was first posted in', () => {
    assert.deepEqual(dueReminders(raid(), announced({ postedAtMillis: START - 10 * HOUR }), START - 10 * HOUR), { send: [], skip: ['day'] })
    assert.deepEqual(dueReminders(raid(), announced({ postedAtMillis: START - 30 * MINUTE }), START - 30 * MINUTE), { send: [], skip: ['day', 'hour'] })
  })

  test('none for a cancelled raid or one with no message', () => {
    assert.deepEqual(dueReminders(raid({ status: 'cancelled' }), announced(), START - DAY), { send: [], skip: [] })
    assert.deepEqual(dueReminders(raid(), announced({ messageId: null }), START - DAY), { send: [], skip: [] })
  })

  test('a reschedule starts them again for the new start', () => {
    const later = START + 2 * DAY
    const sent = announced({ reminders: { day: { startsAtMillis: START }, hour: { startsAtMillis: START } } })
    assert.deepEqual(dueReminders(raid({ startsAt: stamp(later) }), sent, later - DAY), { send: ['day'], skip: [] })
    assert.equal(nextDueAt(raid({ startsAt: stamp(later) }), sent, START), later - DAY)
  })
})

describe('when the sweep looks again', () => {
  test('at the next reminder for the current start', () => {
    assert.equal(nextDueAt(raid(), announced(), START - 3 * DAY), START - DAY)
    assert.equal(nextDueAt(raid(), announced({ reminders: { day: { startsAtMillis: START }, hour: null } }), START - DAY), START - HOUR)
    assert.equal(nextDueAt(raid(), announced({ reminders: { day: { startsAtMillis: START }, hour: { startsAtMillis: START } } }), START - HOUR), null)
  })

  test('never for a cancelled raid, an unannounced one, or after the start', () => {
    assert.equal(nextDueAt(raid({ status: 'cancelled' }), announced(), START - 3 * DAY), null)
    assert.equal(nextDueAt(raid(), announced({ messageId: null }), START - 3 * DAY), null)
    assert.equal(nextDueAt(raid(), announced(), START), null)
    assert.equal(nextDueAt(null, announced(), START - DAY), null)
  })

  test('at the retry after a failure, but not past the follow window', () => {
    assert.equal(nextDueAt(raid({ status: 'cancelled' }), announced(), START - DAY, START - DAY + 4 * MINUTE), START - DAY + 4 * MINUTE)
    assert.equal(nextDueAt(raid(), announced(), START + 4 * HOUR, START + 6 * HOUR), START + FOLLOW_AFTER_START)
    assert.equal(nextDueAt(raid(), announced(), START + FOLLOW_AFTER_START, START + 6 * HOUR), null)
  })

  test('retries back off from 5 minutes to at most an hour', () => {
    assert.deepEqual([1, 2, 3, 4, 5, 6, 20].map((failures) => retryDelay(failures) / MINUTE), [5, 10, 20, 40, 60, 60, 60])
  })
})
