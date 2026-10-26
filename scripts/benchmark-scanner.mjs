import { spawn } from 'node:child_process'
import { createHmac, randomBytes } from 'node:crypto'
import { once } from 'node:events'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { performance } from 'node:perf_hooks'

if (!process.argv[2]) throw new Error('Usage: node scripts/benchmark-scanner.mjs <helper-binary>')
const binary = path.resolve(process.argv[2])
const token = randomBytes(32).toString('hex')
const started = performance.now()
const child = spawn(binary, [], { windowsHide: true, stdio: ['pipe', 'pipe', 'ignore'] })
child.stdin.end(JSON.stringify({ token, idle_seconds: 60 }))
let readyText = ''
const ready = await new Promise((resolve, reject) => {
  child.on('error', reject)
  child.on('exit', () => reject(new Error('Helper exited before ready')))
  child.stdout.on('data', chunk => { readyText += chunk; if (readyText.includes('\n')) resolve(JSON.parse(readyText.split('\n')[0])) })
})
const coldStartMs = +(performance.now() - started).toFixed(2)
const origin = `http://127.0.0.1:${ready.port}`
const headers = { authorization: `Bearer ${token}`, 'content-type': 'application/json' }
async function request(text) {
  const challenge = randomBytes(32).toString('hex')
  const health = await fetch(`${origin}/health?challenge=${challenge}`, { signal: AbortSignal.timeout(5000) })
  const proof = await health.json()
  if (proof.proof !== createHmac('sha256', Buffer.from(token, 'hex')).update(challenge).digest('hex')) throw new Error('Invalid helper proof')
  const result = await fetch(`${origin}/scan`, { method: 'POST', headers, body: JSON.stringify({ text }), signal: AbortSignal.timeout(5000) })
  if (!result.ok) throw new Error(`Scan failed: ${result.status}`)
  return result.json()
}
const credential = ['ghp', 'Ab3De5Gh7Jk9Mn1Pq3St5Vw7Yz9Bc1Ef3Hi5Kl7N'.slice(0,36)].join('_')
const cases = {
  shell: 'command = git status --short\ndescription = Check local changes',
  slack: `text = Release is ready. ${'Normal message content. '.repeat(90)} ${credential}`,
  input64KiB: `text = ${'The project documentation has been updated. '.repeat(1600)}`,
  inputNearLimit: `text = ${'Ordinary content. '.repeat(30000)}`,
}
const summarize = values => {
  const sorted = [...values].sort((a,b)=>a-b)
  return { samples: values.length, medianMs: +sorted[Math.floor(sorted.length/2)].toFixed(2), p95Ms: +sorted[Math.ceil(sorted.length*.95)-1].toFixed(2), maxMs: +sorted.at(-1).toFixed(2) }
}
try {
  const proof = await request(cases.slack)
  if (!proof.some(f => f.Secret === credential && f.RuleID === 'github-pat')) throw new Error('Detection fixture failed')
  const results = {}
  for (const [name, text] of Object.entries(cases)) {
    const times = []
    const count = name === 'inputNearLimit' ? 20 : 100
    for (let i=0;i<count;i++) { const start = performance.now(); await request(text); times.push(performance.now()-start) }
    results[name] = { inputBytes: Buffer.byteLength(text), ...summarize(times) }
  }
  const result = { platform: process.platform, arch: process.arch, cpu: os.cpus()[0].model, node: process.version, coldStartMs, includes: 'HTTP authentication challenge, request serialization, scan and response parsing; excludes Node hook startup and Actera API', results }
  await mkdir('.tools', { recursive: true })
  await writeFile('.tools/scanner-benchmark.json', JSON.stringify(result,null,2)+'\n')
  console.log(JSON.stringify(result,null,2))
} finally {
  const exited = once(child, 'exit')
  await fetch(`${origin}/shutdown`, { method:'POST', headers }).catch(()=>{})
  await exited
}
