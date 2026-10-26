import { stopDelivery } from '../../src/core/delivery.mjs'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { spawn } from 'node:child_process'
import { createServer } from 'node:http'
import { mkdir, mkdtemp, readFile, readdir, rm, utimes, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { setTimeout as delay } from 'node:timers/promises'
import test, { after } from 'node:test'
import { scannerBinary, stopScanner } from '../../src/core/scanner-client.mjs'
import {
  activityForHook,
  agentReadiness,
  evaluateHook,
  configure,
  decisionReview,
  evaluationForHook,
  flush,
  loadConfig,
  mcpToolForHook,
  nativeReviewDecision,
  provisionBridge,
  reviewerLinkStatus,
  startReviewerLink,
  status,
} from '../../src/hosts/claude-code/bridge.mjs'

const cli = fileURLToPath(new URL('../../src/hosts/claude-code/cli.mjs', import.meta.url))
const key = 'actera_' + 'x'.repeat(40)

// In-process input capture extracts and starts the scanner under the default
// bridge home. Keep it, and anything else defaulting there, out of ~/.actera.
const suiteHome = await mkdtemp(path.join(os.tmpdir(), 'actera-bridge-suite-'))
const previousHome = process.env.ACTERA_CLAUDE_BRIDGE_HOME
process.env.ACTERA_CLAUDE_BRIDGE_HOME = suiteHome
after(async () => {
  await stopScanner(path.join(suiteHome, 'scanner')).catch(() => {})
  if (previousHome === undefined) delete process.env.ACTERA_CLAUDE_BRIDGE_HOME
  else process.env.ACTERA_CLAUDE_BRIDGE_HOME = previousHome
  await rm(suiteHome, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
})

test('setup verifies and stores the admin-issued agent key', async (t) => {
  const { home, baseUrl, requests } = await fixture(t)
  const initial = await loadConfig(home)
  await provisionBridge({ baseUrl, agentId: initial.agentId, apiKey: key, capture: 'metadata' }, home)
  const stored = await loadConfig(home)
  assert.equal(stored.apiKey, key)
  assert.equal(stored.capture, 'metadata')
  const check = requests.find((request) => request.path === `/v1/agents/${initial.agentId}/readiness`)
  assert.equal(check.headers.authorization, `Bearer ${key}`)
  assert.equal(requests.length, 1)
})

test('a new agent connection archives old queued activity without replaying it under the new key', async (t) => {
  const { home, baseUrl, requests } = await fixture(t)
  const old = await loadConfig(home)
  await mkdir(path.join(home, 'queue'), { recursive: true })
  await writeFile(path.join(home, 'queue', 'old.json'), JSON.stringify({ event_type: 'old.event', agent: { id: old.agentId } }))
  await assert.rejects(configure({ ...old, capture: 'metadata' }, home), /Flush the 1 queued event/)
  const next = await configure({ ...old, apiKey: 'actera_' + 'n'.repeat(40), capture: 'metadata' }, home)
  assert.equal(next.archivedEvents, 1)
  assert.equal((await status(home)).pending, 0)
  assert.equal((await loadConfig(home)).apiKey, 'actera_' + 'n'.repeat(40))
  assert.equal(JSON.parse(await readFile(path.join(next.archivePath, 'config.json'), 'utf8')).apiKey, old.apiKey)
  assert.equal(JSON.parse(await readFile(path.join(next.archivePath, 'queue', 'old.json'), 'utf8')).event_type, 'old.event')
  assert.deepEqual(await flush(await loadConfig(home), { home }), { sent: 0, pending: 0 })
  assert.equal(requests.filter((request) => request.path.endsWith('/reports')).length, 0)
})

test('a contract upgrade archives old queued reports without backfilling usage', async (t) => {
  const { home, requests } = await fixture(t)
  const old = { ...await loadConfig(home), version: 2 }
  await writeFile(path.join(home, 'config.json'), JSON.stringify(old))
  await mkdir(path.join(home, 'queue'), { recursive: true })
  await writeFile(path.join(home, 'queue', 'legacy.json'), JSON.stringify({ event_type: 'legacy.success', agent: { id: old.agentId } }))
  const result = await configure(old, home)
  assert.equal(result.archivedEvents, 1)
  assert.equal((await loadConfig(home)).version, 3)
  assert.deepEqual(await flush(await loadConfig(home), { home }), { sent: 0, pending: 0 })
  assert.equal(requests.filter(r => r.path.endsWith('/reports')).length, 0)
})

test('a linked reviewer resolves the existing Decision and releases it only once', async (t) => {
  const decisionId = '52865aae-b114-49db-9f3b-5870744603d8'
  const workspaceId = 'd01b9316-f57a-4fd5-8af2-2c80113253d7'
  const reviewerToken = 'actera_reviewer_' + 'r'.repeat(43)
  let baseUrl
  let linked = false
  let status = 'PENDING_APPROVAL'
  const fixtureResult = await fixture(t, (endpoint) => {
    if (endpoint === '/v1/reviewer-links')
      return {
        body: {
          approval_token: reviewerToken,
          browser_url: `${baseUrl.replace('127.0.0.1', 'localhost')}/auth/reviewer-link?code=test`,
          workspace_id: workspaceId,
        },
      }
    if (endpoint === '/v1/reviewer-links/status') return { body: { linked } }
    if (endpoint === `/v1/decisions/${decisionId}/status`)
      return { body: { id: decisionId, agent_id: 'claude-local-test', status } }
    if (endpoint === `/v1/decisions/${decisionId}/approve`) {
      status = 'APPROVED'
      return { body: { id: decisionId, agent_id: 'claude-local-test', status } }
    }
  })
  baseUrl = fixtureResult.baseUrl
  const { home, requests } = fixtureResult
  const config = await loadConfig(home)
  await assert.rejects(nativeReviewDecision(config, decisionId, 'approve', home), /Link your Actera account first/)
  const link = await startReviewerLink(config, home)
  assert.equal(link.workspaceId, workspaceId)
  assert.equal((await reviewerLinkStatus(config, home)).linked, false)
  linked = true
  assert.equal((await reviewerLinkStatus(config, home)).linked, true)
  assert.deepEqual(await nativeReviewDecision(config, decisionId, 'approve', home), {
    id: decisionId,
    status: 'APPROVED',
  })
  const approval = requests.find((r) => r.path === `/v1/decisions/${decisionId}/approve`)
  assert.equal(approval.headers.authorization, `Bearer ${reviewerToken}`)
  assert.equal(approval.headers['actera-workspace-id'], workspaceId)
  assert.equal(approval.body.idempotency_key, `claude-native-approve:${decisionId}`)
  await assert.rejects(nativeReviewDecision(config, decisionId, 'approve', home), /already released/)
  assert.equal(requests.filter((r) => r.path === `/v1/decisions/${decisionId}/approve`).length, 1)
  assert.equal(requests.filter((r) => r.path === `/v1/decisions/${decisionId}`).length, 0)
})

test('an approval claimed by the previous plugin version cannot release another call', async (t) => {
  const decisionId = '5e528d05-c22d-478e-bf0c-37b1aa9ce797'
  const { home } = await fixture(t, (endpoint) =>
    endpoint === `/v1/decisions/${decisionId}/status`
      ? { body: { id: decisionId, agent_id: 'claude-local-test', status: 'APPROVED' } }
      : undefined,
  )
  const claims = path.join(home, 'approvals')
  await mkdir(claims, { recursive: true })
  const hash = createHash('sha256').update(decisionId).digest('hex')
  await writeFile(path.join(claims, `${'f'.repeat(64)}-${hash}.claimed`), '{}')
  await assert.rejects(nativeReviewDecision(await loadConfig(home), decisionId, 'approve', home), /already released/)
})

test('a Decision approved in Actera releases one held call and a pending one stays held', async (t) => {
  const decisionId = 'a5b3c1d2-7f60-4e1b-9c0a-3d2e1f4a5b6c'
  let status = 'PENDING_APPROVAL'
  let agent = 'claude-local-test'
  const { home } = await fixture(t, (endpoint) =>
    endpoint === `/v1/decisions/${decisionId}/status` ? { body: { id: decisionId, agent_id: agent, status } } : undefined,
  )
  const config = await loadConfig(home)
  assert.deepEqual(await decisionReview(config, decisionId, home), { id: decisionId, status: 'PENDING_APPROVAL' })
  status = 'APPROVED'
  assert.deepEqual(await decisionReview(config, decisionId, home), { id: decisionId, status: 'APPROVED' })
  await assert.rejects(decisionReview(config, decisionId, home), /already released/)
  await assert.rejects(nativeReviewDecision(config, decisionId, 'approve', home), /already released/)
  agent = 'another-agent'
  await assert.rejects(decisionReview(config, decisionId, home), /does not belong/)
  await assert.rejects(decisionReview(config, '../decisions', home), /Invalid Decision/)
})

async function runHook(home, payload) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [cli, 'hook'], {
      env: { ...process.env, ACTERA_CLAUDE_BRIDGE_HOME: home },
      stdio: ['pipe', 'pipe', 'pipe'],
    })
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', (chunk) => {
      stdout += chunk
    })
    child.stderr.on('data', (chunk) => {
      stderr += chunk
    })
    child.on('error', reject)
    child.on('close', async (code) => {
      const config = await loadConfig(home).catch(() => undefined)
      if (config) await flush(config, { home }).catch(() => {})
      resolve({ code, stdout, stderr })
    })
    child.stdin.end(JSON.stringify(payload))
  })
}

