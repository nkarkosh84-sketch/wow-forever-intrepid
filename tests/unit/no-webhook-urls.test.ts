// DISCORD-002: the raid channel's webhook address is a Function secret and must never be in the repository (it is public). This reads every tracked file
// and fails on anything shaped like a real Discord webhook address: a 17- to 20-digit id and a token of 60 or more characters. The invented addresses in
// tests ("webhooks/123/invented-token") are too short to match.
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { test } from 'node:test'

const ROOT = join(import.meta.dirname, '..', '..')
const REAL_WEBHOOK = /discord(?:app)?\.com\/api(?:\/v[0-9]+)?\/webhooks\/[0-9]{17,20}\/[A-Za-z0-9_.-]{60,}/i

function trackedFiles(): string[] {
  return execFileSync('git', ['ls-files', '-z'], { cwd: ROOT, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 }).split('\0').filter(Boolean)
}

test('the check recognizes a real-looking webhook address', () => {
  const address = ['https://discord.com/api/webhooks/', '1'.repeat(19), '/', 'A'.repeat(68)].join('')
  assert.match(address, REAL_WEBHOOK)
  assert.match(address.replace('discord.com/api/', 'discordapp.com/api/v10/'), REAL_WEBHOOK)
  assert.doesNotMatch('https://discord.com/api/webhooks/123/invented-token', REAL_WEBHOOK)
})

test('no tracked file holds a Discord webhook address', () => {
  const files = trackedFiles()
  assert.ok(files.length > 100, 'git lists the repository')
  const found: string[] = []
  for (const file of files) {
    const path = join(ROOT, file)
    let size
    try { size = statSync(path).size } catch { continue }
    if (size > 20 * 1024 * 1024) continue
    if (REAL_WEBHOOK.test(readFileSync(path).toString('latin1'))) found.push(file)
  }
  assert.deepEqual(found, [], 'remove the address and rotate the webhook in Discord')
})
