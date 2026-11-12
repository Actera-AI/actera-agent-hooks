#!/usr/bin/env node
import {
  agentReadiness,
  deliverBatch,
  disconnect,
  provisionBridge,
  recordEvaluationError,
} from '../../core/bridge.mjs'
import { connectWithSetupCode, pair } from '../../core/pairing.mjs'
import { runtimeSettings, saveSetting } from '../../core/settings.mjs'
import {
  EVENTS,
  bridgeHome,
  copilotEvaluationFailure,
  enqueueToolOutcome,
  loadConfig,
  readHookInput,
  recordHookRun,
  status,
} from './bridge.mjs'
import { deliverQueued, preToolUse } from './pre-tool-use.mjs'

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

async function connect(home) {
  const setupCode = option('setup-code')
  const result = setupCode !== undefined
    ? await connectWithSetupCode({ client: 'copilot', home, code: setupCode })
    : await pair({
      client: 'copilot',
      home,
      reconnect: process.argv.includes('--reconnect'),
      onWaiting: ({ codeHint, browserUrl }) => process.stdout.write(`Confirm code ${codeHint} in the Actera page that just opened.\nIf it did not open, visit: ${browserUrl}\nWaiting for an administrator to approve the connection...\n`),
    })
  const { modeName, evaluationFailureName } = (await status(home)).settings
  process.stdout.write(`${result.alreadyConnected ? 'Actera was already connected' : 'Actera is connected'} to agent ${result.agentId}.\n`)
  if (process.env.ACTERA_API_ORIGIN) process.stdout.write(`Using the ACTERA_API_ORIGIN override: ${result.baseUrl}\n`)
  if (result.archivedEvents) process.stdout.write(`Preserved ${result.archivedEvents} undelivered reports from the previous connection in ${result.archivePath}.\n`)
  process.stdout.write(`Mode: ${modeName}. When Actera cannot evaluate: ${evaluationFailureName}.\n`)
}

// Copilot denies a call when a preToolUse hook exits with an error, so a hook
// always exits cleanly and says deny itself only when enforcement asks for it.
async function hook(home, event) {
  if (!EVENTS.includes(event)) throw new Error(`Unknown Copilot hook event ${event}`)
  let config, input
  try {
    config = await loadConfig(home)
    input = await readHookInput(process.stdin)
  } catch (error) {
    await recordEvaluationError(error, home).catch(() => {})
    // Unreadable settings must not silently downgrade enforcement.
    const settings = await runtimeSettings(home).catch((settingsError) => settingsError)
    const deny = settings instanceof Error || (settings.mode === 'ENFORCING' && settings.onEvaluationError === 'deny')
    if (event === 'preToolUse' && deny) process.stdout.write(JSON.stringify(copilotEvaluationFailure(error)) + '\n')
    return
  }
  if (!config) return
  await recordHookRun(home, event).catch(() => {})
  if (event === 'preToolUse') {
    const output = await preToolUse(input, config, home)
    if (output) process.stdout.write(JSON.stringify(output) + '\n')
    return
  }
  try {
    await enqueueToolOutcome(event, input, config, home)
    await deliverQueued(config, home)
  } catch (error) {
    await recordEvaluationError(error, home).catch(() => {})
  }
}

async function main() {
  const command = process.argv[2]
  const home = bridgeHome()
  if (command === 'hook') { await hook(home, process.argv[3]); return }
  if (command === 'connect') { await connect(home); return }
  if (command === 'disconnect') {
    // Deliver here rather than through the core's background worker, which
    // this adapter never starts.
    const config = await loadConfig(home, {})
    if (config && !process.argv.includes('--discard')) {
      const result = await deliverBatch(config, { home, force: true, timeoutMs: 5000 })
      if (result.pending)
        throw new Error(`${result.pending} report(s) could not be delivered${result.error ? ` (${result.error})` : ''}. Run disconnect --discard to delete them.`)
    }
    process.stdout.write(JSON.stringify(await disconnect(home, { discard: true })) + '\n')
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
  const config = await loadConfig(home)
  if (command === 'ready') {
    if (!config) throw new Error('Connect first with /actera:connect')
    process.stdout.write(JSON.stringify(await agentReadiness(config, undefined, home)) + '\n')
    return
  }
  if (command === 'flush') {
    if (!config) throw new Error('Connect first with /actera:connect')
    const result = await deliverBatch(config, { home, force: true, timeoutMs: 5000 })
    process.stdout.write(JSON.stringify(result) + '\n')
    if (result.error) process.exitCode = 1
    return
  }
  throw new Error('Usage: actera-hook.mjs connect [--setup-code CODE | --reconnect] | mode monitoring|enforcing | evaluation-failure block|allow | status | ready | flush | disconnect [--discard] | setup --api-key-stdin | hook preToolUse|postToolUse|postToolUseFailure')
}

main().catch((error) => {
  process.stderr.write(`Actera Copilot bridge: ${error.message}\n`)
  process.exitCode = 1
})
