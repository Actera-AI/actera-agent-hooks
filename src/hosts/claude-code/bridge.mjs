import { createHash, randomUUID } from 'node:crypto'
import {
  admittedCall,
  bridgeHome,
  credentialID,
  loadConfig as loadConnection,
  localStatus,
  previousApproval as previousCoreApproval,
  queueOutcomeReport,
  rememberAdmittedCall,
  rememberPendingApproval as rememberCoreApproval,
  requestDecision,
  reviewDecision,
  reviewedElsewhere,
} from '../../core/bridge.mjs'
import { ExecutionOutcome } from '../../core/generated/outcomes.mjs'
import { captureInput } from '../../core/input-capture.mjs'
import { runtimeSettings } from './settings.mjs'

// Claude Code hook adapter: maps Claude's hook events onto Actera decisions,
// call identities and execution reports, and Decisions back onto Claude's
// PreToolUse output. Everything else is the host-neutral core.
export {
  agentReadiness,
  bridgeHome,
  configure,
  deliverBatch,
  disconnect,
  enqueueDecision,
  flush,
  pendingCount,
  provisionBridge,
  pruneLocalState,
  queueSummary,
  recordEvaluationError,
  reviewerLinkStatus,
  startReviewerLink,
  validateConfig,
  wakeDelivery,
} from '../../core/bridge.mjs'

const MAX_HOOK_BYTES = 16 * 1024 * 1024
const DETAIL_FIELDS = [
  'tool_name',
  'tool_use_id',
  'agent_id',
  'agent_type',
  'source',
  'reason',
  'event',
  'command_name',
  'file_path',
  'directory',
  'old_cwd',
  'new_cwd',
  'message_id',
  'index',
  'final',
  'name',
  'from_model',
  'to_model',
]

export async function loadConfig(home = bridgeHome(), env = process.env) {
  const config = await loadConnection(home)
  return config ? { ...config, ...runtimeSettings(env) } : undefined
}

function toolCallKey(hook, config) {
  if (!hook.session_id || !hook.tool_use_id || typeof hook.tool_name !== 'string') return undefined
  return createHash('sha256')
    .update(
      JSON.stringify([
        config.baseUrl,
        credentialID(config),
        config.agentId,
        hook.session_id,
        hook.agent_id || '',
        hook.tool_use_id,
      ]),
    )
    .digest('hex')
}

function scalar(value) {
  return typeof value === 'string'
    ? value.slice(0, 1024)
    : typeof value === 'number' || typeof value === 'boolean'
      ? value
      : undefined
}

// Claude names MCP tools mcp__<server>__<tool>. The server segment is an
// opaque, potentially changing registration key, so it is evidence rather
// than part of the policy-facing action type.
export function mcpToolForHook(hook) {
  const name = hook.tool_name
  if (typeof name !== 'string' || !name.startsWith('mcp__')) return undefined
  const remainder = name.slice('mcp__'.length)
  const separator = remainder.indexOf('__')
  if (separator < 1 || separator + 2 >= remainder.length) throw new Error('Claude supplied an invalid MCP tool name')
  const mcp = { server_key: remainder.slice(0, separator), tool_name: remainder.slice(separator + 2) }
  const provenance = hook.mcp_server
  if (provenance && typeof provenance === 'object' && !Array.isArray(provenance)) {
    if (typeof provenance.name === 'string' && provenance.name.length <= 256) mcp.server_name = provenance.name
    if (typeof provenance.source === 'string' && provenance.source.length <= 64) mcp.source = provenance.source
  }
  return mcp
}

export async function activityForHook(hook, config, eventId = randomUUID(), occurredAt = new Date().toISOString()) {
  if (!hook || typeof hook !== 'object' || Array.isArray(hook) || !/^[A-Za-z]+$/.test(hook.hook_event_name || ''))
    throw new Error('Invalid Claude hook event')
  const eventName = hook.hook_event_name
  const toolName = typeof hook.tool_name === 'string' ? hook.tool_name : undefined
  if (toolName?.length > 256) throw new Error('Claude tool name exceeds 256 characters')
  const mcp = mcpToolForHook(hook)
  const details = {
    schema_version: 1,
    source: 'claude_code_hook',
    event_id: eventId,
    capture: config.capture,
  }
  for (const field of DETAIL_FIELDS) {
    const value = scalar(hook[field])
    if (value !== undefined) details[field] = value
  }
  if (hook.tool_input && typeof hook.tool_input === 'object' && !Array.isArray(hook.tool_input)) {
    details.tool_input_fields = Object.keys(hook.tool_input)
    const captured = await captureInput(hook.tool_input, config.capture)
    details.input_capture = captured.metadata
    if (captured.parameters !== undefined) details.tool_input = captured.parameters
    if (captured.metadata.status === 'omitted') details.tool_input_omitted = captured.metadata.reason
  }
  if (eventName === 'MessageDisplay') {
    details.text_length = typeof hook.delta === 'string' ? hook.delta.length : 0
  }
  const claude = {}
  for (const [to, from] of [
    ['session_id', 'session_id'],
    ['prompt_id', 'prompt_id'],
    ['subagent_id', 'agent_id'],
    ['subagent_type', 'agent_type'],
    ['cwd', 'cwd'],
    ['permission_mode', 'permission_mode'],
  ]) {
    const value = scalar(hook[from])
    if (value !== undefined) claude[to] = value
  }
  return {
    idempotency_key: `claude-hook:${credentialID(config)}:${eventId}`,
    event_type: `claude.hook.${eventName}`,
    agent: { id: config.agentId },
    action: {
      type: mcp ? `claude.mcp.${mcp.tool_name}` : toolName ? `claude.tool.${toolName}` : `claude.hook.${eventName}`,
      attributes: { hook_event: eventName, ...(toolName ? { tool_name: toolName } : {}), ...(mcp ? { mcp } : {}) },
    },
    context: { claude },
    occurred_at: occurredAt,
    details,
  }
}

