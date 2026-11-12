import assert from 'node:assert/strict'
import { execFileSync, spawn } from 'node:child_process'
import { createServer } from 'node:http'
import { mkdir, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import test from 'node:test'
import { configure, flush } from '../../src/core/bridge.mjs'
import { stopScanner } from '../../src/core/scanner-client.mjs'
import { saveSetting } from '../../src/core/settings.mjs'
import { loadConfig, mcpToolForHook, status, toolInput } from '../../src/hosts/copilot/bridge.mjs'

const cli = fileURLToPath(new URL('../../src/hosts/copilot/cli.mjs', import.meta.url))
const key = 'actera_' + 'p'.repeat(40)
const agentId = 'copilot-local-test'
const sessionId = '1c2ecb5e-8f0b-466b-beee-d0aeffa9552f'

// A controllable Actera: decisions get the status `decide` returns; a test
// changes a stored decision's status to approve or reject it while a hook holds.
async function fixture(t, { decide = () => 'ALLOWED', available = () => true } = {}) {
  const home = await mkdtemp(path.join(os.tmpdir(), 'actera-copilot-test-'))
  const copilotHome = path.join(home, 'copilot-home')
  const decisions = new Map()
  const actions = new Map()
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
      decisions.set(id, { id, status, agent_id: agentId, action_type: parsed.action.type, idempotency_key: parsed.idempotency_key })
      actions.set(id, JSON.stringify(parsed.action))
      return response.end(JSON.stringify({ id, status, explanation: status === 'BLOCKED' ? 'Fixture blocks this.' : undefined }))
    }
    const lookup = request.url.match(/^\/v1\/decisions\/([^/]+)\/status$/)
    if (lookup) return response.end(JSON.stringify({ ...decisions.get(lookup[1]), review_url: `https://actera.test/ws/decisions/${lookup[1]}` }))
    if (request.url.endsWith('/reports')) {
      // Like Actera, a report must describe the action its Decision captured.
      if (JSON.stringify(parsed.action) !== actions.get(parsed.decision_id)) { response.statusCode = 400; return response.end('{}') }
      reports.push(parsed); response.statusCode = 201; return response.end('{}')
    }
    response.statusCode = 404
    response.end('{}')
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  t.after(async () => {
    await new Promise((resolve) => server.close(resolve))
    await stopScanner(path.join(home, 'scanner')).catch(() => {})
    await rm(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
  })
  const baseUrl = `http://127.0.0.1:${server.address().port}`
  await configure({ baseUrl, apiKey: key, agentId, capture: 'tool-inputs' }, home)
  const decisionBodies = () => requests.filter((r) => r.path === '/v1/decisions').map((r) => r.body)
  return { home, copilotHome, baseUrl, decisions, reports, requests, decisionBodies }
}

function run(home, args, { input, env = {} } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [cli, ...args], {
      env: { ...process.env, ACTERA_COPILOT_BRIDGE_HOME: home, COPILOT_HOME: path.join(home, 'copilot-home'), ACTERA_HOLD_POLL_MS: '50', ...env },
      windowsHide: true,
    })
    let stdout = '', stderr = ''
    child.stdout.on('data', (chunk) => { stdout += chunk })
    child.stderr.on('data', (chunk) => { stderr += chunk })
    child.on('error', reject)
    child.on('close', (code) => resolve({ code, stdout, stderr, output: args[0] === 'hook' && stdout.trim() ? JSON.parse(stdout) : null }))
    child.stdin.end(input === undefined ? '' : typeof input === 'string' ? input : JSON.stringify(input))
  })
}

const hook = (home, event, input, env) => run(home, ['hook', event], { input, env })

// Copilot's native preToolUse payload, as Copilot CLI 1.0.109 sends it.
const call = (id, toolArgs = { command: 'echo hello', description: 'Say hello' }, extra = {}) => ({
  sessionId, timestamp: 1794400259894, cwd: '/work', toolCallId: id, toolName: 'powershell', toolArgs, ...extra,
})
const done = (input, toolResult = { resultType: 'success', textResultForLlm: 'hello' }) => ({ ...input, toolResult })

