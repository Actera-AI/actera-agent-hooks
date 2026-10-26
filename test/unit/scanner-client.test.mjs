import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { once } from 'node:events'
import { createServer } from 'node:http'
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import test, { beforeEach, afterEach } from 'node:test'
import { captureInput } from '../../src/core/input-capture.mjs'
import { scannerBinary, stopScanner } from '../../src/core/scanner-client.mjs'

let home, previous
beforeEach(async () => {
  home = await mkdtemp(path.join(os.tmpdir(), 'actera-helper-test-'))
  previous = process.env.ACTERA_CLAUDE_BRIDGE_HOME
  process.env.ACTERA_CLAUDE_BRIDGE_HOME = home
})
afterEach(async () => {
  await stopScanner().catch(() => {})
  if (previous === undefined) delete process.env.ACTERA_CLAUDE_BRIDGE_HOME
  else process.env.ACTERA_CLAUDE_BRIDGE_HOME = previous
  await rm(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
})
async function state() {
  const binary = scannerBinary()
  const file = path.join(binary.root, `helper-${binary.sha256}.json`)
  return { file, data: JSON.parse(await readFile(file, 'utf8')) }
}

test('concurrent first hooks share one helper and leave no startup lock', async () => {
  const results = await Promise.all(Array.from({length:8},(_,i)=>captureInput({command:`git status --short # ${i}`})))
  assert.ok(results.every(r=>r.metadata.status === 'complete'))
  const first = (await state()).data
  await Promise.all(Array.from({length:8},()=>captureInput({command:'git status'})))
  assert.equal((await state()).data.pid, first.pid)
  assert.ok(!(await readdir(path.join(home,'scanner'))).some(name=>name.endsWith('.lock')))
})

test('a dead helper restarts on the next request without losing detection', async () => {
  await captureInput({command:'git status'})
  const old = (await state()).data
  process.kill(old.pid) // This PID belongs to this test's freshly authenticated helper.
  await delay(100)
  const credential = ['ghp','Ab3De5Gh7Jk9Mn1Pq3St5Vw7Yz9Bc1Ef3Hi5Kl7N'.slice(0,36)].join('_')
  const result = await captureInput({command:`echo ${credential}`})
  assert.equal(result.parameters.command,'echo [redacted]')
  assert.notEqual((await state()).data.pid,old.pid)
})

test('a stale port cannot receive tool input without proving possession of the helper token', async t => {
  const bodies = []
  const imposter = createServer((req,res) => {
    let body = ''; req.on('data',chunk=>body+=chunk)
    req.on('end',()=>{ bodies.push({path:req.url,body,authorization:req.headers.authorization}); res.end(JSON.stringify({protocol:1,version:'8.30.1',proof:'wrong'})) })
  })
  await new Promise(resolve=>imposter.listen(0,'127.0.0.1',resolve))
  t.after(()=>new Promise(resolve=>imposter.close(resolve)))
  const binary = scannerBinary()
  const file = path.join(binary.root,`helper-${binary.sha256}.json`)
  await writeFile(file,JSON.stringify({port:imposter.address().port,token:randomBytes(32).toString('hex'),sha256:binary.sha256,pid:1}))
  const result = await captureInput({command:'private-command-not-for-imposter'})
  assert.equal(result.metadata.status,'complete')
  assert.ok(bodies.length > 0)
  assert.ok(bodies.every(r=>r.path.startsWith('/health?') && r.body === '' && r.authorization === undefined))
})

test('helper rejects unauthenticated, browser-origin, oversized and malformed requests', async () => {
  await captureInput({command:'git status'})
  const {data} = await state()
  const url = `http://127.0.0.1:${data.port}/scan`
  const auth = {authorization:`Bearer ${data.token}`}
  for (const headers of [{}, {...auth,Origin:'https://example.com'}]) {
    const response = await fetch(url,{method:'POST',headers,body:JSON.stringify({text:'private-test-input'})})
    assert.equal(response.status,401)
    assert.ok(!(await response.text()).includes('private-test-input'))
  }
  assert.equal((await fetch(url,{method:'POST',headers:auth,body:JSON.stringify({text:'x'.repeat(1024*1024+1)})})).status,400)
  assert.equal((await fetch(url,{method:'POST',headers:auth,body:'{"text":"hello"} {"text":"extra"}'})).status,400)
  const credential = ['ghp','Ab3De5Gh7Jk9Mn1Pq3St5Vw7Yz9Bc1Ef3Hi5Kl7N'.slice(0,36)].join('_')
  await fetch(url,{method:'POST',headers:auth,body:JSON.stringify({text:credential})})
  const clean = await fetch(url,{method:'POST',headers:auth,body:JSON.stringify({text:'git status'})})
  assert.deepEqual(await clean.json(),[]) // Findings cannot bleed into later requests.
})

test('helper exits after its configured idle lifetime', async t => {
  const {executable} = scannerBinary()
  const child = spawn(executable,[],{windowsHide:true,stdio:['pipe','pipe','ignore']})
  t.after(()=>{ if (child.exitCode === null) child.kill() })
  child.stdin.end(JSON.stringify({token:randomBytes(32).toString('hex'),idle_seconds:1}))
  await once(child.stdout,'data')
  const [code] = await Promise.race([once(child,'exit'),delay(3500).then(()=>{throw new Error('Idle helper did not stop')})])
  assert.equal(code,0)
})
