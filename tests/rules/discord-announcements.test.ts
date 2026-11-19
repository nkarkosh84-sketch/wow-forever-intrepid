// DISCORD-002: the state of each raid's Discord post (guilds/{guildId}/discordAnnouncements/{raidId}: the message id, what was posted, the reminders,
// the last error) is written by the Functions only. No rule matches the collection, so the rules' default refuses every client, leaders included.
import { describe, test } from 'node:test'
import { collection, deleteDoc, getDoc, getDocs, setDoc, updateDoc } from 'firebase/firestore'
import { GUILD_ID, PERSONAS } from './support/fixtures.ts'
import { asAdmin, dbFor, expectDenied, guildDoc, setUpGuildEmulator } from './support/harness.ts'

setUpGuildEmulator()

const path = 'discordAnnouncements/planned'

describe('the Discord post state of a raid', () => {
  for (const who of PERSONAS) {
    test(`${who} cannot read, list, create, change or delete it`, async () => {
      await asAdmin((db) => setDoc(guildDoc(db, path), {
        schemaVersion: 1, raidId: 'planned', webhookId: '4242', messageId: '1300000000000000000', lastError: null, failures: 0, dueAt: new Date('2026-12-08T02:00:00Z'),
      }))
      const db = dbFor(who)
      await expectDenied(getDoc(guildDoc(db, path)))
      await expectDenied(getDocs(collection(db, 'guilds', GUILD_ID, 'discordAnnouncements')))
      await expectDenied(setDoc(guildDoc(db, 'discordAnnouncements/forged'), { messageId: '1' }))
      await expectDenied(updateDoc(guildDoc(db, path), { messageId: '2' }))
      await expectDenied(deleteDoc(guildDoc(db, path)))
    })
  }
})