async function fixture(t, handler) {
  const originalMode = process.env.CLAUDE_PLUGIN_OPTION_MODE
  const originalFailure = process.env.CLAUDE_PLUGIN_OPTION_EVALUATION_FAILURE
  process.env.CLAUDE_PLUGIN_OPTION_MODE = 'Enforcing'
  process.env.CLAUDE_PLUGIN_OPTION_EVALUATION_FAILURE = 'Block tool calls (fail closed)'
  t.after(() => {
    for (const [name, value] of [['CLAUDE_PLUGIN_OPTION_MODE', originalMode], ['CLAUDE_PLUGIN_OPTION_EVALUATION_FAILURE', originalFailure]]) {
      if (value === undefined) delete process.env[name]
      else process.env[name] = value
    }
  })
  const home = await mkdtemp(path.join(os.tmpdir(), 'actera-claude-test-'))
  const requests = []
  const server = createServer(async (request, response) => {
    let body = ''
    for await (const chunk of request) body += chunk
    const parsed = body ? JSON.parse(body) : undefined
    requests.push({ path: request.url, headers: request.headers, body: parsed })
    const override = handler?.(request.url, parsed)
    const statusCode =
      typeof override === 'number' ? override : (override?.statusCode ?? (request.url.endsWith('/reports') ? 201 : 200))
    response.writeHead(statusCode, { 'content-type': 'application/json' })
    response.end(
      JSON.stringify(
        override?.body ??
          (request.url === '/v1/agents/claude-local-test/readiness'
            ? { agent_id: 'claude-local-test', status: 'ACTIVE', ready: true, observation_ready: true, unmatched_action_effect: 'BLOCK' }
            : request.url === '/v1/decisions'
            ? {
                id: 'decision-1',
                status: 'ALLOWED',
                effect: 'ALLOW',
                explanation: 'Configured allow',
              }
            : { activity: parsed, effect: 'UNSPECIFIED' }),
      ),
    )
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  t.after(async () => {
    await stopDelivery(home)
    await new Promise((resolve) => server.close(resolve))
    await stopScanner(path.join(home, 'scanner')).catch(() => {})
    await rm(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
  })
  const baseUrl = `http://127.0.0.1:${server.address().port}`
  await configure({ baseUrl, apiKey: key, agentId: 'claude-local-test', capture: 'tool-inputs' }, home)
  return { home, requests, baseUrl }
}

test('an unconfigured plugin leaves Claude tool calls alone', async (t) => {
  const home = await mkdtemp(path.join(os.tmpdir(), 'actera-claude-unconfigured-'))
  t.after(() => rm(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }))
  const result = await runHook(home, { hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command: 'echo run' } })
  assert.equal(result.code, 0)
  assert.equal(result.stdout, '')
})

test('malformed local configuration cannot produce a policy decision', async (t) => {
  const home = await mkdtemp(path.join(os.tmpdir(), 'actera-claude-invalid-'))
  t.after(() => rm(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }))
  await writeFile(path.join(home, 'config.json'), '{invalid')
  const result = await runHook(home, { hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command: 'echo run' } })
  assert.notEqual(result.code, 0)
  assert.equal(result.stdout, '')
})

test('a registered agent in monitoring mode creates a decision without inventing an execution outcome', async (t) => {
  const { home, requests } = await fixture(t, (endpoint) => endpoint === '/v1/decisions' ? { body: { id: 'monitor-1', status: 'MONITORED', effect: 'BLOCK' } } : undefined)
  process.env.CLAUDE_PLUGIN_OPTION_MODE = 'Monitoring'
  const result = await runHook(home, { hook_event_name: 'PreToolUse', session_id: 'not-ready', tool_use_id: '1', tool_name: 'Bash', tool_input: { command: 'echo run' } })
  assert.equal(result.code, 0)
  assert.equal(result.stdout, '')
  assert.equal(requests.filter(r => r.path === '/v1/decisions').length, 1)
  assert.equal(requests.find(r => r.path === '/v1/decisions').body.mode, 'MONITORING')
  assert.equal(requests.filter(r => r.path.endsWith('/reports')).length, 0)
  assert.ok(requests.every(r => !r.path.endsWith('/readiness')))
})

test('a full report queue does not bypass policy evaluation', async (t) => {
  const { home, requests } = await fixture(t)
  const queue = path.join(home, 'queue')
  await mkdir(queue, { recursive: true })
  await Promise.all(Array.from({ length: 128 }, (_, index) => writeFile(path.join(queue, `${index}.json`), '{}')))
  const result = await runHook(home, { hook_event_name: 'PreToolUse', session_id: 'full-queue', tool_use_id: '1', tool_name: 'Bash', tool_input: { command: 'echo run' } })
  assert.equal(result.code, 0)
  assert.equal(result.stdout, '')
  assert.match((await status(home)).delivery.lastError.message, /Legacy hook queue/)
  assert.equal(requests.filter((request) => request.path === '/v1/decisions').length, 1)
  assert.equal((await status(home)).pending, 128)
})

test('a full queue does not raise non-tool hook errors in Claude', async (t) => {
  const { home } = await fixture(t, (endpoint) => (endpoint.endsWith('/reports') ? 503 : undefined))
  const queue = path.join(home, 'queue')
  await mkdir(queue, { recursive: true })
  await Promise.all(Array.from({ length: 128 }, (_, index) => writeFile(path.join(queue, `${index}.json`), '{}')))
  const result = await runHook(home, { hook_event_name: 'SessionStart', session_id: 'full-queue' })
  assert.equal(result.code, 0)
  assert.equal(result.stdout, '')
  assert.equal(result.stderr, '')
  assert.equal((await status(home)).pending, 128)
  assert.match((await status(home)).delivery.lastError.message, /Legacy hook queue/)
})

