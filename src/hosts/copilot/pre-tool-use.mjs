import {
  deliverBatch,
  enqueueDecision,
  holdForApproval,
  previousApproval,
  recordEvaluationError,
  rememberPendingApproval,
  requestDecision,
} from '../../core/bridge.mjs'
import {
  approvalFingerprint,
  copilotEvaluationFailure,
  copilotToolDecision,
  evaluationForHook,
  rememberReleasedCall,
  rememberToolDecision,
} from './bridge.mjs'

// Copilot lets a call run when a hook exceeds its timeout, so the plugin sets
// the preToolUse timeout to 600 seconds and a held call gives up a minute
// earlier, counted from the start of the hook, denied with a link to review it.
// ACTERA_HOLD_SECONDS can shorten the hold but not run it into that timeout.
const MAX_HOLD_SECONDS = 540
export const holdMs = () => Math.min(Number(process.env.ACTERA_HOLD_SECONDS) || MAX_HOLD_SECONDS, MAX_HOLD_SECONDS) * 1000
export const pollMs = () => Number(process.env.ACTERA_HOLD_POLL_MS) || 2000

// Queued reports are sent from the hook itself rather than a background
// worker. A failure leaves them queued (with a short back-off) for the next
// hook or an explicit flush.
export async function deliverQueued(config, home) {
  const result = await deliverBatch(config, { home, limit: 8, timeoutMs: 3000 })
  if (result.error) await recordEvaluationError(new Error(`Report delivery: ${result.error}`), home)
}

// Decide one preToolUse call and return Copilot's hook output, or null to
// leave the call to Copilot.
export async function preToolUse(hook, config, home) {
  const started = Date.now()
  let held = false
  let stillHeld = false
  let output
  let evaluationError
  let request
  let decision
  const monitoring = config.mode === 'MONITORING'
  try {
    const evaluation = await evaluationForHook(hook, config, home)
    if (evaluation.omitted && evaluation.omitted !== 'metadata_only') {
      evaluationError = new Error(`Actera tool inputs unavailable: ${evaluation.omitted}`)
      if (!monitoring) throw evaluationError
    }
    request = evaluation.request
    if (evaluation.unresolved)
      await recordEvaluationError(new Error(`Copilot's session log does not name the MCP server of ${hook.toolName}; the call is recorded as ${request.action.type}`), home).catch(() => {})
    await rememberToolDecision(hook, config, request, undefined, home)
    const fingerprint = approvalFingerprint(hook, config)
    try {
      decision = monitoring ? undefined : await previousApproval(home, fingerprint, config, request)
    } catch (error) {
      // This call was held for approval before. It stays held until Actera
      // says how that ended, whatever the evaluation-failure choice, and it is
      // not sent again as a new request.
      stillHeld = true
      output = copilotEvaluationFailure(error)
      throw error
    }
    // A retry may word its shell description differently; it reports against
    // the action the reused Decision captured.
    if (decision?.admittedRequest) request = decision.admittedRequest
    if (!decision) {
      decision = await requestDecision(config, request)
      if (!monitoring) await rememberPendingApproval(home, fingerprint, decision, request)
    }
    if (!monitoring && decision.status === 'PENDING_APPROVAL') {
      held = true
      decision = await holdForApproval(config, decision, home, { holdMs: Math.max(0, holdMs() - (Date.now() - started)), pollMs: pollMs() })
    }
    output = monitoring ? null : copilotToolDecision(decision)
    await rememberToolDecision(hook, config, request, decision, home)
  } catch (error) {
    evaluationError = error
    // Once Actera has answered, its answer stands whatever failed after it.
    // Only a call Actera never answered follows the evaluation-failure choice.
    if (output === undefined)
      output = monitoring ? null : decision ? copilotToolDecision(decision) : config.onEvaluationError === 'deny' ? copilotEvaluationFailure(error) : null
  }
  try {
    if (request && !decision && !stillHeld) await enqueueDecision(request, home)
    if (evaluationError) await recordEvaluationError(evaluationError, home)
    // After a hold there may be little time left before Copilot's timeout;
    // the next hook sends what is queued.
    if (!held) await deliverQueued(config, home)
  } catch (error) {
    await recordEvaluationError(error, home).catch(() => {})
  }
  if (request && output?.permissionDecision !== 'deny')
    await rememberReleasedCall(hook, config, request, decision, home).catch((error) => recordEvaluationError(error, home).catch(() => {}))
  return output
}