export function evaluationForHook(hook, config, activity) {
  if (hook.hook_event_name !== 'PreToolUse' || !activity.details.tool_name)
    throw new Error('Only PreToolUse tool calls can be evaluated')
  if (activity.details.tool_input_omitted && activity.details.tool_input_omitted !== 'metadata_only' && config.mode === 'ENFORCING')
    throw new Error(`Actera tool inputs unavailable: ${activity.details.tool_input_omitted}`)
  const callIdentity = [
    credentialID(config),
    hook.session_id || '',
    hook.agent_id || '',
    hook.tool_use_id || activity.details.event_id,
  ]
  const callHash = createHash('sha256').update(JSON.stringify(callIdentity)).digest('hex')
  return {
    idempotency_key: `claude-tool:${callHash}`,
    mode: config.mode || 'MONITORING',
    agent: { id: config.agentId },
    action: {
      type: activity.action.type,
      attributes: {
        tool_name: activity.details.tool_name,
        ...(activity.action.attributes.mcp ? { mcp: activity.action.attributes.mcp } : {}),
        ...(activity.details.tool_input ? { parameters: activity.details.tool_input } : {}),
        ...(activity.details.tool_input_fields ? { input_fields: activity.details.tool_input_fields } : {}),
      },
    },
    context: {
      claude: { ...activity.context.claude, ...(hook.tool_use_id ? { tool_use_id: hook.tool_use_id } : {}) },
      source: 'claude_code_hook',
      capture: config.capture || 'tool-inputs',
      ...(activity.details.input_capture ? { input_capture: activity.details.input_capture } : {}),
      ...(hook.source === 'actera_bridge_test' ? { bridge_test: true } : {}),
    },
  }
}

// Raw arguments are used only in a digest to bind the tool result to the admitted call.
export async function rememberToolDecision(hook, config, request, decision, home = bridgeHome()) {
  const key = toolCallKey(hook, config)
  if (!key) throw new Error('A session and tool invocation ID are required for reporting')
  await rememberAdmittedCall(home, key, {
    decisionId: decision?.id,
    request,
    fingerprint: approvalFingerprint(hook, config),
  })
}