test('a full queue resumes delivery when the API is reachable again', async (t) => {
  const { home, requests } = await fixture(t)
  const queue = path.join(home, 'queue')
  await mkdir(queue, { recursive: true })
  await Promise.all(Array.from({ length: 128 }, (_, index) =>
    writeFile(path.join(queue, `${index}.json`), JSON.stringify({ decision_id: 'decision-1', idempotency_key: `queued-${index}`, outcome: 'SUCCESS', agent: { id: 'claude-local-test' }, context: { claude: {} }, details: {} }))))
  const result = await runHook(home, { hook_event_name: 'SessionStart', session_id: 'recovered' })
  assert.equal(result.code, 0, result.stderr)
  assert.equal(result.stderr, '')
  assert.ok((await status(home)).pending < 128)
  assert.ok(requests.some((request) => request.path.endsWith('/reports')))
})

test('a tool outcome can still be queued when the ordinary hook spool fills', async (t) => {
  const { home } = await fixture(t, (endpoint) => (endpoint.endsWith('/reports') ? 503 : undefined))
  const queue = path.join(home, 'queue')
  await mkdir(queue, { recursive: true })
  await Promise.all(Array.from({ length: 127 }, (_, index) => writeFile(path.join(queue, `${index}.json`), '{}')))
  const call = { session_id: 'reserved-outcome', tool_use_id: 'tool-1', tool_name: 'Bash', tool_input: { command: 'echo run' } }
  const before = await runHook(home, { ...call, hook_event_name: 'PreToolUse' })
  assert.equal(before.code, 0)
  assert.equal(before.stdout, '')
  const after = await runHook(home, { ...call, hook_event_name: 'PostToolUse' })
  assert.equal(after.code, 0) // The duplicate lifecycle activity has no ordinary slot.
  assert.equal(after.stderr, '')
  const queued = await Promise.all((await readdir(queue)).map((name) => readFile(path.join(queue, name), 'utf8')))
  assert.ok(queued.some((value) => value.includes('SUCCESS')))
})

test('pruning keeps unresolved calls and removes old resolved correlation', async (t) => {
  const { home } = await fixture(t)
  const approval = path.join(home, 'approvals', 'expired.claimed')
  const correlation = path.join(home, 'tool-calls', 'expired.json')
  await mkdir(path.dirname(approval), { recursive: true })
  await mkdir(path.dirname(correlation), { recursive: true })
  await writeFile(approval, '{}')
  const old = new Date(Date.now() - 8 * 24 * 60 * 60 * 1000)
  await writeFile(correlation, JSON.stringify({ resolvedAt: old.getTime() }))
  const unresolved = path.join(home, 'tool-calls', 'unresolved.json')
  await writeFile(unresolved, JSON.stringify({ savedAt: old.getTime() }))
  await utimes(unresolved, old, old)
  await utimes(approval, old, old)
  await utimes(correlation, old, old)
  const result = await runHook(home, { hook_event_name: 'SessionStart', session_id: 'prune' })
  assert.equal(result.code, 0)
  // The hook only wakes the sender; pruning runs as the sender starts.
  const exists = (file) => readFile(file).then(() => true, () => false)
  for (let i = 0; i < 200 && ((await exists(approval)) || (await exists(correlation))); i++) await delay(25)
  await assert.rejects(readFile(approval), { code: 'ENOENT' })
  await assert.rejects(readFile(correlation), { code: 'ENOENT' })
  assert.ok(await readFile(unresolved))
})

test('Claude hook CLI records one decision and one execution report for a subagent tool call', async (t) => {
  const { home, requests } = await fixture(t)
  const session = { session_id: 'session-1', cwd: '/repo', prompt_id: 'prompt-1' }
  for (const hook of [
    { ...session, hook_event_name: 'SessionStart', source: 'startup' },
    { ...session, hook_event_name: 'SubagentStart', agent_id: 'child-1', agent_type: 'Explore' },
    {
      ...session,
      hook_event_name: 'PreToolUse',
      agent_id: 'child-1',
      agent_type: 'Explore',
      tool_name: 'Bash',
      tool_use_id: 'tool-1',
      tool_input: { command: 'git status', api_key: 'should-be-redacted' },
    },
    {
      ...session,
      hook_event_name: 'PostToolUse',
      agent_id: 'child-1',
      agent_type: 'Explore',
      tool_name: 'Bash',
      tool_use_id: 'tool-1',
      tool_input: { command: 'git status', api_key: 'should-be-redacted' },
      tool_response: { password: 'never-forward' },
    },
  ]) {
    const result = await runHook(home, hook)
    assert.equal(result.code, 0)
    assert.equal(result.stderr, '')
    assert.equal(result.stdout, '')
  }
  assert.equal(requests.filter((request) => request.path === '/v1/observe').length, 0)
  const evaluations = requests.filter((request) => request.path === '/v1/decisions')
  assert.equal(evaluations.length, 1)
  assert.equal(evaluations[0].body.action.type, 'claude.tool.Bash')
  assert.equal(evaluations[0].body.action.attributes.parameters.command, 'git status')
  assert.equal(evaluations[0].body.action.attributes.parameters.api_key, '[redacted]')
  assert.equal(evaluations[0].body.context.claude.tool_use_id, 'tool-1')
  const activities = requests.filter((request) => request.path.endsWith('/reports'))
  assert.equal(activities.length, 1)
  assert.deepEqual(activities.map(item => item.body.outcome), ['SUCCESS'])
  const before = activities[0].body
  assert.equal(before.agent.id, 'claude-local-test')
  assert.equal(before.action.type, 'claude.tool.Bash')
  assert.equal(before.context.claude.session_id, 'session-1')
  assert.equal(before.context.claude.subagent_id, 'child-1')
  assert.equal(before.action.attributes.parameters.api_key, '[redacted]')
  assert.equal(activities[0].body.details.tool_response, undefined)
  assert.ok(!JSON.stringify(requests).includes('never-forward'))
  assert.ok(activities.every((item) => item.headers.authorization === `Bearer ${key}`))
  assert.equal((await status(home)).pending, 0)
})

test('a blocked Actera Decision denies the Claude tool call and records the attempted hook', async (t) => {
  const { home, requests } = await fixture(t, (endpoint) =>
    endpoint === '/v1/decisions'
      ? { body: { id: 'blocked-1', status: 'BLOCKED', effect: 'BLOCK', explanation: 'Configured block' } }
      : undefined,
  )
  const result = await runHook(home, {
    hook_event_name: 'PreToolUse',
    session_id: 'blocked-session',
    tool_use_id: 'tool-blocked',
    tool_name: 'PowerShell',
    tool_input: { command: 'New-Item -ItemType Directory test-folder' },
  })
  assert.equal(result.code, 0)
  assert.equal(JSON.parse(result.stdout).hookSpecificOutput.permissionDecision, 'deny')
  assert.match(JSON.parse(result.stdout).hookSpecificOutput.permissionDecisionReason, /Configured block/)
  assert.equal(requests.filter((request) => request.path.endsWith('/reports')).length, 0)
})

test('an Actera allow Decision preserves Claude native permissions for an onboarded agent', async (t) => {
  const { home } = await fixture(t, (endpoint) =>
    endpoint === '/v1/decisions'
      ? { body: { id: 'active-allow', status: 'ALLOWED' } }
      : undefined,
  )
  const result = await runHook(home, {
    hook_event_name: 'PreToolUse',
    session_id: 'active-session',
    tool_use_id: 'active-tool',
    tool_name: 'Read',
    tool_input: { file_path: '/repo/file.txt' },
  })
  assert.equal(result.code, 0)
  assert.equal(result.stdout, '')
})

