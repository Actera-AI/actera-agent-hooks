import assert from 'node:assert/strict'
import test from 'node:test'
import { createServer } from 'node:http'
import { createHash } from 'node:crypto'
import { spawn } from 'node:child_process'
import { mkdtemp, rm, mkdir, cp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { setTimeout as delay } from 'node:timers/promises'
import { configure, status } from '../../src/hosts/claude-code/bridge.mjs'
import { deliveryStatus, ensureDelivery, stopDelivery } from '../../src/core/delivery.mjs'

const cli = fileURLToPath(new URL('../../src/hosts/claude-code/cli.mjs', import.meta.url))
async function until(check, timeout = 15000) {
  const deadline = Date.now() + timeout
  while (Date.now() < deadline) { if (await check()) return; await delay(50) }
  assert.fail('Delivery did not reach the expected state without another hook')
}
async function fixture(t) {
  const home = await mkdtemp(path.join(tmpdir(), 'actera-delivery-'))
  const decisions = new Map(), reports = new Map(), attempts = []
  const service = { available: true, loseAcknowledgement: false }
  const server = createServer(async (req, res) => {
    let body = ''; for await (const chunk of req) body += chunk
    const input = JSON.parse(body)
    if (req.url === '/v1/decisions') {
      decisions.set(input.idempotency_key, input)
      res.end(JSON.stringify({ id: input.idempotency_key, status: 'MONITORED', effect: 'ALLOW' })); return
    }
    attempts.push(input.idempotency_key)
    if (!service.available) { res.writeHead(503); res.end('{}'); return }
    reports.set(input.idempotency_key, input)
    if (service.loseAcknowledgement) { service.loseAcknowledgement = false; req.socket.destroy(); return }
    await delay(25)
    res.end('{}')
  })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  await configure({ baseUrl: `http://127.0.0.1:${server.address().port}`, agentId: 'delivery-test', apiKey: 'actera_' + 'x'.repeat(40), capture: 'metadata' }, home)
  t.after(async () => { await stopDelivery(home); await new Promise(resolve => server.close(resolve)); await rm(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }) })
  async function hook(event, id) {
    await new Promise((resolve, reject) => {
      const child = spawn(process.execPath, [cli, 'hook'], { windowsHide: true, env: { ...process.env, ACTERA_CLAUDE_BRIDGE_HOME: home, CLAUDE_PLUGIN_OPTION_MODE: 'Monitoring' } })
      let error = ''; child.stderr.on('data', data => error += data)
      child.on('error', reject); child.on('close', code => code ? reject(new Error(error)) : resolve())
      child.stdin.end(JSON.stringify({ hook_event_name: event, session_id: 'delivery', tool_use_id: id, tool_name: 'Bash', tool_input: { command: 'echo test' } }))
    })
  }
  return { home, service, decisions, reports, attempts, hook }
}

test('twenty concurrent real hook processes drain all outcomes with a single sender', async t => {
  const f = await fixture(t)
  const ids = Array.from({ length: 20 }, (_, i) => `call-${i}`)
  await Promise.all(ids.map(id => f.hook('PreToolUse', id)))
  await Promise.all(ids.map(id => f.hook('PostToolUse', id)))
  await until(async () => (await status(f.home)).pending === 0)
  assert.equal(f.decisions.size, 20)
  assert.equal(f.reports.size, 20)
  assert.equal(f.attempts.length, 20, 'Concurrent hooks must not resend the same queue head')
  assert.equal((await deliveryStatus(f.home)).state, 'idle')
})

test('a new sender replaces an old persistent sender and delivers its outcome records', async t => {
  const f = await fixture(t)
  const older = path.join(f.home, 'older-package')
  await mkdir(path.join(older, 'bin'), { recursive: true })
  await cp(fileURLToPath(new URL('../../src', import.meta.url)), path.join(older, 'src'), { recursive: true })
  await cp(fileURLToPath(new URL('../../bin/delivery-worker.mjs', import.meta.url)), path.join(older, 'bin/delivery-worker.mjs'))
  const implementation = path.join(older, 'src/core/delivery.mjs')
  await writeFile(implementation, (await readFile(implementation, 'utf8')).replace('const revision = 3', 'const revision = 2'))
  const worker = spawn(process.execPath, [path.join(older, 'bin/delivery-worker.mjs'), f.home], { windowsHide: true, stdio: 'ignore' })
  worker.on('error', error => { throw error })
  t.after(() => worker.kill())
  await until(async () => (await deliveryStatus(f.home)).revision === 2)
  const oldPid = (await deliveryStatus(f.home)).pid
  await Promise.all(Array.from({ length: 8 }, () => ensureDelivery(f.home)))
  const current = await deliveryStatus(f.home)
  assert.equal(current.revision, 3)
  assert.notEqual(current.pid, oldPid)
  await f.hook('PreToolUse', 'upgraded')
  await f.hook('PostToolUse', 'upgraded')
  await until(async () => f.reports.size === 1 && (await status(f.home)).pending === 0)
  assert.equal(f.attempts.length, 1)
  assert.ok([...f.reports.values()].every(report => !('_tool_call_key' in report)))
})

