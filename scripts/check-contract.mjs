import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'

const dir = new URL('../contract/', import.meta.url)
const manifest = JSON.parse(readFileSync(new URL('manifest.json', dir)))
const bytes = readFileSync(new URL('actera.openapi.json', dir))
assert.equal(createHash('sha256').update(bytes).digest('hex'), manifest.sha256,
  'Contract digest changed; import a released contract with update-contract.mjs')
const contract = JSON.parse(bytes)

// Check the operations this integration consumes. The authoritative customer API
// also contains managed-execution operations used by SDKs, not by this plugin.
const operations = [
  ['get', '/v1/agents/{agent_id}/readiness'],
  ['get', '/v1/decisions/{decision_id}/status'],
  ['get', '/v1/reviewer-links/status'],
  ['post', '/v1/decisions'],
  ['post', '/v1/decisions/{decision_id}/reports'],
  ['post', '/v1/reviewer-links'],
]
for (const [method, path] of operations) assert.ok(contract.paths[path]?.[method], `Missing ${method.toUpperCase()} ${path}`)
const schemas = contract.components.schemas
const report = schemas.v1RecordDecisionReportRequest
assert.ok(report.required.includes('outcome'), 'Execution reports must require an outcome')
assert.equal(report.properties.outcome.$ref, '#/components/schemas/v1ExecutionOutcome')
assert.deepEqual(schemas.v1ExecutionOutcome.enum,
  ['OUTCOME_UNSPECIFIED', 'SUCCESS', 'FAILURE', 'CANCELLED', 'UNKNOWN'])
assert.equal(report.properties.enforcement, undefined, 'Do not reintroduce a derived enforcement outcome')
for (const name of ['id', 'agent_id', 'action_type', 'idempotency_key', 'status']) {
  assert.ok(schemas.v1CustomerDecision.properties[name], `Missing decision correlation field: ${name}`)
  assert.ok(schemas.v1GetDecisionStatusResponse.properties[name], `Missing status correlation field: ${name}`)
}
// Validate all references without duplicating the API repository's schema inventory.
function visit(value) {
  if (!value || typeof value !== 'object') return
  if (value.$ref) {
    assert.match(value.$ref, /^#\/components\/schemas\//, 'Contract references must be self-contained')
    assert.ok(schemas[value.$ref.slice('#/components/schemas/'.length)], `Missing schema: ${value.$ref}`)
  }
  for (const child of Object.values(value)) visit(child)
}
visit(contract)
console.log(`Contract ${manifest.version}: pinned digest and six plugin operations verified`)