test('any tool result is classified by host lifecycle without parsing its payload', async (t) => {
  const { home, requests } = await fixture(t, (endpoint) =>
    endpoint === '/v1/decisions' ? { body: { id: 'approved-call', status: 'APPROVED' } } : undefined,
  )
  const tools = [
    [
      'mcp__documents__create_record',
      { title: 'Test' },
      { opaque: ['result'], error: 'business field, not a host error' },
    ],
    ['mcp__analytics__query_dataset', { query: 'SELECT 1' }, 'arbitrary text'],
    ['mcp__new-provider__operation_never_seen_before', {}, null],
    ['Read', { file_path: '/repo/file' }, { content: 'private output' }],
  ]
  for (const [index, [name, input, response]] of tools.entries()) {
    const tool = { session_id: 'generic-session', tool_use_id: 'tool-' + index, tool_name: name, tool_input: input }
    assert.equal((await runHook(home, { ...tool, hook_event_name: 'PreToolUse' })).code, 0)
    assert.equal((await runHook(home, { ...tool, hook_event_name: 'PostToolUse', tool_response: response })).code, 0)
    // Redelivery cannot create a second outcome for the same tool use.
    await runHook(home, { ...tool, hook_event_name: 'PostToolUse', tool_response: response })
  }
  const outcomes = requests.filter((item) => item.path.endsWith('/reports') && item.body.outcome && item.body.decision_id)
  assert.equal(outcomes.length, tools.length)
  assert.ok(outcomes.every((item) => item.body.outcome === 'SUCCESS'))
  assert.ok(outcomes.every((item) => item.body.decision_id === 'approved-call'))
  assert.ok(outcomes.every((item) => item.body.details.outcome_scope === 'tool_call'))
  assert.ok(!JSON.stringify(outcomes).includes('private output'))
  assert.ok(!JSON.stringify(outcomes).includes('business field'))
})

test('host failure and interruption are distinct outcomes for arbitrary tools', async (t) => {
  const { home, requests } = await fixture(t)
  for (const [index, interrupt] of [false, true].entries()) {
    const tool = {
      session_id: 'failure-session',
      tool_use_id: 'tool-' + index,
      tool_name: 'mcp__unknown__run_task',
      tool_input: {},
    }
    await runHook(home, { ...tool, hook_event_name: 'PreToolUse' })
    await runHook(home, {
      ...tool,
      hook_event_name: 'PostToolUseFailure',
      is_interrupt: interrupt,
      error: 'private error details',
    })
  }
  const outcomes = requests.filter((item) => item.path.endsWith('/reports') && item.body.outcome && item.body.decision_id)
  assert.deepEqual(
    outcomes.map((item) => item.body.outcome),
    ['FAILURE', 'CANCELLED'],
  )
  assert.ok(!JSON.stringify(outcomes).includes('private error details'))
})

test('an old interrupted call can resolve with a late success and concurrent retries keep one report body', async (t) => {
  const { home, requests } = await fixture(t)
  const call = { session_id: 'late', tool_use_id: 'call', tool_name: 'Bash', tool_input: { command: 'echo done' } }
  await runHook(home, { ...call, hook_event_name: 'PreToolUse' })
  const [name] = await readdir(path.join(home, 'tool-calls'))
  const file = path.join(home, 'tool-calls', name)
  const admitted = JSON.parse(await readFile(file, 'utf8'))
  const old = new Date(Date.now() - 8 * 24 * 60 * 60 * 1000)
  await writeFile(file, JSON.stringify({ ...admitted, savedAt: old.getTime() }))
  await utimes(file, old, old)
  await rm(path.join(home, 'last-maintenance.json'), { force: true })
  await runHook(home, { ...call, hook_event_name: 'PostToolUseFailure', is_interrupt: true })
  assert.ok(await readFile(file), 'Uncertain outcome must keep correlation')
  await Promise.all(Array.from({ length: 8 }, () => runHook(home, { ...call, hook_event_name: 'PostToolUse' })))
  assert.equal((await flush(await loadConfig(home), { home, force: true })).pending, 0)
  const reports = requests.filter(r => r.path.endsWith('/reports'))
  assert.equal(reports.filter(r => r.body.outcome === 'CANCELLED').length, 1)
  const successes = reports.filter(r => r.body.outcome === 'SUCCESS')
  assert.ok(successes.length >= 1)
  for (const success of successes) assert.deepEqual(success.body, successes[0].body)
  assert.notEqual(successes[0].body.idempotency_key, reports.find(r => r.body.outcome === 'CANCELLED').body.idempotency_key)
  assert.ok(!('_tool_call_key' in successes[0].body))
  assert.ok(JSON.parse(await readFile(file, 'utf8')).resolvedAt)
})

test('post-tool metadata changes cannot rewrite the originally admitted action', async (t) => {
  const { home, requests } = await fixture(t)
  const tool = {
    session_id: 'metadata-session',
    tool_use_id: 'tool-1',
    tool_name: 'mcp__unknown__run_task',
    tool_input: { a: 1, b: 2 },
  }
  await runHook(home, { ...tool, hook_event_name: 'PreToolUse', mcp_server: { name: 'Original', source: 'sdk' } })
  await runHook(home, {
    ...tool,
    hook_event_name: 'PostToolUse',
    tool_input: { b: 2, a: 1 },
    mcp_server: { name: 'Later' },
  })
  const original = requests.find((item) => item.path === '/v1/decisions').body
  const outcome = requests.find((item) => item.path.endsWith('/reports') && item.body.outcome && item.body.decision_id).body
  assert.deepEqual(outcome.action, original.action)
})

test('an undelivered outcome keeps its idempotency key for a later flush', async (t) => {
  let outage = true
  const { home, requests } = await fixture(t, (endpoint, body) => {
    if (endpoint.endsWith('/reports') && body.outcome === 'SUCCESS' && outage) return 503
  })
  const tool = {
    session_id: 'retry-session',
    tool_use_id: 'tool-1',
    tool_name: 'Read',
    tool_input: { file_path: '/repo/file' },
  }
  await runHook(home, { ...tool, hook_event_name: 'PreToolUse' })
  await runHook(home, { ...tool, hook_event_name: 'PostToolUse', tool_response: 'file contents' })
  assert.equal((await status(home)).pending, 1)
  const attempts = () =>
    requests.filter((item) => item.path.endsWith('/reports') && item.body.outcome === 'SUCCESS')
  assert.ok(attempts().length >= 1)
  const failedAttempts = attempts().length
  outage = false
  // The persistent worker may deliver before the explicit flush; assert drained state
  // and the actual requests below, not which wake-up happened to deliver them.
  assert.equal((await flush(await loadConfig(home), { home, force: true })).pending, 0)
  assert.ok(attempts().length > failedAttempts)
  for (const attempt of attempts()) assert.deepEqual(attempt.body, attempts()[0].body)
})

test('a post-tool hook with different arguments cannot attach to the admitted Decision', async (t) => {
  const { home, requests } = await fixture(t)
  const tool = {
    session_id: 'mismatch-session',
    tool_use_id: 'tool-1',
    tool_name: 'Bash',
    tool_input: { command: 'echo hi' },
  }
  await runHook(home, { ...tool, hook_event_name: 'PreToolUse' })
  const result = await runHook(home, {
    ...tool,
    hook_event_name: 'PostToolUse',
    tool_input: { command: 'echo different' },
  })
  assert.notEqual(result.code, 0)
  assert.match(result.stderr, /does not match the admitted Actera action/)
  assert.equal(requests.filter((item) => item.path.endsWith('/reports') && item.body.outcome && item.body.decision_id).length, 0)
})