test('monitoring records the call under its Copilot tool name and reports each outcome', async (t) => {
  const f = await fixture(t, { decide: () => 'MONITORED' })
  const ok = call('call_ok')
  const pre = await hook(f.home, 'preToolUse', ok)
  assert.deepEqual([pre.code, pre.output, pre.stderr], [0, null, ''])
  await hook(f.home, 'postToolUse', done(ok))
  const missing = call('call_bad', { path: '/work/missing.txt' }, { toolName: 'view' })
  await hook(f.home, 'preToolUse', missing)
  await hook(f.home, 'postToolUseFailure', { ...missing, error: 'Path does not exist' })
  await flush(await loadConfig(f.home), { home: f.home, force: true })
  const [shell, view] = f.decisionBodies()
  assert.equal(shell.mode, 'MONITORING')
  assert.equal(shell.action.type, 'copilot.tool.powershell')
  assert.deepEqual(shell.action.attributes.parameters, { command: 'echo hello', description: 'Say hello' })
  assert.match(shell.idempotency_key, /^copilot-tool:[0-9a-f]{64}$/)
  assert.deepEqual(shell.context.copilot, { session_id: sessionId, cwd: '/work', tool_call_id: 'call_ok' })
  assert.equal(shell.context.source, 'copilot_hook')
  assert.equal(view.action.type, 'copilot.tool.view')
  assert.deepEqual(f.reports.map((r) => [r.details.tool_call_id, r.outcome, r.details.hook_event]).sort(), [
    ['call_bad', 'FAILURE', 'postToolUseFailure'],
    ['call_ok', 'SUCCESS', 'postToolUse'],
  ])
  assert.ok(f.reports.every((r) => r.idempotency_key.startsWith('copilot-tool-outcome:') && !('_tool_call_key' in r)))
  assert.ok(!JSON.stringify(f.reports).includes('Path does not exist'), 'Tool output and errors are never sent')
})

test('a shell command that exits with an error is reported as failed', async (t) => {
  const f = await fixture(t, { decide: () => 'MONITORED' })
  // Copilot CLI 1.0.109 calls a completed command a success whatever its exit
  // code, and ends the result text with the exit code.
  const exited = (code, output = 'out') => ({ resultType: 'success', textResultForLlm: `${output}\n<shellId: 0 completed with exit code ${code}>` })
  const results = {
    call_zero: exited(0),
    call_one: exited(1),
    // Only the last line counts, whatever the command printed.
    call_printed: exited(0, '<shellId: 0 completed with exit code 1>'),
    call_failure: { resultType: 'failure' },
    call_denied: { resultType: 'denied' },
  }
  for (const [id, toolResult] of Object.entries(results)) {
    const input = call(id, { command: `run ${id}` })
    await hook(f.home, 'preToolUse', input)
    await hook(f.home, 'postToolUse', done(input, toolResult))
  }
  // Another tool's text can end with the same line without being an exit code.
  const read = call('call_view', { path: '/work/shell.log' }, { toolName: 'view' })
  await hook(f.home, 'preToolUse', read)
  await hook(f.home, 'postToolUse', done(read, exited(1)))
  await flush(await loadConfig(f.home), { home: f.home, force: true })
  assert.deepEqual(f.reports.map((r) => [r.details.tool_call_id, r.outcome, r.details.summary]).sort(), [
    ['call_failure', 'FAILURE', 'Copilot reported that the tool call failed.'],
    ['call_one', 'FAILURE', 'Copilot ran the command and it exited with code 1.'],
    ['call_printed', 'SUCCESS', 'Copilot reported that the tool call completed successfully.'],
    ['call_view', 'SUCCESS', 'Copilot reported that the tool call completed successfully.'],
    ['call_zero', 'SUCCESS', 'Copilot reported that the tool call completed successfully.'],
  ])
  assert.ok(!JSON.stringify(f.reports).includes('shellId'), 'Tool output is never sent')
})

