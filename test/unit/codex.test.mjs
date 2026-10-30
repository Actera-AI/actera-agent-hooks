import assert from 'node:assert/strict'
import { execFileSync, spawn } from 'node:child_process'
import { createServer } from 'node:http'
import { mkdtemp, readdir, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import test from 'node:test'
import { configure, flush } from '../../src/core/bridge.mjs'
import { deliveryStatus, stopDelivery } from '../../src/core/delivery.mjs'
import { stopScanner } from '../../src/core/scanner-client.mjs'
import { loadConfig, mcpToolForHook, transcriptOutcome } from '../../src/hosts/codex/bridge.mjs'
import { saveSetting } from '../../src/hosts/codex/settings.mjs'

const cli = fileURLToPath(new URL('../../src/hosts/codex/cli.mjs', import.meta.url))
const key = 'actera_' + 'c'.repeat(40)
const agentId = 'codex-local-test'

// A controllable Actera: decisions get the status `next` returns; their
// later status comes from `statuses`, so a test can approve while a hook holds.
async function fixture(t, { decide = () => 'ALLOWED', available = () => true } = {}) {
  const home = await mkdtemp(path.join(os.tmpdir(), 'actera-codex-test-'))
  const decisions = new Map()
  const reports = []
  const requests = []
  const server = createServer(async (request, response) => {
    let body = ''
    for await (const chunk of request) body += chunk
    const parsed = body ? JSON.parse(body) : undefined
    requests.push({ path: request.url, body: parsed })
    response.setHeader('content-type', 'application/json')
    if (!available(request.url)) { response.statusCode = 503; return response.end('{}') }
    if (request.url === `/v1/agents/${agentId}/readiness`)
      return response.end(JSON.stringify({ agent_id: agentId, status: 'ACTIVE', ready: true }))
    if (request.url === '/v1/decisions') {
      const id = `00000000-0000-4000-8000-${String(decisions.size + 1).padStart(12, '0')}`
      const status = decide(parsed)
      decisions.set(id, { id, status, agent_id: agentId, action_type: parsed.action.type, idempotency_key: parsed.idempotency_key, request: parsed })
      return response.end(JSON.stringify({ id, status, explanation: status === 'BLOCKED' ? 'Fixture blocks this.' : undefined }))
    }
    const lookup = request.url.match(/^\/v1\/decisions\/([^/]+)\/status$/)
    if (lookup) {
      const { request: _, ...decision } = decisions.get(lookup[1])
      return response.end(JSON.stringify(decision))
    }
    if (request.url.endsWith('/reports')) { reports.push(parsed); response.statusCode = 201; return response.end('{}') }
    response.statusCode = 404
    response.end('{}')
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  t.after(async () => {
    await stopDelivery(home)
    await new Promise((resolve) => server.close(resolve))
    await stopScanner(path.join(home, 'scanner')).catch(() => {})
    await rm(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
  })
  const baseUrl = `http://127.0.0.1:${server.address().port}`
  await configure({ baseUrl, apiKey: key, agentId, capture: 'tool-inputs' }, home)
  return { home, baseUrl, decisions, reports, requests }
}

function runHook(home, input, env = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [cli, 'hook'], {
      env: { ...process.env, ACTERA_CODEX_BRIDGE_HOME: home, ACTERA_HOLD_POLL_MS: '50', ...env },
      windowsHide: true,
    })
    let stdout = '', stderr = ''
    child.stdout.on('data', (chunk) => { stdout += chunk })
    child.stderr.on('data', (chunk) => { stderr += chunk })
    child.on('error', reject)
    child.on('close', (code) => resolve({ code, stdout, stderr, output: stdout.trim() ? JSON.parse(stdout) : null }))
    child.stdin.end(JSON.stringify(input))
  })
}

const call = (id, command = 'echo hello', extra = {}) => ({
  session_id: 'codex-session', turn_id: 'turn-1', cwd: '/work', model: 'gpt-test', permission_mode: 'default',
  tool_name: 'Bash', tool_use_id: id, tool_input: { command }, ...extra,
})

async function transcript(home, entries) {
  const file = path.join(home, 'rollout.jsonl')
  await writeFile(file, entries.map(([id, status]) => JSON.stringify({ type: 'event_msg', payload: { type: 'item_completed', item: { type: 'CommandExecution', id, status, exit_code: status === 'completed' ? 0 : 1 } } })).join('\n') + '\n')
  return file
}

test('monitoring records the call, keeps Codex output empty and reports the transcript outcome', async (t) => {
  const f = await fixture(t, { decide: () => 'MONITORED' })
  const file = await transcript(f.home, [['exec-ok', 'completed'], ['exec-bad', 'failed']])
  for (const id of ['exec-ok', 'exec-bad']) {
    const pre = await runHook(f.home, { hook_event_name: 'PreToolUse', ...call(id) })
    assert.equal(pre.code, 0)
    assert.equal(pre.output, null)
    await runHook(f.home, { hook_event_name: 'PostToolUse', transcript_path: file, tool_response: '', ...call(id) })
  }
  await flush(await loadConfig(f.home), { home: f.home, force: true })
  const decision = f.requests.find((r) => r.path === '/v1/decisions').body
  assert.equal(decision.mode, 'MONITORING')
  assert.equal(decision.action.type, 'codex.tool.Bash')
  assert.deepEqual(decision.action.attributes.parameters, { command: 'echo hello' })
  assert.match(decision.idempotency_key, /^codex-tool:[0-9a-f]{64}$/)
  assert.deepEqual(decision.context.codex, { session_id: 'codex-session', turn_id: 'turn-1', cwd: '/work', permission_mode: 'default', model: 'gpt-test', tool_use_id: 'exec-ok' })
  assert.deepEqual(f.reports.map((r) => [r.details.tool_use_id, r.outcome, r.details.outcome_source]).sort(), [
    ['exec-bad', 'FAILURE', 'codex_transcript'],
    ['exec-ok', 'SUCCESS', 'codex_transcript'],
  ])
  assert.ok(f.reports.every((r) => r.idempotency_key.startsWith('codex-tool-outcome:') && !('_tool_call_key' in r)))
})

test('a call missing from the transcript is reported as UNKNOWN', async (t) => {
  const f = await fixture(t)
  await runHook(f.home, { hook_event_name: 'PreToolUse', ...call('exec-1') })
  await runHook(f.home, { hook_event_name: 'PostToolUse', transcript_path: path.join(f.home, 'missing.jsonl'), ...call('exec-1') })
  await flush(await loadConfig(f.home), { home: f.home, force: true })
  assert.deepEqual(f.reports.map((r) => [r.outcome, r.details.outcome_source]), [['UNKNOWN', 'unavailable']])
})

test('enforcing denies a blocked call with the reason from Actera', async (t) => {
  const f = await fixture(t, { decide: () => 'BLOCKED' })
  await saveSetting(f.home, 'mode', 'enforcing')
  const result = await runHook(f.home, { hook_event_name: 'PreToolUse', ...call('exec-1') })
  assert.equal(result.output.hookSpecificOutput.permissionDecision, 'deny')
  assert.match(result.output.hookSpecificOutput.permissionDecisionReason, /blocked: Fixture blocks this\./)
})

test('a held call is released when a reviewer approves it while the hook waits', async (t) => {
  const f = await fixture(t, { decide: () => 'PENDING_APPROVAL' })
  await saveSetting(f.home, 'mode', 'enforcing')
  const held = runHook(f.home, { hook_event_name: 'PreToolUse', ...call('exec-1') })
  while (!f.decisions.size) await new Promise((resolve) => setTimeout(resolve, 20))
  await new Promise((resolve) => setTimeout(resolve, 200))
  ;[...f.decisions.values()][0].status = 'APPROVED'
  const result = await held
  assert.equal(result.output.hookSpecificOutput.permissionDecision, 'allow')
  assert.match(result.output.hookSpecificOutput.permissionDecisionReason, /approved$/)
  // The approval released that call; an identical retry needs its own approval.
  const again = await runHook(f.home, { hook_event_name: 'PreToolUse', ...call('exec-2') }, { ACTERA_HOLD_SECONDS: '0.3' })
  assert.equal(again.output.hookSpecificOutput.permissionDecision, 'deny')
})

test('a rejection during the hold denies the call', async (t) => {
  const f = await fixture(t, { decide: () => 'PENDING_APPROVAL' })
  await saveSetting(f.home, 'mode', 'enforcing')
  const held = runHook(f.home, { hook_event_name: 'PreToolUse', ...call('exec-1') })
  while (!f.decisions.size) await new Promise((resolve) => setTimeout(resolve, 20))
  ;[...f.decisions.values()][0].status = 'REJECTED'
  const result = await held
  assert.equal(result.output.hookSpecificOutput.permissionDecision, 'deny')
  assert.match(result.output.hookSpecificOutput.permissionDecisionReason, /rejected/)
})

test('a hold that runs out denies, and the approved retry reuses the same Decision once', async (t) => {
  const f = await fixture(t, { decide: () => 'PENDING_APPROVAL' })
  await saveSetting(f.home, 'mode', 'enforcing')
  const first = await runHook(f.home, { hook_event_name: 'PreToolUse', ...call('exec-1') }, { ACTERA_HOLD_SECONDS: '0.3' })
  assert.match(first.output.hookSpecificOutput.permissionDecisionReason, /still awaiting approval/)
  ;[...f.decisions.values()][0].status = 'APPROVED'
  const retry = await runHook(f.home, { hook_event_name: 'PreToolUse', ...call('exec-2') })
  assert.equal(retry.output.hookSpecificOutput.permissionDecision, 'allow')
  assert.equal(f.decisions.size, 1, 'The retry must reuse the approved Decision')
  const changed = await runHook(f.home, { hook_event_name: 'PreToolUse', ...call('exec-3', 'echo other') }, { ACTERA_HOLD_SECONDS: '0.3' })
  assert.equal(changed.output.hookSpecificOutput.permissionDecision, 'deny')
  assert.equal(f.decisions.size, 2, 'Changed arguments need a new Decision')
})

test('enforcing fails closed when Actera is unavailable, and open only when configured', async (t) => {
  const f = await fixture(t, { available: (url) => url !== '/v1/decisions' })
  await saveSetting(f.home, 'mode', 'enforcing')
  const closed = await runHook(f.home, { hook_event_name: 'PreToolUse', ...call('exec-1') })
  assert.match(closed.output.hookSpecificOutput.permissionDecisionReason, /could not evaluate this tool call: Actera decisions returned HTTP 503/)
  await saveSetting(f.home, 'evaluationFailure', 'allow')
  const open = await runHook(f.home, { hook_event_name: 'PreToolUse', ...call('exec-2') })
  assert.equal(open.output, null)
  const monitoring = await runHook(f.home, { hook_event_name: 'PreToolUse', ...call('exec-3') }, { ACTERA_MODE: 'monitoring', ACTERA_EVALUATION_FAILURE: 'block' })
  assert.equal(monitoring.output, null)
})

test('invalid settings deny instead of silently downgrading enforcement', async (t) => {
  const f = await fixture(t)
  const result = await runHook(f.home, { hook_event_name: 'PreToolUse', ...call('exec-1') }, { ACTERA_MODE: 'strict' })
  assert.equal(result.output.hookSpecificOutput.permissionDecision, 'deny')
  assert.match(result.output.hookSpecificOutput.permissionDecisionReason, /Invalid Actera mode/)
  assert.equal(f.decisions.size, 0)
})

test('MCP tools use the tool name as the action and keep the server key as evidence', async (t) => {
  assert.deepEqual(mcpToolForHook({ tool_name: 'mcp__github__create_issue' }), { server_key: 'github', tool_name: 'create_issue' })
  assert.equal(mcpToolForHook({ tool_name: 'apply_patch' }), undefined)
  assert.throws(() => mcpToolForHook({ tool_name: 'mcp__github' }), /invalid MCP tool name/)
  const f = await fixture(t)
  await runHook(f.home, { hook_event_name: 'PreToolUse', ...call('exec-1', undefined, { tool_name: 'mcp__github__create_issue', tool_input: { title: 'x' } }) })
  const decision = f.requests.find((r) => r.path === '/v1/decisions').body
  assert.equal(decision.action.type, 'codex.mcp.create_issue')
  assert.deepEqual(decision.action.attributes.mcp, { server_key: 'github', tool_name: 'create_issue' })
})

test('secrets in a command are redacted by a scanner that exits with the hook', async (t) => {
  const f = await fixture(t)
  const secret = 'ghp_' + 'A1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6Q7r8'
  await runHook(f.home, { hook_event_name: 'PreToolUse', ...call('exec-1', `git init && echo ${secret}`) })
  const decision = f.requests.find((r) => r.path === '/v1/decisions').body
  assert.ok(!JSON.stringify(decision).includes(secret))
  assert.equal(decision.action.attributes.parameters.command, 'git init && echo [redacted]')
  const scanner = await readdir(path.join(f.home, 'scanner'))
  assert.ok(scanner.some((name) => /^[0-9a-f]{64}\.exe$|^[0-9a-f]{64}$/.test(name)), 'The verified scanner is cached in the Codex folder')
  assert.ok(!scanner.some((name) => name.startsWith('helper-')), 'No shared helper is left for later calls')
})

// Codex does not finish a call until every process its hook started has exited.
test('a hook sends its reports itself and leaves no process running', async (t) => {
  const f = await fixture(t)
  const file = await transcript(f.home, [['exec-1', 'completed']])
  await runHook(f.home, { hook_event_name: 'PreToolUse', ...call('exec-1', 'git status') })
  await runHook(f.home, { hook_event_name: 'PostToolUse', transcript_path: file, ...call('exec-1', 'git status') })
  assert.equal(f.reports.length, 1, 'The post-tool hook delivered the report before exiting')
  assert.equal((await deliveryStatus(f.home)).running, false, 'No delivery worker was started')
  const children = execFileSync(process.platform === 'win32' ? 'powershell' : 'ps', process.platform === 'win32'
    ? ['-NoProfile', '-Command', `Get-CimInstance Win32_Process | Where-Object { $_.ProcessId -ne $PID -and $_.CommandLine -like '*${path.basename(f.home)}*' } | Measure-Object | Select-Object -ExpandProperty Count`]
    : ['-eo', 'args'], { encoding: 'utf8' })
  const running = process.platform === 'win32' ? Number(children.trim()) : children.split('\n').filter((line) => line.includes(path.basename(f.home))).length
  assert.equal(running, 0, 'No helper process references the bridge folder')
})

test('transcript outcomes ignore other calls and partial lines', async (t) => {
  const home = await mkdtemp(path.join(os.tmpdir(), 'actera-codex-transcript-'))
  t.after(() => rm(home, { recursive: true, force: true }))
  const file = await transcript(home, [['exec-a', 'completed'], ['exec-b', 'failed']])
  await writeFile(file, '{"payload":{"item":{"id":"exec-c","status":"comp', { flag: 'a' })
  assert.equal(await transcriptOutcome({ transcript_path: file, tool_use_id: 'exec-a' }), 'SUCCESS')
  assert.equal(await transcriptOutcome({ transcript_path: file, tool_use_id: 'exec-b' }), 'FAILURE')
  assert.equal(await transcriptOutcome({ transcript_path: file, tool_use_id: 'exec-c' }), undefined)
  assert.equal(await transcriptOutcome({ tool_use_id: 'exec-a' }), undefined)
})