test('a pending Actera approval returns promptly with the Decision handle', async (t) => {
  let evaluated
  const { home, requests } = await fixture(t, (endpoint, body) => {
    if (endpoint === '/v1/decisions') {
      evaluated = body
      return { body: { id: 'approval-1', status: 'PENDING_APPROVAL', explanation: 'Human review required' } }
    }
    if (endpoint === '/v1/decisions/approval-1/status')
      return {
        body: {
          id: 'approval-1',
          status: 'APPROVED',
          agent_id: evaluated.agent.id,
          action_type: evaluated.action.type,
          idempotency_key: evaluated.idempotency_key,
        },
      }
  })
  const result = await runHook(home, {
    hook_event_name: 'PreToolUse',
    session_id: 'approval-session',
    tool_use_id: 'send-1',
    tool_name: 'mcp__server-1__publish_item',
    tool_input: { channel_id: 'test', message: 'Hello' },
  })
  assert.equal(result.code, 0)
  const output = JSON.parse(result.stdout).hookSpecificOutput
  assert.equal(output.permissionDecision, 'deny')
  assert.match(output.permissionDecisionReason, /approval-1 is awaiting approval/)
  assert.equal(requests.filter((request) => request.path === '/v1/decisions/approval-1/status').length, 0)
  assert.equal(requests.find((request) => request.path === '/v1/decisions').body.action.type, 'claude.mcp.publish_item')
})

test('an approval after the hook returns authorizes one exact retry without a new Decision', async (t) => {
  let approvalStatus = 'PENDING_APPROVAL'
  let originalRequest
  let evaluations = 0
  const { home, requests } = await fixture(t, (endpoint, body) => {
    if (endpoint === '/v1/decisions') {
      evaluations++
      if (evaluations === 1) originalRequest = body
      return { body: { id: `approval-${evaluations}`, status: 'PENDING_APPROVAL' } }
    }
    if (endpoint === '/v1/decisions/approval-1/status')
      return {
        body: {
          id: 'approval-1',
          status: approvalStatus,
          agent_id: originalRequest.agent.id,
          action_type: originalRequest.action.type,
          idempotency_key: originalRequest.idempotency_key,
        },
      }
  })
  const input = {
    hook_event_name: 'PreToolUse',
    session_id: 'same-session',
    tool_use_id: 'first-tool-id',
    tool_name: 'mcp__server__publish_item',
    tool_input: { channel_id: 'test', message: 'Hello' },
  }
  const first = await runHook(home, input)
  assert.equal(JSON.parse(first.stdout).hookSpecificOutput.permissionDecision, 'deny')
  assert.match(first.stdout, /approval-1 is awaiting approval/)
  assert.equal(evaluations, 1)
  const stillPending = await runHook(home, { ...input, tool_use_id: 'second-tool-id' })
  assert.match(stillPending.stdout, /approval-1 is awaiting approval/)
  assert.equal(evaluations, 1)
  approvalStatus = 'APPROVED'
  const approved = await runHook(home, {
    ...input,
    tool_use_id: 'third-tool-id',
    tool_input: { message: 'Hello', channel_id: 'test' },
  })
  assert.equal(JSON.parse(approved.stdout).hookSpecificOutput.permissionDecision, 'allow')
  assert.match(approved.stdout, /approval-1 approved/)
  assert.equal(evaluations, 1)
  const secondSend = await runHook(home, { ...input, tool_use_id: 'fourth-tool-id' })
  assert.match(secondSend.stdout, /approval-2 is awaiting approval/)
  assert.equal(evaluations, 2)
  assert.equal(requests.filter((item) => item.path === '/v1/decisions').length, 2)
})

test('changed arguments or session cannot reuse an approved Decision', async (t) => {
  let originalRequest
  let evaluations = 0
  const { home } = await fixture(t, (endpoint, body) => {
    if (endpoint === '/v1/decisions') {
      evaluations++
      if (evaluations === 1) originalRequest = body
      return { body: { id: `decision-${evaluations}`, status: 'PENDING_APPROVAL' } }
    }
    if (endpoint === '/v1/decisions/decision-1/status')
      return {
        body: {
          id: 'decision-1',
          status: 'APPROVED',
          agent_id: originalRequest.agent.id,
          action_type: originalRequest.action.type,
          idempotency_key: originalRequest.idempotency_key,
        },
      }
  })
  const input = {
    hook_event_name: 'PreToolUse',
    session_id: 'session-a',
    tool_use_id: 'tool-a',
    tool_name: 'mcp__server__publish_item',
    tool_input: { channel_id: 'test', message: 'Hello' },
  }
  await runHook(home, input)
  const changedMessage = await runHook(home, {
    ...input,
    tool_use_id: 'tool-b',
    tool_input: { ...input.tool_input, message: 'Different' },
  })
  assert.match(changedMessage.stdout, /decision-2 is awaiting approval/)
  const changedSession = await runHook(home, { ...input, session_id: 'session-b', tool_use_id: 'tool-c' })
  assert.match(changedSession.stdout, /decision-3 is awaiting approval/)
  assert.equal(evaluations, 3)
})

test('parallel exact retries cannot both use one approval', async (t) => {
  let originalRequest
  let evaluations = 0
  const { home } = await fixture(t, (endpoint, body) => {
    if (endpoint === '/v1/decisions') {
      evaluations++
      if (evaluations === 1) originalRequest = body
      return { body: { id: `parallel-${evaluations}`, status: 'PENDING_APPROVAL' } }
    }
    if (endpoint === '/v1/decisions/parallel-1/status')
      return {
        body: {
          id: 'parallel-1',
          status: 'APPROVED',
          agent_id: originalRequest.agent.id,
          action_type: originalRequest.action.type,
          idempotency_key: originalRequest.idempotency_key,
        },
      }
  })
  const input = {
    hook_event_name: 'PreToolUse',
    session_id: 'parallel-session',
    tool_use_id: 'original',
    tool_name: 'mcp__server__publish_item',
    tool_input: { channel_id: 'test', message: 'Hello' },
  }
  await runHook(home, input)
  const results = await Promise.all([
    runHook(home, { ...input, tool_use_id: 'retry-a' }),
    runHook(home, { ...input, tool_use_id: 'retry-b' }),
  ])
  assert.equal(
    results.filter((result) => JSON.parse(result.stdout).hookSpecificOutput.permissionDecision === 'allow').length,
    1,
  )
})

test('a rejected Actera approval denies the same Claude tool call', async (t) => {
  let evaluated
  const { home } = await fixture(t, (endpoint, body) => {
    if (endpoint === '/v1/decisions') {
      evaluated = body
      return { body: { id: 'rejected-1', status: 'PENDING_APPROVAL' } }
    }
    if (endpoint === '/v1/decisions/rejected-1/status')
      return {
        body: {
          id: 'rejected-1',
          status: 'REJECTED',
          explanation: 'Reviewer declined',
          agent_id: evaluated.agent.id,
          action_type: evaluated.action.type,
          idempotency_key: evaluated.idempotency_key,
        },
      }
  })
  const input = {
    hook_event_name: 'PreToolUse',
    session_id: 'approval-session',
    tool_use_id: 'send-2',
    tool_name: 'mcp__server-1__publish_item',
    tool_input: { channel_id: 'test', message: 'Hello' },
  }
  await runHook(home, input)
  const result = await runHook(home, { ...input, tool_use_id: 'send-3' })
  assert.equal(result.code, 0)
  const output = JSON.parse(result.stdout).hookSpecificOutput
  assert.equal(output.permissionDecision, 'deny')
  assert.match(output.permissionDecisionReason, /Reviewer declined/)
})