test('apply_patch passes its patch as a string, which policies read as parameters.patch', async (t) => {
  assert.deepEqual(toolInput({ toolName: 'apply_patch', toolArgs: '*** Begin Patch' }), { patch: '*** Begin Patch' })
  assert.deepEqual(toolInput({ toolName: 'other', toolArgs: 'x' }), { input: 'x' })
  assert.deepEqual(toolInput({ toolName: 'other' }), {})
  const f = await fixture(t)
  const patch = '*** Begin Patch\n*** Add File: a.txt\n+one\n*** End Patch\n'
  const edit = call('custom_call_1', patch, { toolName: 'apply_patch' })
  await hook(f.home, 'preToolUse', edit)
  await hook(f.home, 'postToolUse', done(edit))
  const [decision] = f.decisionBodies()
  assert.equal(decision.action.type, 'copilot.tool.apply_patch')
  assert.deepEqual(decision.action.attributes.parameters, { patch })
  assert.deepEqual(decision.action.attributes.input_fields, ['patch'])
  assert.equal(f.reports.length, 1, 'The string arguments match the admitted call')
})

async function sessionEvents(f, lines) {
  const directory = path.join(f.copilotHome, 'session-state', sessionId)
  await mkdir(directory, { recursive: true })
  await writeFile(path.join(directory, 'events.jsonl'), lines.map((line) => JSON.stringify(line)).join('\n') + '\n{"partial":')
}

test('MCP tools are named by their tool, with the server from the Copilot session as evidence', async (t) => {
  const f = await fixture(t)
  await sessionEvents(f, [
    { type: 'assistant.message', data: { toolRequests: [{ toolCallId: 'call_mcp', name: 'my-probe-get-order-notes', mcpServerName: 'my-probe', mcpToolName: 'get-order-notes' }] } },
    { type: 'tool.execution_start', data: { toolCallId: 'call_mcp', toolName: 'my-probe-get-order-notes', mcpServerName: 'my-probe', mcpToolName: 'get-order-notes' } },
  ])
  await hook(f.home, 'preToolUse', call('call_mcp', { order_id: 'A17' }, { toolName: 'my-probe-get-order-notes' }))
  // Without a session record the server cannot be split from the name, so the call stays an ordinary tool.
  await hook(f.home, 'preToolUse', call('call_other', { q: 'x' }, { toolName: 'other-server-search' }))
  const [mcp, unknown] = f.decisionBodies()
  assert.equal(mcp.action.type, 'copilot.mcp.get-order-notes')
  assert.deepEqual(mcp.action.attributes.mcp, { server_key: 'my-probe', tool_name: 'get-order-notes' })
  assert.equal(mcp.action.attributes.tool_name, 'my-probe-get-order-notes')
  assert.equal(unknown.action.type, 'copilot.tool.other-server-search')
  assert.equal(unknown.action.attributes.mcp, undefined)
  // The miss is visible to policies and in status, and a found tool carries no mark.
  assert.equal(unknown.context.copilot.mcp_lookup, 'missed')
  assert.equal(mcp.context.copilot.mcp_lookup, undefined)
  assert.match((await status(f.home)).lastError.message, /does not name the MCP server of other-server-search/)
  assert.equal(await mcpToolForHook({ toolName: 'a-b', sessionId: 42, toolCallId: 'x' }), undefined)
  // Built-in tools never contain a hyphen and are never looked up.
  assert.equal(await mcpToolForHook({ toolName: 'powershell', sessionId, toolCallId: 'x' }), undefined)
  assert.equal(await mcpToolForHook({ toolName: 'a-b', sessionId: '../escape', toolCallId: 'x' }), undefined)
})

