import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test, { before, after } from 'node:test'
import { stopScanner } from '../../src/core/scanner-client.mjs'
import { captureInput, scannerBinary } from '../../src/core/input-capture.mjs'

// Synthetic, nonfunctional tokens assembled so repository scanners do not
// mistake these fixtures for credentials. Exercise the real bundled detector.
const token = ['ghp', 'Ab3De5Gh7Jk9Mn1Pq3St5Vw7Yz9Bc1Ef3Hi5Kl7N'.slice(0, 36)].join('_')

test('real Gitleaks scans Bash strings and repeated secrets without changing the tool input', async () => {
  const input = { command: `curl -H "Authorization: Bearer ${token}" https://example.com\necho ${token}`, description: 'Publish the changes' }
  const original = structuredClone(input)
  const { parameters, metadata } = await captureInput(input)
  assert.equal(metadata.status, 'redacted')
  assert.equal(parameters.command, 'curl -H "Authorization: Bearer [redacted]" https://example.com\necho [redacted]')
  assert.equal(parameters.description, input.description)
  assert.ok(metadata.redactions.some((r) => r.path === '/command' && r.rule_id === 'github-pat'))
  assert.ok(!JSON.stringify({ parameters, metadata }).includes(token))
  assert.deepEqual(input, original)
})

test('Slack destinations and ordinary message content survive while embedded credentials do not', async () => {
  const result = await captureInput({ channel: 'C123', text: `Deploy is complete. Credential: ${token}`, thread_ts: '123.456' })
  assert.equal(result.parameters.channel, 'C123')
  assert.equal(result.parameters.text, 'Deploy is complete. Credential: [redacted]')
  assert.equal(result.parameters.thread_ts, '123.456')
})

test('nested sensitive fields and array values report JSON pointer locations', async () => {
  const result = await captureInput({ headers: { Authorization: 'Bearer synthetic' }, items: [{ 'a/b~c': token }], password: { nested: 'private' } })
  assert.equal(result.parameters.headers.Authorization, '[redacted]')
  assert.equal(result.parameters.password, '[redacted]')
  assert.equal(result.parameters.items[0]['a/b~c'], '[redacted]')
  assert.ok(result.metadata.redactions.some((r) => r.path === '/items/0/a~1b~0c'))
})

test('tool input cannot opt itself out with gitleaks allow comments or inherited configuration', async () => {
  const prior = process.env.GITLEAKS_CONFIG_TOML
  process.env.GITLEAKS_CONFIG_TOML = 'invalid TOML that must never be loaded'
  try {
    const result = await captureInput({ command: `echo ${token} # gitleaks:allow` })
    assert.equal(result.metadata.status, 'redacted')
    assert.ok(!JSON.stringify(result).includes(token))
  } finally {
    if (prior === undefined) delete process.env.GITLEAKS_CONFIG_TOML
    else process.env.GITLEAKS_CONFIG_TOML = prior
  }
})

test('ordinary structured inputs are preserved and metadata-only capture is explicit', async () => {
  const input = { command: 'git init', description: 'Initialize repository', count: 2, enabled: true, optional: null }
  assert.deepEqual((await captureInput(input)).parameters, input)
  assert.equal((await captureInput(input)).metadata.status, 'complete')
  assert.deepEqual(await captureInput(input, 'metadata'), { metadata: { status: 'omitted', reason: 'metadata_only' } })
})

test('oversize inputs are omitted explicitly', async () => {
  const result = await captureInput({ command: 'x'.repeat(512 * 1024) })
  assert.deepEqual(result, { metadata: { status: 'omitted', reason: 'size_limit' } })
})

test('unsupported or modified scanner binaries cannot be executed and inputs stay private', async () => {
  assert.throws(() => scannerBinary({ platform: 'unsupported', arch: 'x64' }), /unsupported_platform/)
  const home = mkdtempSync(path.join(os.tmpdir(), 'actera-scanner-integrity-'))
  const prior = process.env.ACTERA_CLAUDE_BRIDGE_HOME
  process.env.ACTERA_CLAUDE_BRIDGE_HOME = home
  try {
    const { executable } = scannerBinary()
    assert.ok(readFileSync(executable).length > 1000)
    writeFileSync(executable, 'not an executable')
    const result = await captureInput({ command: `echo ${token}` })
    assert.deepEqual(result, { metadata: { status: 'omitted', reason: 'scanner_integrity_failure' } })
  } finally {
    if (prior === undefined) delete process.env.ACTERA_CLAUDE_BRIDGE_HOME
    else process.env.ACTERA_CLAUDE_BRIDGE_HOME = prior
    rmSync(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
  }
})

const suiteHome = mkdtempSync(path.join(os.tmpdir(), 'actera-input-suite-'))
const previousHome = process.env.ACTERA_CLAUDE_BRIDGE_HOME
before(() => { process.env.ACTERA_CLAUDE_BRIDGE_HOME = suiteHome })
after(async () => {
  await stopScanner().catch(() => {})
  if (previousHome === undefined) delete process.env.ACTERA_CLAUDE_BRIDGE_HOME
  else process.env.ACTERA_CLAUDE_BRIDGE_HOME = previousHome
  rmSync(suiteHome, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
})
