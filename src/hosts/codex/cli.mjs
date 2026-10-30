#!/usr/bin/env node
import {
  agentReadiness,
  deliverBatch,
  disconnect,
  enqueueDecision,
  previousApproval,
  provisionBridge,
  recordEvaluationError,
  rememberPendingApproval,
  requestDecision,
} from '../../core/bridge.mjs'
import { stopDelivery } from '../../core/delivery.mjs'
import { stopScanner } from '../../core/scanner-client.mjs'
import {
  activityForHook,
  approvalFingerprint,
  bridgeHome,
  codexEvaluationFailure,
  codexToolDecision,
  enqueueToolOutcome,
  evaluationForHook,
  holdForApproval,
  loadConfig,
  readHookInput,
  rememberToolDecision,
  status,
} from './bridge.mjs'
import { SettingsError, saveSetting } from './settings.mjs'
import path from 'node:path'

// Codex's hook timeout is set to 600 seconds in the plugin, so a held call
// gives up a minute earlier and tells the agent how to continue.
const holdMs = () => (Number(process.env.ACTERA_HOLD_SECONDS) || 540) * 1000
const pollMs = () => Number(process.env.ACTERA_HOLD_POLL_MS) || 2000

// Codex waits for every process a hook starts, so queued reports are sent
// from the hook itself rather than a background worker. A failure leaves them
// queued (with a short back-off) for the next hook or an explicit flush.
async function deliverQueued(config, home) {
  const result = await deliverBatch(config, { home, limit: 8, timeoutMs: 3000 })
  if (result.error) await recordEvaluationError(new Error(`Report delivery: ${result.error}`), home)
}

function option(name) {
  const index = process.argv.indexOf(`--${name}`)
  return index >= 0 ? process.argv[index + 1] : undefined
}

async function readText(stream) {
  let value = ''
  for await (const chunk of stream) {
    value += chunk.toString('utf8')
    if (value.length > 4096) throw new Error('API key input is too long')
  }
  return value
}

async function preToolUse(hook, config, home) {
  let output
  let evaluationError
  let request
  let decision
  const monitoring = config.mode === 'MONITORING'
  try {
    const activity = await activityForHook(hook, config, home)
    if (activity.details.tool_input_omitted && activity.details.tool_input_omitted !== 'metadata_only')
      evaluationError = new Error(`Actera tool inputs unavailable: ${activity.details.tool_input_omitted}`)
    request = evaluationForHook(hook, config, activity)
    await rememberToolDecision(hook, config, request, undefined, home)
    const fingerprint = approvalFingerprint(hook, config)
    decision = monitoring ? undefined : await previousApproval(home, fingerprint, config, request)
    if (!decision) {
      decision = await requestDecision(config, request)
      if (!monitoring) await rememberPendingApproval(home, fingerprint, decision, request)
    }
    if (!monitoring && decision.status === 'PENDING_APPROVAL')
      decision = await holdForApproval(config, decision, home, { holdMs: holdMs(), pollMs: pollMs() })
    await rememberToolDecision(hook, config, request, decision, home)
    output = monitoring ? null : codexToolDecision(decision)
  } catch (error) {
    evaluationError = error
    output = !monitoring && config.onEvaluationError === 'deny' ? codexEvaluationFailure(error) : null
  }
  try {
    if (request && !decision) await enqueueDecision(request, home)
    if (evaluationError) await recordEvaluationError(evaluationError, home)
    await deliverQueued(config, home)
  } catch (error) {
    await recordEvaluationError(error, home).catch(() => {})
  }
  if (output) process.stdout.write(JSON.stringify(output) + '\n')
}

async function main() {
  const command = process.argv[2]
  const home = bridgeHome()
  if (command === 'delivery-stop') { await stopDelivery(home); return }
  if (command === 'scanner-stop') { await stopScanner(path.join(home, 'scanner')); return }
  if (command === 'disconnect') {
    process.stdout.write(JSON.stringify(await disconnect(home, { discard: process.argv.includes('--discard') })) + '\n')
    return
  }
  if (command === 'setup') {
    if (!process.argv.includes('--api-key-stdin')) throw new Error('Pipe the agent key with --api-key-stdin')
    const result = await provisionBridge({
      baseUrl: option('base-url') ?? process.env.ACTERA_API_ORIGIN,
      agentId: option('agent-id'),
      capture: option('capture'),
      apiKey: (await readText(process.stdin)).trim(),
    }, home)
    process.stdout.write(`Configured ${result.agentId} for ${result.baseUrl} (${result.capture}).\n`)
    return
  }
  if (command === 'mode' || command === 'evaluation-failure') {
    await saveSetting(home, command === 'mode' ? 'mode' : 'evaluationFailure', process.argv[3])
    process.stdout.write(JSON.stringify((await status(home)).settings) + '\n')
    return
  }
  if (command === 'status') {
    process.stdout.write(JSON.stringify(await status(home), null, 2) + '\n')
    return
  }
  let config
  try { config = await loadConfig(home) } catch (error) {
    if (command !== 'hook' || !(error instanceof SettingsError)) throw error
    const hook = await readHookInput(process.stdin)
    await recordEvaluationError(error, home).catch(() => {})
    if (hook.hook_event_name === 'PreToolUse') process.stdout.write(JSON.stringify(codexEvaluationFailure(error)) + '\n')
    return
  }
  if (command === 'ready') {
    if (!config) throw new Error('Run setup first')
    process.stdout.write(JSON.stringify(await agentReadiness(config, undefined, home)) + '\n')
    return
  }
  if (command === 'flush') {
    if (!config) throw new Error('Run setup first')
    const result = await deliverBatch(config, { home, force: true, timeoutMs: 5000 })
    process.stdout.write(JSON.stringify(result) + '\n')
    if (result.error) process.exitCode = 1
    return
  }
  if (command === 'hook') {
    const hook = await readHookInput(process.stdin)
    if (!config) return
    if (hook.hook_event_name === 'PreToolUse') return preToolUse(hook, config, home)
    try {
      await enqueueToolOutcome(hook, config, home)
      await deliverQueued(config, home)
    } catch (error) {
      await recordEvaluationError(error, home).catch(() => {})
    }
    return // Other lifecycle hooks add nothing to Codex's context.
  }
  throw new Error('Usage: actera-hook.mjs setup|mode|evaluation-failure|status|ready|flush|disconnect|delivery-stop|scanner-stop|hook')
}

main().catch((error) => {
  process.stderr.write(`Actera Codex bridge: ${error.message}\n`)
  process.exitCode = 1
})