test('subagent calls carry their agent in context and in the call identity', async (t) => {
  const f = await fixture(t)
  await hook(f.home, 'preToolUse', call('call_1', undefined, { agentId: 'sub-1', agentType: 'explore', parentAgentId: 'main' }))
  await hook(f.home, 'preToolUse', call('call_1'))
  const [sub, main] = f.decisionBodies()
  assert.deepEqual(sub.context.copilot, { session_id: sessionId, cwd: '/work', subagent_id: 'sub-1', subagent_type: 'explore', parent_agent_id: 'main', tool_call_id: 'call_1' })
  assert.notEqual(sub.idempotency_key, main.idempotency_key)
})

test('enforcing denies a blocked call with the reason, in Copilot\'s camelCase output', async (t) => {
  const f = await fixture(t, { decide: () => 'BLOCKED' })
  await saveSetting(f.home, 'mode', 'enforcing')
  const result = await hook(f.home, 'preToolUse', call('call_1'))
  assert.equal(result.code, 0)
  assert.equal(result.output.permissionDecision, 'deny')
  assert.match(result.output.permissionDecisionReason, /^Actera decision [0-9a-f-]{36} blocked: Fixture blocks this\.$/)
  assert.equal(result.output.hookSpecificOutput, undefined)
})

test('a held call is allowed when a reviewer approves it while the hook waits', async (t) => {
  const f = await fixture(t, { decide: () => 'PENDING_APPROVAL' })
  await saveSetting(f.home, 'mode', 'enforcing')
  const held = hook(f.home, 'preToolUse', call('call_1'))
  while (!f.decisions.size) await new Promise((resolve) => setTimeout(resolve, 20))
  await new Promise((resolve) => setTimeout(resolve, 200))
  ;[...f.decisions.values()][0].status = 'APPROVED'
  const result = await held
  assert.equal(result.output.permissionDecision, 'allow')
  assert.match(result.output.permissionDecisionReason, /approved by a reviewer/)
  // The approval released that call; an identical retry needs its own approval.
  const again = await hook(f.home, 'preToolUse', call('call_2'), { ACTERA_HOLD_SECONDS: '0.3' })
  assert.equal(again.output.permissionDecision, 'deny')
})

test('a rejection during the hold denies the call with the reviewer\'s reason', async (t) => {
  const f = await fixture(t, { decide: () => 'PENDING_APPROVAL' })
  await saveSetting(f.home, 'mode', 'enforcing')
  const held = hook(f.home, 'preToolUse', call('call_1'))
  while (!f.decisions.size) await new Promise((resolve) => setTimeout(resolve, 20))
  Object.assign([...f.decisions.values()][0], { status: 'REJECTED', reason: 'Not during the freeze' })
  const result = await held
  assert.equal(result.output.permissionDecisionReason, `A reviewer rejected this tool call in Actera (decision ${[...f.decisions.keys()][0]}): Not during the freeze`)
})

test('a hold that runs out denies with the review link, and the approved retry runs once', async (t) => {
  const f = await fixture(t, { decide: () => 'PENDING_APPROVAL' })
  await saveSetting(f.home, 'mode', 'enforcing')
  const first = await hook(f.home, 'preToolUse', call('call_1'), { ACTERA_HOLD_SECONDS: '0.3' })
  const id = [...f.decisions.keys()][0]
  assert.equal(first.output.permissionDecision, 'deny')
  assert.equal(first.output.permissionDecisionReason, `Actera decision ${id} is still waiting for a reviewer. Review it at https://actera.test/ws/decisions/${id}. Once it is approved, retry this exact tool call; the approval releases one matching retry.`)
  f.decisions.get(id).status = 'APPROVED'
  const retry = await hook(f.home, 'preToolUse', call('call_2'))
  assert.equal(retry.output.permissionDecision, 'allow')
  assert.equal(f.decisions.size, 1, 'The retry reuses the approved Decision')
  const second = await hook(f.home, 'preToolUse', call('call_3'), { ACTERA_HOLD_SECONDS: '0.3' })
  assert.equal(second.output.permissionDecision, 'deny', 'The approval released one retry only')
  const changed = await hook(f.home, 'preToolUse', call('call_4', { command: 'echo other' }), { ACTERA_HOLD_SECONDS: '0.3' })
  assert.equal(changed.output.permissionDecision, 'deny')
  assert.equal(f.decisions.size, 3, 'Each held attempt after the release needs a new Decision')
})

