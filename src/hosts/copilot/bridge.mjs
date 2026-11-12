import { createHash, randomUUID } from 'node:crypto'
import { mkdir, open, readFile, rename, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import {
  admittedCall,
  credentialID,
  loadConfig as loadConnection,
  localStatus,
  queueOutcomeReport,
  rememberAdmittedCall,
} from '../../core/bridge.mjs'
import { ExecutionOutcome } from '../../core/generated/outcomes.mjs'
import { captureInput } from '../../core/input-capture.mjs'
import { runtimeSettings } from '../../core/settings.mjs'

// GitHub Copilot CLI hook adapter: maps Copilot's native (camelCase) hook
// events onto Actera decisions, call identities and execution reports, and
// Decisions back onto Copilot's preToolUse output. A call that needs approval
// is held here while a reviewer decides in Actera, Slack or email.
// Copilot names no event in a camelCase payload, so the plugin passes it as an
// argument. Like the Codex adapter, this one leaves no process running after a
// hook: reports are sent from the hook itself and the scanner runs once per call.

const MAX_HOOK_BYTES = 16 * 1024 * 1024
// Copilot appends to the session's events.jsonl; the record of a call that is
// about to run is near its end.
const SESSION_TAIL_BYTES = 4 * 1024 * 1024
export const EVENTS = Object.freeze(['preToolUse', 'postToolUse', 'postToolUseFailure'])

export function bridgeHome() {
  return process.env.ACTERA_COPILOT_BRIDGE_HOME || path.join(os.homedir(), '.actera', 'copilot')
}

export async function loadConfig(home = bridgeHome(), env = process.env) {
  const config = await loadConnection(home)
  return config ? { ...config, ...(await runtimeSettings(home, env)) } : undefined
}

function scalar(value) {
  return typeof value === 'string'
    ? value.slice(0, 1024)
    : typeof value === 'number' || typeof value === 'boolean'
      ? value
      : undefined
}

// Copilot passes apply_patch its patch as a string. Policies read every tool's
// inputs as an object, so a string becomes { patch } or { input }.
export function toolInput(hook) {
  const args = hook.toolArgs
  if (args && typeof args === 'object' && !Array.isArray(args)) return args
  if (args === undefined || args === null) return {}
  return hook.toolName === 'apply_patch' && typeof args === 'string' ? { patch: args } : { input: args }
}

function copilotHome(env = process.env) {
  return env.COPILOT_HOME || path.join(os.homedir(), '.copilot')
}

async function sessionTail(file) {
  const handle = await open(file, 'r')
  try {
    const { size } = await handle.stat()
    const length = Math.min(size, SESSION_TAIL_BYTES)
    const buffer = Buffer.alloc(length)
    await handle.read(buffer, 0, length, size - length)
    return buffer.toString('utf8')
  } finally {
    await handle.close()
  }
}

// Copilot names an MCP tool <server>-<tool>, and both parts may contain
// hyphens, so the name alone cannot be split. Built-in tools never contain a
// hyphen. Copilot records each call with its MCP server and tool in the
// session's events.jsonl before the hook runs; that file is not a documented
// contract, so a call it does not describe stays an ordinary tool.
export async function mcpToolForHook(hook, { env = process.env, attempts = 5, waitMs = 100 } = {}) {
  const name = hook.toolName
  if (typeof name !== 'string' || !name.includes('-')) return undefined
  if (typeof hook.sessionId !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(hook.sessionId) || typeof hook.toolCallId !== 'string') return undefined
  const file = path.join(copilotHome(env), 'session-state', hook.sessionId, 'events.jsonl')
  for (let attempt = 0; attempt < attempts; attempt++) {
    if (attempt) await delay(waitMs)
    let text
    try {
      text = await sessionTail(file)
    } catch {
      continue
    }
    for (const line of text.split('\n').reverse()) {
      if (!line.includes(hook.toolCallId)) continue
      let event
      try {
        event = JSON.parse(line)
      } catch {
        continue // A partly written line or the cut at the start of the tail.
      }
      const candidates = [event?.data, ...(Array.isArray(event?.data?.toolRequests) ? event.data.toolRequests : [])]
      const call = candidates.find((item) => item?.toolCallId === hook.toolCallId && typeof item.mcpServerName === 'string' && typeof item.mcpToolName === 'string')
      if (call && `${call.mcpServerName}-${call.mcpToolName}` === name)
        return { server_key: call.mcpServerName.slice(0, 256), tool_name: call.mcpToolName.slice(0, 256) }
    }
  }
  return undefined
}

export function actionType(hook, mcp) {
  return mcp ? `copilot.mcp.${mcp.tool_name}` : `copilot.tool.${hook.toolName}`
}

function sessionContext(hook) {
  const copilot = {}
  for (const [to, from] of [
    ['session_id', 'sessionId'],
    ['cwd', 'cwd'],
    ['subagent_id', 'agentId'],
    ['subagent_type', 'agentType'],
    ['parent_agent_id', 'parentAgentId'],
  ]) {
    const value = scalar(hook[from])
    if (value !== undefined) copilot[to] = value
  }
  return copilot
}

function validHook(hook) {
  if (!hook || typeof hook !== 'object' || Array.isArray(hook)) throw new Error('Invalid Copilot hook event')
  if (typeof hook.toolName !== 'string' || !hook.toolName || hook.toolName.length > 256)
    throw new Error('Copilot sent no valid tool name')
}

// The Decision request for one preToolUse call, with its inputs captured
// locally: sensitive fields masked and secrets found by Gitleaks redacted.
export async function evaluationForHook(hook, config, home = bridgeHome(), { env = process.env } = {}) {
  validHook(hook)
  const input = toolInput(hook)
  const mcp = await mcpToolForHook(hook, { env })
  // Copilot's own tools have no hyphen in their names, so a hyphenated tool the
  // session log does not describe is taken for an MCP tool whose server is
  // unknown. It keeps its full name and says so, because a policy written for
  // copilot.mcp.<tool> does not cover it.
  const unresolved = !mcp && hook.toolName.includes('-')
  // No helper outlives the hook; see the note at the top.
  const captured = await captureInput(input, config.capture, { scannerRoot: path.join(home, 'scanner'), persistentScanner: false })
  const omitted = captured.metadata.status === 'omitted' ? captured.metadata.reason : undefined
  const callIdentity = [credentialID(config), hook.sessionId || '', hook.agentId || '', hook.toolCallId || randomUUID()]
  const callHash = createHash('sha256').update(JSON.stringify(callIdentity)).digest('hex')
  const request = {
    idempotency_key: `copilot-tool:${callHash}`,
    mode: config.mode || 'MONITORING',
    agent: { id: config.agentId },
    action: {
      type: actionType(hook, mcp),
      attributes: {
        tool_name: hook.toolName,
        ...(mcp ? { mcp } : {}),
        ...(captured.parameters !== undefined ? { parameters: captured.parameters } : {}),
        input_fields: Object.keys(input),
      },
    },
    context: {
      copilot: { ...sessionContext(hook), ...(hook.toolCallId ? { tool_call_id: scalar(hook.toolCallId) } : {}), ...(unresolved ? { mcp_lookup: 'missed' } : {}) },
      source: 'copilot_hook',
      capture: config.capture || 'tool-inputs',
      input_capture: captured.metadata,
    },
  }
  return { request, omitted, unresolved }
}

function toolCallKey(hook, config) {
  if (!hook.sessionId || !hook.toolCallId || typeof hook.toolName !== 'string') return undefined
  return createHash('sha256')
    .update(JSON.stringify([config.baseUrl, credentialID(config), config.agentId, hook.sessionId, hook.agentId || '', hook.toolCallId]))
    .digest('hex')
}

function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`
  if (value && typeof value === 'object')
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`)
      .join(',')}}`
  return JSON.stringify(value)
}

// The model writes a new description for every shell call, and initial_wait
// only says how long Copilot waits for output, so neither changes what runs.
const NARRATION_FIELDS = new Map([['bash', ['description', 'initial_wait']], ['powershell', ['description', 'initial_wait']]])

function proposedInput(hook) {
  const input = toolInput(hook)
  const narration = NARRATION_FIELDS.get(hook.toolName)
  return narration ? Object.fromEntries(Object.entries(input).filter(([key]) => !narration.includes(key))) : input
}

// A retry is the same proposed effect only within one Copilot session (and
// subagent), in the same working directory, for the same tool and arguments.
// Never persist plaintext tool arguments.
export function approvalFingerprint(hook, config) {
  if (!hook.sessionId || typeof hook.toolName !== 'string') return undefined
  return createHash('sha256')
    .update(canonicalJson([credentialID(config), config.agentId, hook.sessionId, hook.agentId || '', hook.cwd || '', hook.toolName, proposedInput(hook)]))
    .digest('hex')
}

export async function rememberToolDecision(hook, config, request, decision, home = bridgeHome()) {
  const key = toolCallKey(hook, config)
  if (!key) throw new Error('A session and tool call ID are required for reporting')
  await rememberAdmittedCall(home, key, { decisionId: decision?.id, request, fingerprint: approvalFingerprint(hook, config) })
}

// Copilot ends a shell tool's result text with this line. It is not a
// documented contract, so a result without it is judged by its event alone.
const SHELL_EXIT = /<shellId: \S+ completed with exit code (-?\d+)>\s*$/

function shellExitCode(hook) {
  const text = hook.toolResult?.textResultForLlm
  if (!NARRATION_FIELDS.has(hook.toolName) || typeof text !== 'string') return undefined
  const match = SHELL_EXIT.exec(text)
  return match ? Number(match[1]) : undefined
}

// Copilot runs postToolUse after a call that completed and postToolUseFailure
// after one that could not, with the same tool call ID as preToolUse. A shell
// command that exits with an error still completes, so Copilot calls it a
// success; its exit code says it failed. A result Copilot calls neither a
// success nor a failure is not reported as either.
function outcomeForHook(event, hook) {
  const failed = { outcome: ExecutionOutcome.FAILURE, summary: 'Copilot reported that the tool call failed.' }
  if (event === 'postToolUseFailure') return failed
  if (event !== 'postToolUse') return undefined
  const type = hook.toolResult?.resultType
  if (type === 'failure') return failed
  if (type !== undefined && type !== 'success') return undefined
  const exitCode = shellExitCode(hook)
  if (exitCode)
    return { outcome: ExecutionOutcome.FAILURE, summary: `Copilot ran the command and it exited with code ${exitCode}.` }
  return { outcome: ExecutionOutcome.SUCCESS, summary: 'Copilot reported that the tool call completed successfully.' }
}

export async function enqueueToolOutcome(event, hook, config, home = bridgeHome()) {
  const { outcome, summary } = outcomeForHook(event, hook) ?? {}
  if (!outcome) return undefined
  const key = toolCallKey(hook, config)
  if (!key) return undefined
  const admitted = await admittedCall(home, key)
  if (!admitted) return undefined
  const fingerprint = approvalFingerprint(hook, config)
  if (!fingerprint || fingerprint !== admitted.fingerprint)
    throw new Error('Post-tool call does not match the admitted Actera action')
  const request = admitted.request
  return queueOutcomeReport(home, key, outcome, {
    idempotency_key: `copilot-tool-outcome:${credentialID(config)}:${key}:${outcome}`,
    decision_id: admitted.decisionId,
    _decision_request: request,
    outcome,
    occurred_at: new Date().toISOString(),
    agent: request.agent,
    action: request.action,
    context: request.context,
    details: {
      schema_version: 1,
      source: 'copilot_hook',
      hook_event: event,
      tool_name: hook.toolName,
      tool_call_id: hook.toolCallId,
      outcome_scope: 'tool_call',
      summary,
    },
  })
}

// Copilot shows the reason to the model, which relays it to the person.
// Output is Copilot's camelCase shape: Copilot ignores Claude's
// hookSpecificOutput in this format.
export function copilotToolDecision(decision) {
  if (decision.status === 'ALLOWED') return null
  // An explicit Actera approval authorizes this exact call, so Copilot does
  // not ask for it again. An ordinary ALLOWED leaves Copilot's own rules.
  if (decision.status === 'APPROVED')
    return { permissionDecision: 'allow', permissionDecisionReason: `Actera decision ${decision.id} was approved by a reviewer.` }
  const deny = (reason) => ({ permissionDecision: 'deny', permissionDecisionReason: reason })
  if (decision.status === 'PENDING_APPROVAL')
    return deny(`Actera decision ${decision.id} is still waiting for a reviewer.${decision.review_url ? ` Review it at ${decision.review_url}.` : ''} Once it is approved, retry this exact tool call; the approval releases one matching retry.`)
  if (decision.status === 'ALREADY_RELEASED')
    return deny(`Actera decision ${decision.id} was approved, but that approval already released another call.`)
  if (decision.status === 'REJECTED')
    return deny(`A reviewer rejected this tool call in Actera (decision ${decision.id})${decision.reason ? `: ${decision.reason}` : '.'}`)
  return deny(`Actera decision ${decision.id} ${decision.status.toLowerCase().replaceAll('_', ' ')}: ${decision.explanation || 'Tool call not allowed.'}`)
}

export function copilotEvaluationFailure(error) {
  return { permissionDecision: 'deny', permissionDecisionReason: `Actera could not evaluate this tool call: ${error.message}` }
}

// status reports a connection whose hooks have never run, which means Copilot
// has not loaded the plugin in a session yet.
export async function recordHookRun(home, event) {
  const file = path.join(home, 'last-hook.json')
  await mkdir(home, { recursive: true, mode: 0o700 })
  const temporary = `${file}.${randomUUID()}.tmp`
  try {
    await writeFile(temporary, JSON.stringify({ at: new Date().toISOString(), event }) + '\n', { mode: 0o600 })
    await rename(temporary, file)
  } finally {
    await rm(temporary, { force: true })
  }
}

async function lastHookRun(home) {
  try { return JSON.parse(await readFile(path.join(home, 'last-hook.json'), 'utf8')) } catch { return null }
}

export async function status(home = bridgeHome(), env = process.env) {
  const config = await loadConfig(home, env)
  const { delivery, ...local } = await localStatus(home)
  const lastHook = await lastHookRun(home)
  return {
    configured: !!config,
    settings: await runtimeSettings(home, env),
    settingsManagedBy: '/actera:mode',
    ...(config ? { baseUrl: config.baseUrl, agentId: config.agentId, capture: config.capture, mode: config.mode, onEvaluationError: config.onEvaluationError } : {}),
    lastHook,
    ...(config && !lastHook ? { hooksNeedAttention: 'No Actera hook has run in Copilot yet. Start a new Copilot session so it loads the plugin, then use any tool.' } : {}),
    // Reports are sent by the hooks themselves; there is no background worker.
    ...local,
  }
}

export async function readHookInput(stream) {
  const chunks = []
  let size = 0
  for await (const chunk of stream) {
    size += chunk.length
    if (size > MAX_HOOK_BYTES) throw new Error('Copilot hook input exceeds 16 MiB')
    chunks.push(chunk)
  }
  return JSON.parse(Buffer.concat(chunks).toString('utf8'))
}
