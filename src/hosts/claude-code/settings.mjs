import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import path from 'node:path'

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

const envName = key => `CLAUDE_PLUGIN_OPTION_${key.toUpperCase()}`
const savedPath = home => path.join(home, 'plugin-settings.json')
const pick = env => Object.fromEntries(Object.keys(userConfig).map(envName).filter(name => env[name] !== undefined).map(name => [name, env[name]]))

// Claude hands its options to hooks only, so a skill's command cannot see them.
// Hooks save them here for `status`, whose own tool call runs a hook first.
export async function saveSettings(home, env = process.env) {
  const text = JSON.stringify(pick(env))
  if (text === '{}' || text === await readFile(savedPath(home), 'utf8').catch(() => undefined)) return
  await mkdir(home, { recursive: true, mode: 0o700 })
  const temporary = `${savedPath(home)}.${process.pid}.tmp`
  await writeFile(temporary, text, { mode: 0o600 })
  await rename(temporary, savedPath(home))
}

export async function withSavedSettings(home, env = process.env) {
  const saved = await readFile(savedPath(home), 'utf8').then(JSON.parse).catch(() => ({}))
  return { ...pick(saved), ...env }
}

// Claude owns persistence and precedence. Hooks receive the effective options;
// standalone callers can supply the same environment without another config store.
export function runtimeSettings(env = process.env) {
  const values = {}
  for (const [key, schema] of Object.entries(userConfig)) {
    const value = env[envName(key)] ?? schema.default
    if (!schema.options.includes(value))
      throw new SettingsError(`Invalid ${schema.title}. Choose a supported value in Claude /config.`)
    values[key] = value
  }
  return {
    mode: values.mode === 'Enforcing' ? 'ENFORCING' : 'MONITORING',
    onEvaluationError: values.evaluation_failure === 'Allow tool calls (fail open)' ? 'continue' : 'deny',
  }
}