export async function enqueueToolOutcome(hook, config, home = bridgeHome()) {
  if (!['PostToolUse', 'PostToolUseFailure'].includes(hook.hook_event_name)) return undefined
  const key = toolCallKey(hook, config)
  if (!key) return undefined
  const admitted = await admittedCall(home, key)
  if (!admitted) return undefined
  const fingerprint = approvalFingerprint(hook, config)
  if (!fingerprint || fingerprint !== admitted.fingerprint)
    throw new Error('Post-tool call does not match the admitted Actera action')
  const request = admitted.request
  // Normalize the host lifecycle to the shared execution outcome contract.
  // This remains host-reported tool evidence, not proof of a business effect.
  const outcome =
    hook.hook_event_name === 'PostToolUse' ? ExecutionOutcome.SUCCESS : hook.is_interrupt === true ? ExecutionOutcome.CANCELLED : ExecutionOutcome.FAILURE
  const details = {
    schema_version: 1,
    source: 'claude_code_hook',
    hook_event: hook.hook_event_name,
    tool_name: hook.tool_name,
    tool_use_id: hook.tool_use_id,
    outcome_scope: 'tool_call',
    summary:
      outcome === ExecutionOutcome.SUCCESS
        ? 'Claude Code reported that the tool call completed successfully.'
        : outcome === ExecutionOutcome.CANCELLED
          ? 'Claude Code reported that the tool call was interrupted.'
          : 'Claude Code reported that the tool call failed.',
  }
  // A later definitive result may resolve an interrupted/uncertain call.
  // Retries of that same outcome keep their identity; a correction is new evidence.
  return queueOutcomeReport(home, key, outcome, {
    idempotency_key: `claude-tool-outcome:${credentialID(config)}:${key}:${outcome}`,
    decision_id: admitted.decisionId,
    _decision_request: request,
    outcome,
    occurred_at: new Date().toISOString(),
    agent: request.agent,
    action: request.action,
    context: request.context,
    details,
  })
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

// Claude's permission prompt for AskUserQuestion writes the person's choices
// into the tool input, so PostToolUse carries fields PreToolUse never saw.
// They are the reply, not the proposed call.
const PROMPT_REPLY_FIELDS = new Map([['AskUserQuestion', ['answers', 'annotations']]])

function proposedInput(hook) {
  const reply = PROMPT_REPLY_FIELDS.get(hook.tool_name)
  if (!reply) return hook.tool_input
  return Object.fromEntries(Object.entries(hook.tool_input).filter(([key]) => !reply.includes(key)))
}

// A retry is the same proposed effect only within one Claude session, for the
// same raw tool and exact arguments. Never persist plaintext tool arguments.
export function approvalFingerprint(hook, config) {
  if (
    !hook.session_id ||
    !hook.tool_use_id ||
    typeof hook.tool_name !== 'string' ||
    !hook.tool_input ||
    typeof hook.tool_input !== 'object' ||
    Array.isArray(hook.tool_input)
  )
    return undefined
  return createHash('sha256')
    .update(
      canonicalJson([
        credentialID(config),
        config.agentId,
        hook.session_id,
        hook.agent_id || '',
        hook.tool_name,
        proposedInput(hook),
      ]),
    )
    .digest('hex')
}

export async function rememberPendingApproval(hook, config, decision, request, home = bridgeHome()) {
  await rememberCoreApproval(home, approvalFingerprint(hook, config), decision, request)
}

export async function previousApproval(hook, config, request, home = bridgeHome(), timeoutMs = 5000) {
  return previousCoreApproval(home, approvalFingerprint(hook, config), config, request, timeoutMs)
}

export async function nativeReviewDecision(config, decisionId, choice, home = bridgeHome(), timeoutMs = 8000) {
  return reviewDecision(config, decisionId, choice, { home, idempotencyPrefix: 'claude-native', rejectReason: 'Declined in Claude Code', timeoutMs })
}

// A reviewer can resolve a held call on the Actera Decision page while
// Claude's prompt is open. An approval found here is claimed for this call.
export async function decisionReview(config, decisionId, home = bridgeHome(), timeoutMs = 5000) {
  const { id, status } = await reviewedElsewhere(config, decisionId, home, timeoutMs)
  return { id, status }
}

export async function evaluateHook(hook, config, activity, timeoutMs = 8000) {
  return requestDecision(config, evaluationForHook(hook, config, activity), timeoutMs)
}

export function claudeToolDecision(decision) {
  // An explicit Actera approval authorizes this exact tool call. Ordinary
  // ALLOWED decisions leave Claude's own permission flow unchanged.
  if (decision.status === 'ALLOWED') return null
  if (decision.status === 'APPROVED')
    return {
      hookSpecificOutput: {
        hookEventName: 'PreToolUse',
        permissionDecision: 'allow',
        permissionDecisionReason: `Actera decision ${decision.id} approved`,
      },
    }
  if (decision.status === 'PENDING_APPROVAL')
    return {
      hookSpecificOutput: {
        hookEventName: 'PreToolUse',
        permissionDecision: 'deny',
        permissionDecisionReason: `Actera decision ${decision.id} is awaiting approval. Approve it in Actera, then retry this exact tool call. The bridge will reuse this Decision for one matching retry.`,
      },
    }
  return {
    hookSpecificOutput: {
      hookEventName: 'PreToolUse',
      permissionDecision: 'deny',
      permissionDecisionReason: `Actera decision ${decision.id} ${decision.status.toLowerCase().replaceAll('_', ' ')}: ${decision.explanation || 'Tool call not allowed.'}`,
    },
  }
}

export function claudeEvaluationFailure(error) {
  return {
    hookSpecificOutput: {
      hookEventName: 'PreToolUse',
      permissionDecision: 'deny',
      permissionDecisionReason: `Actera could not evaluate this tool call: ${error.message}`,
    },
  }
}

export async function status(home = bridgeHome(), env = process.env) {
  const config = await loadConfig(home, env)
  return {
    configured: !!config,
    settings: runtimeSettings(env),
    settingsManagedBy: 'Claude /config',
    ...(config ? { baseUrl: config.baseUrl, agentId: config.agentId, capture: config.capture, mode: config.mode || 'MONITORING', onEvaluationError: config.onEvaluationError || 'deny' } : {}),
    ...(await localStatus(home)),
  }
}

export async function readHookInput(stream) {
  const chunks = []
  let size = 0
  for await (const chunk of stream) {
    size += chunk.length
    if (size > MAX_HOOK_BYTES) throw new Error('Claude hook input exceeds 16 MiB')
    chunks.push(chunk)
  }
  return JSON.parse(Buffer.concat(chunks).toString('utf8'))
}
