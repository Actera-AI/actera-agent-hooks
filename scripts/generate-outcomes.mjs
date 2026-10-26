import { readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { createHash } from 'node:crypto'
import assert from 'node:assert/strict'

const root = new URL('../', import.meta.url)
const bytes = readFileSync(new URL('contract/actera.openapi.json', root))
const manifest = JSON.parse(readFileSync(new URL('contract/manifest.json', root)))
assert.equal(createHash('sha256').update(bytes).digest('hex'), manifest.sha256)
const schema = JSON.parse(bytes).components.schemas
const values = (name) => Object.fromEntries(schema[name].enum.map((value) => [value, value]))
const output = '// Generated from the pinned Actera API contract. Do not edit.\n' +
  `export const ExecutionOutcome = Object.freeze(${JSON.stringify(values('v1ExecutionOutcome'), null, 2)})\n`
const target = new URL('src/core/generated/outcomes.mjs', root)
if (process.argv.includes('--check')) assert.equal(readFileSync(target, 'utf8'), output)
else { mkdirSync(new URL('.', target), { recursive: true }); writeFileSync(target, output) }