test('an approval does not carry over to another working directory', async (t) => {
  const f = await fixture(t, { decide: () => 'PENDING_APPROVAL' })
  await saveSetting(f.home, 'mode', 'enforcing')
  await hook(f.home, 'preToolUse', call('call_1'), { ACTERA_HOLD_SECONDS: '0.3' })
  f.decisions.get([...f.decisions.keys()][0]).status = 'APPROVED'
  const elsewhere = await hook(f.home, 'preToolUse', call('call_2', undefined, { cwd: '/elsewhere' }), { ACTERA_HOLD_SECONDS: '0.3' })
  assert.equal(elsewhere.output.permissionDecision, 'deny')
  assert.equal(f.decisions.size, 2, 'The same command elsewhere is a new request')
})

test('a call held before stays held while its approval cannot be checked, even when failing open', async (t) => {
  let lookups = true
  const f = await fixture(t, { decide: () => 'PENDING_APPROVAL', available: (url) => lookups || !url.endsWith('/status') })
  await saveSetting(f.home, 'mode', 'enforcing')
  await saveSetting(f.home, 'evaluationFailure', 'allow')
  await hook(f.home, 'preToolUse', call('call_1'), { ACTERA_HOLD_SECONDS: '0.3' })
  lookups = false
  const retry = await hook(f.home, 'preToolUse', call('call_2'))
  assert.equal(retry.output.permissionDecision, 'deny')
  assert.match(retry.output.permissionDecisionReason, /could not evaluate/)
  assert.equal(f.decisions.size, 1, 'The retry is not sent as a new request')
  // A call Actera never answered still follows the choice to fail open.
  const other = await hook(f.home, 'preToolUse', call('call_3', { command: 'echo other' }), { ACTERA_HOLD_SECONDS: '0.3' })
  assert.equal(other.output.permissionDecision, 'deny', 'A new call is held as usual')
})

// Copilot's model writes a new description for every shell call, so a retry of
// the same command must still match the approved one.
test('an approved retry of the same command reuses the approval although its description changed', async (t) => {
  const f = await fixture(t, { decide: () => 'PENDING_APPROVAL' })
  await saveSetting(f.home, 'mode', 'enforcing')
  await hook(f.home, 'preToolUse', call('call_1', { command: 'npm publish', description: 'Publish the package' }), { ACTERA_HOLD_SECONDS: '0.3' })
  f.decisions.get([...f.decisions.keys()][0]).status = 'APPROVED'
  const retry = call('call_2', { command: 'npm publish', description: 'Retry the publish', initial_wait: 30 })
  assert.equal((await hook(f.home, 'preToolUse', retry)).output.permissionDecision, 'allow')
  assert.equal(f.decisions.size, 1)
  await hook(f.home, 'postToolUse', done(retry))
  assert.equal(f.reports.length, 1, 'The outcome of the released retry is reported')
  // An MCP tool's description argument is part of the call.
  const mcp = { toolName: 'notes-write', toolArgs: { description: 'a' } }
  const { approvalFingerprint } = await import('../../src/hosts/copilot/bridge.mjs')
  const config = await loadConfig(f.home)
  assert.notEqual(approvalFingerprint({ ...mcp, sessionId }, config), approvalFingerprint({ ...mcp, sessionId, toolArgs: { description: 'b' } }, config))
})