test('outage retries autonomously, survives worker restart, and exposes queue age and recovery', async t => {
  const f = await fixture(t)
  f.service.available = false
  for (const id of ['one', 'two']) await f.hook('PreToolUse', id)
  await Promise.all(['one', 'two'].map(id => f.hook('PostToolUse', id)))
  await until(async () => (await deliveryStatus(f.home)).state === 'retrying')
  let snapshot = await status(f.home)
  assert.equal(snapshot.queue.executionReports, 2)
  assert.equal(snapshot.queue.decisionRetries, 0)
  assert.ok(snapshot.queue.oldestPendingAt)
  assert.match(snapshot.delivery.lastError.message, /503/)
  assert.ok(snapshot.delivery.nextRetryAt)
  await stopDelivery(f.home)
  assert.equal((await status(f.home)).delivery.state, 'stopped')
  assert.equal((await status(f.home)).pending, 2)
  await ensureDelivery(f.home)
  await until(async () => (await deliveryStatus(f.home)).state === 'retrying')
  f.service.available = true
  // No hook, status command, or manual flush triggers delivery after recovery.
  await until(async () => f.reports.size === 2 && (await status(f.home)).pending === 0)
  snapshot = await status(f.home)
  assert.equal(snapshot.delivery.state, 'idle')
  assert.ok(snapshot.delivery.recoveredAt)
  assert.ok(snapshot.delivery.lastError)
})

test('an acknowledgement lost after acceptance retries the same idempotency key', async t => {
  const f = await fixture(t)
  f.service.loseAcknowledgement = true
  await f.hook('PreToolUse', 'lost-ack')
  await f.hook('PostToolUse', 'lost-ack')
  await until(async () => f.attempts.length === 2 && (await status(f.home)).pending === 0)
  assert.equal(f.reports.size, 1)
  assert.equal(f.attempts[0], f.attempts[1])
})


test('a killed sender releases its OS lock and a replacement resumes durable reports', async t => {
  const f = await fixture(t)
  f.service.available = false
  await f.hook('PreToolUse', 'crash')
  await f.hook('PostToolUse', 'crash')
  await until(async () => (await deliveryStatus(f.home)).state === 'retrying')
  const worker = await deliveryStatus(f.home)
  process.kill(worker.pid, 'SIGKILL')
  await until(async () => !(await deliveryStatus(f.home)).running)
  assert.equal((await status(f.home)).pending, 1)
  f.service.available = true
  await ensureDelivery(f.home)
  await until(async () => f.reports.size === 1 && (await status(f.home)).pending === 0)
  assert.notEqual((await deliveryStatus(f.home)).pid, worker.pid)
})

test('a post-tool hook saves its outcome promptly while an unreachable sender holds the delivery port', async t => {
  const f = await fixture(t)
  // A sender for this directory whose discovery file is gone answers the
  // election probe but cannot be controlled or replaced.
  const id = createHash('sha256').update(process.platform === 'win32' ? path.resolve(f.home).toLowerCase() : path.resolve(f.home)).digest('hex')
  const orphan = createServer((req, res) => {
    req.resume()
    if (req.url === '/identity') res.end(JSON.stringify({ identity: id, protocol: 1 }))
    else { res.writeHead(403); res.end('{}') }
  })
  await new Promise(resolve => orphan.listen(20000 + parseInt(id.slice(0, 8), 16) % 30000, '127.0.0.1', resolve))
  t.after(() => new Promise(resolve => orphan.close(resolve)))
  await f.hook('PreToolUse', 'orphaned')
  const started = Date.now()
  await f.hook('PostToolUse', 'orphaned')
  assert.ok(Date.now() - started < 2500, 'The hook must not wait for a contested sender')
  const snapshot = await status(f.home)
  assert.equal(snapshot.queue.executionReports, 1)
  assert.equal(snapshot.delivery.running, false)
  await new Promise(resolve => orphan.close(resolve))
  await ensureDelivery(f.home)
  await until(async () => f.reports.size === 1 && (await status(f.home)).pending === 0)
})

