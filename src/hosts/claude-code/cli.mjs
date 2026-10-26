#!/usr/bin/env node
import { stopDelivery } from '../../core/delivery.mjs'
import { spawn } from 'node:child_process'
import { stopScanner } from '../../core/scanner-client.mjs'
import { SettingsError } from './settings.mjs'
import {
  agentReadiness,
  activityForHook,
  claudeEvaluationFailure,
  claudeToolDecision,
  configure,
  decisionReview,
  disconnect,
  enqueueDecision,
  enqueueToolOutcome,
  evaluateHook,
  evaluationForHook,
  flush,
  wakeDelivery,
  bridgeHome,
  loadConfig,
  nativeReviewDecision,
  previousApproval,
  provisionBridge,
  readHookInput,
  recordEvaluationError,
  rememberPendingApproval,
  rememberToolDecision,
  reviewerLinkStatus,
  startReviewerLink,
  status,
} from './bridge.mjs'

function option(name) {
  const index = process.argv.indexOf(`--${name}`)
  return index >= 0 ? process.argv[index + 1] : undefined
}

function openBrowser(url) {
  const command = process.platform === 'win32' ? 'rundll32.exe' : process.platform === 'darwin' ? 'open' : 'xdg-open'
  const args = process.platform === 'win32' ? ['url.dll,FileProtocolHandler', url] : [url]
  const child = spawn(command, args, { detached: true, stdio: 'ignore' })
  child.on('error', () => {}) // The URL remains available in Claude if a browser cannot open.
  child.unref()
}

async function secretFromTerminal() {
  if (!process.stdin.isTTY || !process.stdin.setRawMode)
    throw new Error('Use a terminal or pipe the key with --api-key-stdin')
  process.stdout.write('Actera API key: ')
  process.stdin.setRawMode(true)
  process.stdin.resume()
  return new Promise((resolve, reject) => {
    let secret = ''
    const onData = (chunk) => {
      const characters = chunk.toString('utf8')
      for (const char of characters) {
        if (char === '\r' || char === '\n') {
          process.stdin.off('data', onData)
          process.stdin.setRawMode(false)
          process.stdin.pause()
          process.stdout.write('\n')
          resolve(secret)
          return
        }
        if (char === '\u0003') {
          process.stdin.off('data', onData)
          process.stdin.setRawMode(false)
          process.stdin.pause()
          process.stdout.write('\n')
          reject(new Error('Cancelled'))
          return
        }
        if (char === '\b' || char === '\u007f') secret = secret.slice(0, -1)
        else secret += char
      }
    }
    process.stdin.on('data', onData)
  })
}

