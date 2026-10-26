// The plugin manifest declares these options as `userConfig`; the plugin's own
// tests check that its manifest matches this schema exactly.
export const userConfig = Object.freeze({
  mode: Object.freeze({
    type: 'string',
    title: 'Actera mode',
    description: 'Monitoring records policy results without blocking. Enforcing blocks denied actions and holds calls that need approval.',
    options: Object.freeze(['Monitoring', 'Enforcing']),
    default: 'Monitoring',
  }),
  evaluation_failure: Object.freeze({
    type: 'string',
    title: 'When Actera cannot evaluate',
    description: 'Applies only in Enforcing mode: choose what happens on service outages, timeouts, invalid responses or input-scanning failures. Explicit denials and required approvals remain enforced. Monitoring always continues.',
    options: Object.freeze(['Block tool calls (fail closed)', 'Allow tool calls (fail open)']),
    default: 'Block tool calls (fail closed)',
  }),
})

export class SettingsError extends Error {}

// Claude owns persistence and precedence. Hooks receive the effective options;
// standalone callers can supply the same environment without another config store.
export function runtimeSettings(env = process.env) {
  const values = {}
  for (const [key, schema] of Object.entries(userConfig)) {
    const value = env[`CLAUDE_PLUGIN_OPTION_${key.toUpperCase()}`] ?? schema.default
    if (!schema.options.includes(value))
      throw new SettingsError(`Invalid ${schema.title}. Choose a supported value in Claude /config.`)
    values[key] = value
  }
  return {
    mode: values.mode === 'Enforcing' ? 'ENFORCING' : 'MONITORING',
    onEvaluationError: values.evaluation_failure === 'Allow tool calls (fail open)' ? 'continue' : 'deny',
  }
}