test('enforcing fails closed when Actera is unavailable, open only when chosen, and Monitoring never blocks', async (t) => {
  const f = await fixture(t, { available: (url) => url !== '/v1/decisions' })
  await saveSetting(f.home, 'mode', 'enforcing')
  const closed = await hook(f.home, 'preToolUse', call('call_1'))
  assert.equal(closed.code, 0)
  assert.match(closed.output.permissionDecisionReason, /could not evaluate this tool call: Actera decisions returned HTTP 503/)
  await saveSetting(f.home, 'evaluationFailure', 'allow')
  assert.equal((await hook(f.home, 'preToolUse', call('call_2'))).output, null)
  const monitoring = await hook(f.home, 'preToolUse', call('call_3'), { ACTERA_MODE: 'monitoring', ACTERA_EVALUATION_FAILURE: 'block' })
  assert.equal(monitoring.output, null)
})

// Copilot denies a call whose preToolUse hook exits with an error, so every
// failure exits cleanly and denies only when enforcement asks for it.
test('broken input and settings deny only where enforcement asks, and the hook always exits 0', async (t) => {
  const f = await fixture(t)
  const monitoring = await hook(f.home, 'preToolUse', '{not json')
  assert.deepEqual([monitoring.code, monitoring.output], [0, null])
  await saveSetting(f.home, 'mode', 'enforcing')
  const enforcing = await hook(f.home, 'preToolUse', '{not json')
  assert.equal(enforcing.code, 0)
  assert.match(enforcing.output.permissionDecisionReason, /could not evaluate/)
  const noTool = await hook(f.home, 'preToolUse', { sessionId, toolCallId: 'x' })
  assert.match(noTool.output.permissionDecisionReason, /Copilot sent no valid tool name/)
  const invalid = await hook(f.home, 'preToolUse', call('call_1'), { ACTERA_MODE: 'strict' })
  assert.equal(invalid.code, 0)
  assert.match(invalid.output.permissionDecisionReason, /Invalid Actera mode/)
  const post = await hook(f.home, 'postToolUse', '{not json')
  assert.deepEqual([post.code, post.output], [0, null])
  assert.equal(f.decisions.size, 0)
  // Settings of the wrong shape are unreadable too, and setting the mode repairs the file.
  for (const broken of ['null', '{"mode":5}', '{"mode":']) {
    await writeFile(path.join(f.home, 'settings.json'), broken)
    const denied = await hook(f.home, 'preToolUse', call('call_2'))
    assert.deepEqual([denied.code, denied.output.permissionDecision], [0, 'deny'], broken)
  }
  assert.equal(f.decisions.size, 0)
  assert.equal((await run(f.home, ['mode', 'enforcing'])).code, 0)
  assert.deepEqual([(await hook(f.home, 'preToolUse', call('call_3'))).output, f.decisions.size], [null, 1])
})

test('secrets in a command are redacted, and the hook leaves no process running', async (t) => {
  const f = await fixture(t)
  const secret = 'ghp_' + 'A1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6Q7r8'
  const input = call('call_1', { command: `git init && echo ${secret}` })
  await hook(f.home, 'preToolUse', input)
  await hook(f.home, 'postToolUse', done(input))
  const [decision] = f.decisionBodies()
  assert.ok(!JSON.stringify(f.requests).includes(secret))
  assert.equal(decision.action.attributes.parameters.command, 'git init && echo [redacted]')
  assert.equal(f.reports.length, 1, 'The post-tool hook delivered the report before exiting')
  const scanner = await readdir(path.join(f.home, 'scanner'))
  assert.ok(!scanner.some((name) => name.startsWith('helper-')), 'No shared helper is left for later calls')
  const children = execFileSync(process.platform === 'win32' ? 'powershell' : 'ps', process.platform === 'win32'
    ? ['-NoProfile', '-Command', `Get-CimInstance Win32_Process | Where-Object { $_.ProcessId -ne $PID -and $_.CommandLine -like '*${path.basename(f.home)}*' } | Measure-Object | Select-Object -ExpandProperty Count`]
    : ['-eo', 'args'], { encoding: 'utf8' })
  const running = process.platform === 'win32' ? Number(children.trim()) : children.split('\n').filter((line) => line.includes(path.basename(f.home))).length
  assert.equal(running, 0, 'No helper process references the bridge folder')
})