test('an unavailable evaluator denies the tool call and records the failure', async (t) => {
  const { home, requests } = await fixture(t, (endpoint) => (endpoint === '/v1/decisions' ? 503 : undefined))
  const result = await runHook(home, {
    hook_event_name: 'PreToolUse',
    session_id: 'outage-session',
    tool_use_id: 'tool-outage',
    tool_name: 'Read',
    tool_input: { file_path: '/repo/file.txt' },
  })
  assert.equal(result.code, 0)
  assert.equal(JSON.parse(result.stdout).hookSpecificOutput.permissionDecision, 'deny')
  assert.equal(requests.filter((request) => request.path.endsWith('/reports')).length, 0)
  assert.equal((await status(home)).pending, 1)
  assert.match((await status(home)).lastError.message, /HTTP 503/)
})

test('404 from decision creation denies by default', async (t) => {
  for (const failingEndpoint of ['/v1/decisions']) {
    await t.test(failingEndpoint, async (subtest) => {
      const { home } = await fixture(subtest, (endpoint) => (endpoint === failingEndpoint ? 404 : undefined))
      if (failingEndpoint === '/v1/agents/claude-local-test/readiness') {
        const legacy = await loadConfig(home)
        delete legacy.onEvaluationError
        await writeFile(path.join(home, 'config.json'), JSON.stringify(legacy))
      }
      const result = await runHook(home, {
        hook_event_name: 'PreToolUse', session_id: 'missing-route', tool_use_id: 'one',
        tool_name: 'Bash', tool_input: { command: 'echo run' },
      })
      assert.equal(result.code, 0)
      assert.equal(JSON.parse(result.stdout).hookSpecificOutput.permissionDecision, 'deny')
      assert.match((await status(home)).lastError.message, /HTTP 404/)
    })
  }
})

test('handled evaluation errors can be configured to deny without changing the host hook', async (t) => {
  const { home } = await fixture(t, (endpoint) => (endpoint === '/v1/decisions' ? 404 : undefined))
  process.env.CLAUDE_PLUGIN_OPTION_EVALUATION_FAILURE = 'Block tool calls (fail closed)'
  assert.equal((await status(home)).onEvaluationError, 'deny')
  const result = await runHook(home, {
    hook_event_name: 'PreToolUse', session_id: 'strict', tool_use_id: 'one',
    tool_name: 'Bash', tool_input: { command: 'echo run' },
  })
  assert.equal(result.code, 0)
  assert.equal(JSON.parse(result.stdout).hookSpecificOutput.permissionDecision, 'deny')
  assert.match(result.stdout, /HTTP 404/)
  process.env.CLAUDE_PLUGIN_OPTION_EVALUATION_FAILURE = 'Allow tool calls (fail open)'
  assert.equal((await status(home)).onEvaluationError, 'continue')
  const continued = await runHook(home, {
    hook_event_name: 'PreToolUse', session_id: 'strict', tool_use_id: 'two',
    tool_name: 'Bash', tool_input: { command: 'echo run' },
  })
  assert.equal(continued.code, 0)
  assert.equal(continued.stdout, '')
  assert.equal((await status(home)).pending, 2)
})

test('metadata mode omits prompts and tool inputs, including message display text', async () => {
  const config = { apiKey: key, agentId: 'observer', capture: 'metadata' }
  const tool = await activityForHook(
    { hook_event_name: 'PreToolUse', session_id: 's', tool_name: 'Bash', tool_input: { command: 'echo secret' } },
    config,
  )
  assert.deepEqual(tool.details.tool_input_fields, ['command'])
  assert.equal(tool.details.tool_input, undefined)
  const evaluation = evaluationForHook(
    { hook_event_name: 'PreToolUse', session_id: 's', tool_use_id: 't', tool_name: 'Bash' },
    config,
    tool,
  )
  assert.equal(evaluation.action.attributes.parameters, undefined)
  assert.deepEqual(evaluation.action.attributes.input_fields, ['command'])
  const prompt = await activityForHook({ hook_event_name: 'UserPromptSubmit', prompt: 'private request' }, config)
  assert.ok(!JSON.stringify(prompt).includes('private request'))
  const display = await activityForHook({ hook_event_name: 'MessageDisplay', delta: 'private answer' }, config)
  assert.equal(display.details.text_length, 14)
  assert.ok(!JSON.stringify(display).includes('private answer'))
})

test('rotating the machine key changes hook idempotency identity', async () => {
  const hook = { hook_event_name: 'PreToolUse', session_id: 'same', tool_use_id: 'same', tool_name: 'Bash' }
  const config = { apiKey: key, agentId: 'observer', capture: 'metadata' }
  const oldActivity = await activityForHook(hook, config, 'same-event')
  const newActivity = await activityForHook(hook, { ...config, apiKey: 'actera_' + 'z'.repeat(40) }, 'same-event')
  assert.notEqual(oldActivity.idempotency_key, newActivity.idempotency_key)
})

test('MCP action identity survives a server-key change while retaining raw provenance', async () => {
  const config = { apiKey: key, agentId: 'observer', capture: 'tool-inputs' }
  const first = {
    hook_event_name: 'PreToolUse',
    session_id: 'session-a',
    tool_use_id: 'call-a',
    tool_name: 'mcp__server-uuid-a__publish_item',
    mcp_server: { name: 'Example connector', source: 'sdk', ignored: 'do-not-forward' },
    tool_input: { channel_id: 'channel-1', message: 'Hello' },
  }
  const second = {
    ...first,
    session_id: 'session-b',
    tool_use_id: 'call-b',
    tool_name: 'mcp__server-uuid-b__publish_item',
  }
  const firstActivity = await activityForHook(first, config)
  const secondActivity = await activityForHook(second, config)
  assert.equal(firstActivity.action.type, 'claude.mcp.publish_item')
  assert.equal(secondActivity.action.type, firstActivity.action.type)
  assert.deepEqual(firstActivity.action.attributes.mcp, {
    server_key: 'server-uuid-a',
    tool_name: 'publish_item',
    server_name: 'Example connector',
    source: 'sdk',
  })
  assert.equal(firstActivity.action.attributes.tool_name, first.tool_name)
  assert.equal(firstActivity.action.attributes.mcp.ignored, undefined)
  const evaluation = evaluationForHook(first, config, firstActivity)
  assert.equal(evaluation.action.type, 'claude.mcp.publish_item')
  assert.deepEqual(evaluation.action.attributes.mcp, firstActivity.action.attributes.mcp)
  assert.equal(evaluation.action.attributes.tool_name, first.tool_name)
  assert.equal(evaluation.action.attributes.parameters.message, 'Hello')
  assert.equal(evaluation.context.claude.session_id, 'session-a')
  assert.equal(evaluation.context.claude.tool_use_id, 'call-a')
})

test('MCP parser rejects incomplete names and does not relabel regular tools', () => {
  assert.equal(mcpToolForHook({ tool_name: 'Read' }), undefined)
  assert.throws(() => mcpToolForHook({ tool_name: 'mcp__missing-operation' }), /invalid MCP tool name/)
  assert.throws(() => mcpToolForHook({ tool_name: 'mcp____operation' }), /invalid MCP tool name/)
})

test('hook CLI evaluates two MCP server IDs under one operation while reporting both raw names', async (t) => {
  const { home, requests } = await fixture(t)
  for (const [index, serverKey] of ['server-a', 'server-b'].entries()) {
    const result = await runHook(home, {
      hook_event_name: 'PreToolUse',
      session_id: `mcp-session-${index}`,
      tool_use_id: `mcp-call-${index}`,
      tool_name: `mcp__${serverKey}__publish_item`,
      mcp_server: { name: 'Example connector', source: 'sdk' },
      tool_input: { channel_id: 'channel-1', message: 'Hello' },
    })
    assert.equal(result.code, 0)
    assert.equal(result.stdout, '')
    assert.equal((await runHook(home, {
      hook_event_name: 'PostToolUse',
      session_id: `mcp-session-${index}`,
      tool_use_id: `mcp-call-${index}`,
      tool_name: `mcp__${serverKey}__publish_item`,
      tool_input: { channel_id: 'channel-1', message: 'Hello' },
    })).code, 0)
  }
  const evaluations = requests.filter((item) => item.path === '/v1/decisions').map((item) => item.body)
  const activities = requests.filter((item) => item.path.endsWith('/reports')).map((item) => item.body)
  assert.deepEqual(
    evaluations.map((item) => item.action.type),
    ['claude.mcp.publish_item', 'claude.mcp.publish_item'],
  )
  assert.deepEqual(
    evaluations.map((item) => item.action.attributes.mcp.server_key),
    ['server-a', 'server-b'],
  )
  assert.deepEqual(
    activities.map((item) => item.action.attributes.tool_name),
    ['mcp__server-a__publish_item', 'mcp__server-b__publish_item'],
  )
})

