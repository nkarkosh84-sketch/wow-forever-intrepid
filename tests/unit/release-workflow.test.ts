import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import { parseArgs } from 'node:util'

const source = readFileSync(new URL('../../scripts/release.mjs', import.meta.url), 'utf8')
const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor
const execute = new AsyncFunction('spawnSync', 'parseArgs', 'loadEnv', 'createInterface', 'process', 'console',
  source.replace(/^import .+ from .+\r?\n/gm, ''))

async function release({ deploy = true, tty = true, confirmation = 'indexes-ready', failIndexes = false } = {}) {
  const calls: string[] = []
  const messages: string[] = []
  const stopped = new Error('process exited')
  let exitCode: number | undefined
  try {
    await execute(
      (command: string) => {
        calls.push(command)
        const stdout = command === 'git branch --show-current' ? 'main'
          : command.startsWith('git rev-parse') ? 'test-sha' : ''
        return { status: failIndexes && command.includes('deploy --only firestore:indexes') ? 1 : 0, stdout }
      },
      () => parseArgs({ args: deploy ? ['--deploy'] : [], options: { deploy: { type: 'boolean' } } }),
      () => ({ VITE_FIREBASE_PROJECT_ID: 'intrepid-wow-forever', VITE_GUILD_ID: 'invented-guild' }),
      () => ({
        question: async () => { calls.push('confirm-indexes'); return confirmation },
        close: () => calls.push('close-terminal'),
      }),
      {
        cwd: () => 'invented-workspace', stdin: { isTTY: tty }, stdout: {},
        exit: (code: number) => { exitCode = code; throw stopped },
      },
      { log: (message: string) => messages.push(message), error: (message: string) => messages.push(message), warn: () => {} },
    )
  } catch (error) {
    if (error !== stopped) throw error
  }
  return { calls, messages, exitCode }
}

test('release deploys indexes and requires readiness confirmation before Functions', async () => {
  const { calls, exitCode } = await release()
  assert.equal(exitCode, undefined)
  const indexes = calls.findIndex((call) => call.includes('deploy --only firestore:indexes'))
  const confirm = calls.indexOf('confirm-indexes')
  const functions = calls.findIndex((call) => call.includes('deploy --only functions'))
  assert.ok(indexes > calls.indexOf('npm run test:rules'))
  assert.ok(indexes < confirm && confirm < functions)
  assert.ok(calls.indexOf('close-terminal') < functions)
})

for (const options of [{ tty: false }, { confirmation: '' }, { confirmation: 'yes' }, { failIndexes: true }]) {
  test(`release stops before Functions when indexes are not confirmed: ${JSON.stringify(options)}`, async () => {
    const { calls, messages, exitCode } = await release(options)
    assert.equal(exitCode, 1)
    assert.ok(messages.some((message) => message.includes('Stopped:')))
    assert.ok(!calls.some((call) => /deploy --only (functions|firestore:rules|storage|hosting)/.test(call)))
    assert.ok(!calls.some((call) => call.startsWith('git tag')))
  })
}

test('release preflight remains read-only without prompting', async () => {
  const { calls, exitCode } = await release({ deploy: false })
  assert.equal(exitCode, 0)
  assert.ok(!calls.includes('confirm-indexes'))
  assert.ok(!calls.some((call) => call.startsWith('npm ') || call.startsWith('npx ')))
})

test('snapshot and Discord index configuration preserves collection indexes and enables the required group queries', () => {
  const config = JSON.parse(readFileSync(new URL('../../firestore.indexes.json', import.meta.url), 'utf8'))
  const groupField = (collectionGroup: string, fieldPath: string) => ({
    collectionGroup,
    fieldPath,
    indexes: [
      { order: 'ASCENDING', queryScope: 'COLLECTION' },
      { order: 'DESCENDING', queryScope: 'COLLECTION' },
      { arrayConfig: 'CONTAINS', queryScope: 'COLLECTION' },
      { order: 'ASCENDING', queryScope: 'COLLECTION_GROUP' },
    ],
  })
  // DISCORD-002: the 5-minute sweep lists the raids whose post is due across guilds (functions/discord.js).
  assert.deepEqual(config.fieldOverrides, [groupField('raids', 'startsAt'), groupField('discordAnnouncements', 'dueAt')])
  for (const [group, fields] of [
    ['auditLog', ['targetType', 'at']],
    ['raidSnapshotJobs', ['state', 'nextAttemptAt']],
  ] as const) {
    assert.ok(config.indexes.some((index: { collectionGroup: string; queryScope: string; fields: { fieldPath: string; order: string }[] }) =>
      index.collectionGroup === group && index.queryScope === 'COLLECTION_GROUP'
      && JSON.stringify(index.fields) === JSON.stringify(fields.map((fieldPath) => ({ fieldPath, order: 'ASCENDING' })))))
  }
})