test('status says when no hook has run since connecting, and mode changes apply to the next call', async (t) => {
  const f = await fixture(t, { decide: () => 'BLOCKED' })
  const before = JSON.parse((await run(f.home, ['status'])).stdout)
  assert.match(before.hooksNeedAttention, /Start a new Copilot session/)
  assert.equal(before.settings.modeName, 'monitoring')
  await hook(f.home, 'preToolUse', call('call_1'))
  const mode = await run(f.home, ['mode', 'enforcing'])
  assert.equal(JSON.parse(mode.stdout).modeName, 'enforcing')
  assert.equal((await hook(f.home, 'preToolUse', call('call_2'))).output.permissionDecision, 'deny')
  const after = JSON.parse((await run(f.home, ['status'])).stdout)
  assert.equal(after.hooksNeedAttention, undefined)
  assert.equal(after.lastHook.event, 'preToolUse')
  assert.equal(after.delivery, undefined, 'There is no background delivery worker to report')
})

test('unknown events and commands fail without touching Actera', async (t) => {
  const f = await fixture(t)
  const unknown = await hook(f.home, 'sessionStart', {})
  assert.equal(unknown.code, 1)
  assert.match(unknown.stderr, /Unknown Copilot hook event sessionStart/)
  assert.equal((await run(f.home, ['nope'])).code, 1)
  assert.equal(f.requests.length, 0)
})

test('browser pairing and setup codes ask Actera for a Copilot connection', async (t) => {
  const { pair } = await import('../../src/core/pairing.mjs')
  const { publicEncrypt, constants } = await import('node:crypto')
  const home = await mkdtemp(path.join(os.tmpdir(), 'actera-copilot-pair-'))
  t.after(() => rm(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }))
  const seen = []
  let publicKey
  const server = createServer(async (request, response) => {
    let body = ''
    for await (const chunk of request) body += chunk
    const parsed = body ? JSON.parse(body) : undefined
    seen.push({ path: request.url, body: parsed })
    response.setHeader('content-type', 'application/json')
    if (request.url === '/v1/agent-connections') {
      publicKey = parsed.public_key
      return response.end(JSON.stringify({ code: 'c'.repeat(43), browser_url: `http://127.0.0.1:${server.address().port}/connect-agent?code=${'c'.repeat(43)}` }))
    }
    if (request.url.endsWith('/redeem') && request.url.startsWith('/v1/agent-connections/')) {
      const ciphertext = publicEncrypt({ key: publicKey, oaepHash: 'sha256', oaepLabel: Buffer.from('actera-agent-connection-v1'), padding: constants.RSA_PKCS1_OAEP_PADDING }, Buffer.from(key)).toString('base64url')
      return response.end(JSON.stringify({ status: 'approved', ciphertext, agent_id: agentId }))
    }
    if (request.url === '/v1/agent-setup-codes/redeem') return response.end(JSON.stringify({ api_key: key, agent_id: agentId }))
    if (request.url === `/v1/agents/${agentId}/readiness`) return response.end(JSON.stringify({ agent_id: agentId, status: 'ACTIVE', ready: true }))
    response.statusCode = 404
    response.end('{}')
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  t.after(() => new Promise((resolve) => server.close(resolve)))
  const origin = `http://127.0.0.1:${server.address().port}`
  await pair({ client: 'copilot', home, origin, open: () => {} })
  assert.equal(seen.find((r) => r.path === '/v1/agent-connections').body.client, 'copilot')
  const connected = await run(home, ['connect', '--setup-code', '7AHV-F8T0-M349-HPF7'], { env: { ACTERA_API_ORIGIN: origin } })
  assert.equal(connected.code, 0, connected.stderr)
  assert.match(connected.stdout, /Actera is connected to agent copilot-local-test\.\n.*\nMode: monitoring\. When Actera cannot evaluate: block\.\n$/)
  assert.deepEqual(seen.find((r) => r.path === '/v1/agent-setup-codes/redeem').body, { code: '7AHV-F8T0-M349-HPF7', client: 'copilot' })
})