const alive = pid => { try { process.kill(pid, 0); return true } catch { return false } }

test('a sender whose discovery file was deleted publishes it again and keeps delivering', async t => {
  const f = await fixture(t)
  await ensureDelivery(f.home)
  const { pid } = await deliveryStatus(f.home)
  await rm(path.join(f.home, 'delivery-worker.json'))
  await until(async () => (await deliveryStatus(f.home)).running)
  assert.equal((await deliveryStatus(f.home)).pid, pid)
  await f.hook('PreToolUse', 'republished')
  await f.hook('PostToolUse', 'republished')
  await until(async () => f.reports.size === 1 && (await status(f.home)).pending === 0)
  assert.equal((await deliveryStatus(f.home)).pid, pid)
})

test('removing the bridge directory stops its sender', async t => {
  const f = await fixture(t)
  await ensureDelivery(f.home)
  const { pid } = await deliveryStatus(f.home)
  await rm(f.home, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
  await until(async () => !alive(pid))
})

test('an idle sender exits, but not while it still has reports to deliver', async t => {
  const previous = process.env.ACTERA_CLAUDE_DELIVERY_IDLE_MS
  process.env.ACTERA_CLAUDE_DELIVERY_IDLE_MS = '1000'
  t.after(() => { if (previous === undefined) delete process.env.ACTERA_CLAUDE_DELIVERY_IDLE_MS; else process.env.ACTERA_CLAUDE_DELIVERY_IDLE_MS = previous })
  const f = await fixture(t)
  f.service.available = false
  await f.hook('PreToolUse', 'idle')
  await f.hook('PostToolUse', 'idle')
  await until(async () => (await deliveryStatus(f.home)).state === 'retrying')
  const { pid } = await deliveryStatus(f.home)
  await delay(2500)
  assert.ok(alive(pid), 'A sender with a backlog must keep retrying')
  f.service.available = true
  await until(async () => f.reports.size === 1 && (await status(f.home)).pending === 0)
  await until(async () => !alive(pid))
  assert.equal((await deliveryStatus(f.home)).state, 'stopped')
})

async function disconnectCli(home, ...args) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [cli, 'disconnect', ...args], { windowsHide: true, env: { ...process.env, ACTERA_CLAUDE_BRIDGE_HOME: home } })
    let stdout = '', stderr = ''
    child.stdout.on('data', data => stdout += data); child.stderr.on('data', data => stderr += data)
    child.on('error', reject); child.on('close', code => resolve({ code, stdout, stderr }))
  })
}

test('disconnect delivers queued reports, stops the sender and removes local state', async t => {
  const f = await fixture(t)
  f.service.available = false
  await f.hook('PreToolUse', 'disconnect')
  await f.hook('PostToolUse', 'disconnect')
  await until(async () => (await deliveryStatus(f.home)).state === 'retrying')
  const { pid } = await deliveryStatus(f.home)
  const refused = await disconnectCli(f.home)
  assert.equal(refused.code, 1)
  assert.match(refused.stderr, /1 report\(s\) could not be delivered .*--discard/)
  assert.equal((await status(f.home)).pending, 1)
  f.service.available = true
  const result = await disconnectCli(f.home)
  assert.equal(result.code, 0, result.stderr)
  assert.equal(JSON.parse(result.stdout).disconnected, true)
  assert.equal(f.reports.size, 1)
  await assert.rejects(readFile(path.join(f.home, 'config.json')), { code: 'ENOENT' })
  await until(async () => !alive(pid))
})

test('disconnect --discard removes undeliverable reports', async t => {
  const f = await fixture(t)
  f.service.available = false
  await f.hook('PreToolUse', 'discard')
  await f.hook('PostToolUse', 'discard')
  const result = await disconnectCli(f.home, '--discard')
  assert.equal(result.code, 0, result.stderr)
  assert.equal(f.reports.size, 0)
  await assert.rejects(readFile(path.join(f.home, 'config.json')), { code: 'ENOENT' })
})