async function main() {
  const command = process.argv[2]
  if (command === 'delivery-stop') { await stopDelivery(bridgeHome()); return }
  if (command === 'scanner-stop') { await stopScanner(); return }
  if (command === 'disconnect') {
    const result = await disconnect(undefined, { discard: process.argv.includes('--discard') })
    process.stdout.write(JSON.stringify(result) + '\n')
    return
  }
  if (command === 'setup') {
    if (option('mode') !== undefined || option('on-evaluation-error') !== undefined)
      throw new Error('Set Actera mode and evaluation-failure behavior in Claude /config.')
    const apiKey = process.argv.includes('--api-key-stdin')
      ? (await readHookInputText(process.stdin)).trim()
      : await secretFromTerminal()
    const result = await provisionBridge({
      baseUrl: option('base-url') ?? process.env.ACTERA_API_ORIGIN,
      agentId: option('agent-id'),
      capture: option('capture'),
      apiKey,
    })
    process.stdout.write(`Configured ${result.agentId} for ${result.baseUrl} (${result.capture}).\n`)
    return
  }
  if (command === 'status') {
    await wakeDelivery(undefined, { wait: true })
    const env = { ...process.env }
    if (option('mode') !== undefined) env.CLAUDE_PLUGIN_OPTION_MODE = option('mode')
    if (option('evaluation-failure') !== undefined) env.CLAUDE_PLUGIN_OPTION_EVALUATION_FAILURE = option('evaluation-failure')
    process.stdout.write(JSON.stringify(await status(undefined, env), null, 2) + '\n')
    return
  }
  if (command === 'capture') {
    const config = await loadConfig()
    if (!config) throw new Error('Run setup first')
    const result = await configure({ ...config, capture: option('mode') }, undefined)
    process.stdout.write(`Capture mode: ${result.capture}\n`)
    return
  }
  if (command === 'mode' || command === 'evaluation-error')
    throw new Error('Set Actera mode and evaluation-failure behavior in Claude /config.')
  let config
  try { config = await loadConfig() } catch (error) {
    if (command !== 'hook' || !(error instanceof SettingsError)) throw error
    const hook = await readHookInput(process.stdin)
    await recordEvaluationError(error).catch(() => {})
    if (hook.hook_event_name === 'PreToolUse') process.stdout.write(JSON.stringify(claudeEvaluationFailure(error)) + '\n')
    return
  }
  if (command === 'flush') {
    if (!config) throw new Error('Run setup first')
    const result = await flush(config, { force: true, timeoutMs: 5000 })
    process.stdout.write(JSON.stringify(result) + '\n')
    if (result.error) process.exitCode = 1
    return
  }
  if (command === 'link') {
    if (!config) throw new Error('Run setup first')
    const link = await startReviewerLink(config)
    if (process.argv.includes('--open')) openBrowser(link.browserUrl)
    if (process.argv.includes('--json')) process.stdout.write(JSON.stringify(link) + '\n')
    else
      process.stdout.write(
        `Open this URL in your browser and link your signed-in Actera account:\n${link.browserUrl}\nThen run: node actera-hook.mjs link-status\n`,
      )
    return
  }
  if (command === 'link-status') {
    if (!config) throw new Error('Run setup first')
    process.stdout.write(JSON.stringify(await reviewerLinkStatus(config)) + '\n')
    return
  }
  if (command === 'native-review') {
    if (!config) throw new Error('Run setup first')
    process.stdout.write(
      JSON.stringify(await nativeReviewDecision(config, option('decision-id'), option('choice'))) + '\n',
    )
    return
  }
  if (command === 'review-status') {
    if (!config) throw new Error('Run setup first')
    process.stdout.write(JSON.stringify(await decisionReview(config, option('decision-id'))) + '\n')
    return
  }
  if (command === 'test') {
    if (!config) throw new Error('Run setup first')
    await agentReadiness(config)
    const result = await flush(config, { force: true, timeoutMs: 5000 })
    process.stdout.write(JSON.stringify(result) + '\n')
    if (result.error || result.pending) process.exitCode = 1
    return
  }
  if (command === 'ready') {
    if (!config) throw new Error('Run setup first')
    process.stdout.write(JSON.stringify(await agentReadiness(config)) + '\n')
    return
  }
  if (command === 'hook') {
    const hook = await readHookInput(process.stdin)
    if (!config) {
      return
    }
    if (hook.hook_event_name === 'PreToolUse') {
      let output
      let evaluationError
      let request
      let decision
      const monitoring = (config.mode || 'MONITORING') === 'MONITORING'
      try {

        const activity = await activityForHook(hook, config)

        if (activity.details.tool_input_omitted && activity.details.tool_input_omitted !== 'metadata_only')
          evaluationError = new Error(`Actera tool inputs unavailable: ${activity.details.tool_input_omitted}`)
        request = evaluationForHook(hook, config, activity)
        await rememberToolDecision(hook, config, request)
        decision = monitoring ? undefined : await previousApproval(hook, config, request)
        if (!decision) {
          decision = await evaluateHook(hook, config, activity)
          if (!monitoring) await rememberPendingApproval(hook, config, decision, request)
        }
        await rememberToolDecision(hook, config, request, decision)
        output = monitoring ? null : claudeToolDecision(decision)
      } catch (error) {
        evaluationError = error
        output = !monitoring && (config.onEvaluationError || 'deny') === 'deny' ? claudeEvaluationFailure(error) : null
      }
      try {
        if (request && !decision) await enqueueDecision(request)
        await wakeDelivery()
        if (evaluationError) await recordEvaluationError(evaluationError)
      } catch (error) {
        await recordEvaluationError(error).catch(() => {})
      }
      if (output) process.stdout.write(JSON.stringify(output) + '\n')
      return
    }
    try {
      if (hook.hook_event_name === 'PostToolUse' || hook.hook_event_name === 'PostToolUseFailure')
        await enqueueToolOutcome(hook, config)
      await wakeDelivery()
    } catch (error) {
      await recordEvaluationError(error).catch(() => {})
      if (error?.message !== 'Actera report queue is full; flush queued events before continuing') throw error
    }
    return // Non-tool hooks do not inject text into Claude's context.
  }
  throw new Error('Usage: actera-hook.mjs setup|capture|status|test|ready|flush|link|link-status|native-review|review-status|disconnect|hook')
}

async function readHookInputText(stream) {
  let value = ''
  for await (const chunk of stream) {
    value += chunk.toString('utf8')
    if (value.length > 4096) throw new Error('API key input is too long')
  }
  return value
}

main().catch((error) => {
  process.stderr.write(`Actera Claude bridge: ${error.message}\n`)
  process.exitCode = 1
})