test("redirects cannot forward credentials or captured input to another endpoint", async (t) => {
  const received = [];
  const destination = createServer(async (request, response) => {
    let body = "";
    for await (const chunk of request) body += chunk;
    received.push({ headers: request.headers, body });
    response.writeHead(200, { "content-type": "application/json" });
    response.end("{}");
  });
  await new Promise((resolve) => destination.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise((resolve) => destination.close(resolve)));
  const server = createServer(async (request, response) => {
    for await (const chunk of request) {
      void chunk;
    }
    response.writeHead(307, {
      location: `http://127.0.0.1:${destination.address().port}/redirected`,
    });
    response.end();
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const home = await mkdtemp(path.join(os.tmpdir(), "actera-redirect-"));
  t.after(() => rm(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }));
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  await configure(
    {
      baseUrl,
      apiKey: key,
      agentId: "claude-local-test",
      capture: "tool-inputs",
    },
    home,
  );
  const config = await loadConfig(home);
  await writeFile(
    path.join(home, "reviewer.json"),
    JSON.stringify({
      token: "actera_reviewer_" + "r".repeat(43),
      workspaceId: "d01b9316-f57a-4fd5-8af2-2c80113253d7",
      baseUrl,
      agentId: config.agentId,
      credentialId: createHash('sha256').update(config.apiKey).digest('hex').slice(0, 16),
    }),
  );
  const hook = {
    hook_event_name: "PreToolUse",
    session_id: "redirect",
    tool_use_id: "1",
    tool_name: "Bash",
    tool_input: { command: "private payload" },
  };
  await assert.rejects(provisionBridge(config, home));
  await assert.rejects(agentReadiness(config));
  await assert.rejects(startReviewerLink(config, home));
  await assert.rejects(reviewerLinkStatus(config, home));
  await assert.rejects(
    evaluateHook(hook, config, await activityForHook(hook, config)),
  );
  await assert.rejects(
    nativeReviewDecision(
      config,
      "52865aae-b114-49db-9f3b-5870744603d8",
      "approve",
      home,
    ),
  );
  assert.deepEqual(
    received,
    [],
    "Redirect target must receive neither credentials nor request bodies",
  );
  assert.equal(
    (await loadConfig(home)).apiKey,
    key,
    "Failed exchange must preserve the original configuration",
  );
});

test('only plugin mode changes enforcement, independently of agent readiness', async (t) => {
  const { home, requests } = await fixture(t, endpoint => endpoint === '/v1/decisions' ? { body: { id: 'blocked', status: 'BLOCKED', effect: 'BLOCK' } } : undefined)
  const call = { hook_event_name: 'PreToolUse', session_id: 'transition', tool_use_id: '1', tool_name: 'Bash', tool_input: { command: 'echo example' } }
  process.env.CLAUDE_PLUGIN_OPTION_MODE = 'Monitoring'
  assert.equal((await runHook(home, call)).stdout, '')
  process.env.CLAUDE_PLUGIN_OPTION_MODE = 'Enforcing'
  assert.equal(JSON.parse((await runHook(home, {...call, tool_use_id: '2'})).stdout).hookSpecificOutput.permissionDecision, 'deny')
  assert.equal(requests.filter(r => r.path === '/v1/decisions').length, 2)
  assert.ok(requests.every(r => !r.path.endsWith('/readiness')))
})

test('mode changes with a backlog preserve the original monitoring decision on recovery', async (t) => {
  let unavailable = true
  const { home, requests } = await fixture(t, endpoint => endpoint === '/v1/decisions' && unavailable ? 503 : undefined)
  process.env.CLAUDE_PLUGIN_OPTION_MODE = 'Monitoring'
  const call = { session_id: 'recover', tool_use_id: 'one', tool_name: 'Bash', tool_input: { command: 'echo work' } }
  assert.equal((await runHook(home, { ...call, hook_event_name: 'PreToolUse' })).stdout, '')
  assert.equal((await runHook(home, { ...call, hook_event_name: 'PostToolUse' })).code, 0)
  assert.equal((await status(home)).pending, 2)
  process.env.CLAUDE_PLUGIN_OPTION_MODE = 'Enforcing'
  assert.equal((await status(home)).mode, 'ENFORCING')
  unavailable = false
  assert.equal((await flush(await loadConfig(home), { home, force: true })).pending, 0)
  const evaluations = requests.filter(r => r.path === '/v1/decisions')
  assert.ok(evaluations.every(r => r.body.mode === 'MONITORING'))
  assert.equal(new Set(evaluations.map(r => r.body.idempotency_key)).size, 1)
  const reports = requests.filter(r => r.path.endsWith('/reports'))
  assert.deepEqual(reports.map(r => r.body.outcome).sort(), ['SUCCESS'])
  assert.ok(reports.every(r => r.body.decision_id === 'decision-1' && !r.body._decision_request))
})

test('a host can report execution despite an enforcing block', async (t) => {
  const {home, requests} = await fixture(t, endpoint => endpoint === '/v1/decisions' ? {body: {id: 'blocked-1', status:'BLOCKED', effect:'BLOCK'}} : undefined)
  const call = {session_id:'contradiction',tool_use_id:'one',tool_name:'Bash',tool_input:{command:'echo work'}}
  assert.equal(JSON.parse((await runHook(home,{...call,hook_event_name:'PreToolUse'})).stdout).hookSpecificOutput.permissionDecision,'deny')
  assert.equal((await runHook(home,{...call,hook_event_name:'PostToolUse'})).code,0)
  const reports = requests.filter(r => r.path.endsWith('/reports'))
  assert.deepEqual(reports.map(r => r.body.outcome), ['SUCCESS'])
  assert.ok(reports.every(r => r.body.decision_id === 'blocked-1'))
})

test('obsolete queued enforcement reports do not obstruct actual execution reports', async (t) => {
  const { home, requests } = await fixture(t)
  const queue = path.join(home, 'queue')
  await mkdir(queue, { recursive: true })
  await writeFile(path.join(queue, '1.json'), JSON.stringify({ enforcement: 'PERMITTED', decision_id: 'decision-1' }))
  await writeFile(path.join(queue, '2.json'), JSON.stringify({ outcome: 'SUCCESS', decision_id: 'decision-1', idempotency_key: 'success', agent: { id: 'claude-local-test' } }))
  await writeFile(path.join(queue, '3.json'), JSON.stringify({ enforcement: 'NOT_ENFORCED', _decision_request: { idempotency_key: 'undelivered-decision', agent: { id: 'claude-local-test' }, action: { type: 'claude.tool.Bash' }, mode: 'MONITORING' } }))
  assert.equal((await flush(await loadConfig(home), { home, force: true })).pending, 0)
  assert.equal(requests.filter(r => r.path === '/v1/decisions').length, 1)
  const reports = requests.filter(r => r.path.endsWith('/reports'))
  assert.equal(reports.length, 1)
  assert.equal(reports[0].body.outcome, 'SUCCESS')
  assert.equal(reports[0].body.enforcement, undefined)
})

test('an unavailable enforcing check retries its decision without inventing execution', async (t) => {
  let unavailable = true
  const { home, requests } = await fixture(t, endpoint => endpoint === '/v1/decisions' && unavailable ? 503 : undefined)
  const result = await runHook(home, { hook_event_name: 'PreToolUse', session_id: 'deny-outage', tool_use_id: '1', tool_name: 'Bash', tool_input: { command: 'echo example' } })
  assert.equal(JSON.parse(result.stdout).hookSpecificOutput.permissionDecision, 'deny')
  assert.equal((await status(home)).pending, 1)
  unavailable = false
  assert.equal((await flush(await loadConfig(home), { home, force: true })).pending, 0)
  assert.equal(new Set(requests.filter(r => r.path === '/v1/decisions').map(r => r.body.idempotency_key)).size, 1)
  assert.equal(requests.filter(r => r.path.endsWith('/reports')).length, 0)
})

test('scanner sanitizes decisions, local correlation, queued reports and recovered execution outcomes', async (t) => {
  let unavailable = true
  const { home, requests } = await fixture(t, endpoint => endpoint === '/v1/decisions' && unavailable ? 503 : undefined)
  process.env.CLAUDE_PLUGIN_OPTION_MODE = 'Monitoring'
  const secret = ['ghp', 'Ab3De5Gh7Jk9Mn1Pq3St5Vw7Yz9Bc1Ef3Hi5Kl7N'.slice(0, 36)].join('_')
  const call = { session_id: 'redaction', tool_use_id: '1', tool_name: 'Bash', tool_input: { command: `echo ${secret}`, description: 'Synthetic redaction check' } }
  assert.equal((await runHook(home, { ...call, hook_event_name: 'PreToolUse' })).stdout, '')
  for (const directory of ['tool-calls', 'queue']) {
    for (const name of await readdir(path.join(home, directory))) {
      const stored = await readFile(path.join(home, directory, name), 'utf8')
      assert.ok(!stored.includes(secret))
      assert.ok(stored.includes('[redacted]'))
    }
  }
  assert.equal((await runHook(home, { ...call, hook_event_name: 'PostToolUse' })).code, 0)
  unavailable = false
  assert.equal((await flush(await loadConfig(home), { home, force: true })).pending, 0)
  assert.ok(!JSON.stringify(requests).includes(secret))
  const decision = requests.find(r => r.path === '/v1/decisions').body
  assert.equal(decision.action.attributes.parameters.command, 'echo [redacted]')
  assert.equal(decision.context.input_capture.status, 'redacted')
  assert.ok(requests.filter(r => r.path.endsWith('/reports')).every(r => r.body.action.attributes.parameters.command === 'echo [redacted]'))
})

test('scanner integrity failure records a monitoring omission and denies enforcing by default', async (t) => {
  const { home, requests } = await fixture(t)
  const { executable } = scannerBinary({ cacheRoot: path.join(home, 'scanner') })
  await writeFile(executable, 'corrupted scanner')
  process.env.CLAUDE_PLUGIN_OPTION_MODE = 'Monitoring'
  const call = { session_id: 'scanner-failed', tool_use_id: '1', tool_name: 'Bash', tool_input: { command: 'sensitive-unscanned-command' } }
  assert.equal((await runHook(home, { ...call, hook_event_name: 'PreToolUse' })).stdout, '')
  const decision = requests.find(r => r.path === '/v1/decisions').body
  assert.equal(decision.action.attributes.parameters, undefined)
  assert.deepEqual(decision.context.input_capture, { status: 'omitted', reason: 'scanner_integrity_failure' })
  assert.ok(!JSON.stringify(requests).includes(call.tool_input.command))
  assert.match((await status(home)).lastError.message, /scanner_integrity_failure/)
  process.env.CLAUDE_PLUGIN_OPTION_MODE = 'Enforcing'
  const result = await runHook(home, { ...call, tool_use_id: '2', hook_event_name: 'PreToolUse' })
  assert.equal(JSON.parse(result.stdout).hookSpecificOutput.permissionDecision, 'deny')
  assert.equal(requests.filter(r => r.path === '/v1/decisions').length, 1)
  process.env.CLAUDE_PLUGIN_OPTION_EVALUATION_FAILURE = 'Allow tool calls (fail open)'
  const continued = await runHook(home, { ...call, tool_use_id: '3', hook_event_name: 'PreToolUse' })
  assert.equal(continued.code, 0)
  assert.equal(continued.stdout, '')
  assert.ok(!JSON.stringify(requests).includes(call.tool_input.command))
  assert.match((await status(home)).lastError.message, /scanner_integrity_failure/)
})

test('native mode and failure options independently control unavailable and invalid evaluations', async (t) => {
  for (const mode of ['Monitoring', 'Enforcing']) {
    for (const failure of ['Block tool calls (fail closed)', 'Allow tool calls (fail open)']) {
      for (const response of [503, { body: {} }]) {
        await t.test(`${mode}, ${failure}, ${response === 503 ? 'outage' : 'invalid response'}`, async (subtest) => {
          const { home, requests } = await fixture(subtest, endpoint => endpoint === '/v1/decisions' ? response : undefined)
          process.env.CLAUDE_PLUGIN_OPTION_MODE = mode
          process.env.CLAUDE_PLUGIN_OPTION_EVALUATION_FAILURE = failure
          const result = await runHook(home, { hook_event_name: 'PreToolUse', session_id: 'options', tool_use_id: '1', tool_name: 'Read', tool_input: { file_path: 'fixture.txt' } })
          assert.equal(result.code, 0, result.stderr)
          if (mode === 'Enforcing' && failure.startsWith('Block')) assert.equal(JSON.parse(result.stdout).hookSpecificOutput.permissionDecision, 'deny')
          else assert.equal(result.stdout, '')
          assert.ok((await status(home)).lastError)
          assert.ok(requests.filter(r => r.path === '/v1/decisions').every(r => r.body.mode === mode.toUpperCase()))
        })
      }
    }
  }
})

test('fail open cannot bypass an explicit denial, rejection or approval requirement', async (t) => {
  for (const decisionStatus of ['BLOCKED', 'REJECTED', 'PENDING_APPROVAL']) {
    await t.test(decisionStatus, async (subtest) => {
      const { home } = await fixture(subtest, endpoint => endpoint === '/v1/decisions' ? { body: { id: 'decision-explicit', status: decisionStatus } } : undefined)
      process.env.CLAUDE_PLUGIN_OPTION_EVALUATION_FAILURE = 'Allow tool calls (fail open)'
      const result = await runHook(home, { hook_event_name: 'PreToolUse', session_id: 'explicit', tool_use_id: '1', tool_name: 'Read', tool_input: { file_path: 'fixture.txt' } })
      assert.equal(JSON.parse(result.stdout).hookSpecificOutput.permissionDecision, 'deny')
      assert.equal((await status(home)).lastError, undefined)
    })
  }
})

test('invalid native settings deny instead of silently downgrading enforcement', async (t) => {
  const { home, requests } = await fixture(t)
  process.env.CLAUDE_PLUGIN_OPTION_MODE = 'Typo'
  process.env.CLAUDE_PLUGIN_OPTION_EVALUATION_FAILURE = 'Allow tool calls (fail open)'
  const result = await runHook(home, { hook_event_name: 'PreToolUse', tool_name: 'Read', tool_input: { file_path: 'fixture.txt' } })
  assert.equal(result.code, 0)
  assert.equal(JSON.parse(result.stdout).hookSpecificOutput.permissionDecision, 'deny')
  assert.match(result.stdout, /Claude \/config/)
  assert.equal(requests.length, 0)
})
