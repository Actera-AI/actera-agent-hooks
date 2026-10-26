import { spawn } from 'node:child_process'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { performance } from 'node:perf_hooks'
import { captureInput } from '../src/core/input-capture.mjs'
import { stopScanner } from '../src/core/scanner-client.mjs'

const home = await mkdtemp(path.join(os.tmpdir(), 'actera-capture-benchmark-'))
const previous = process.env.ACTERA_CLAUDE_BRIDGE_HOME
process.env.ACTERA_CLAUDE_BRIDGE_HOME = home
const summarize = values => {
  const sorted = [...values].sort((a,b)=>a-b)
  return { samples:values.length, medianMs:+sorted[Math.floor(sorted.length/2)].toFixed(2), p95Ms:+sorted[Math.ceil(sorted.length*.95)-1].toFixed(2), maxMs:+sorted.at(-1).toFixed(2) }
}
const ordinary = {command:'git status --short',description:'Check local changes'}
const moduleURL = new URL('../src/core/input-capture.mjs',import.meta.url).href
function freshProcess(scan) {
  return new Promise((resolve,reject)=>{
    const start = performance.now()
    const code = `import{captureInput}from ${JSON.stringify(moduleURL)}; const start=performance.now(); ${scan ? `const result=await captureInput(${JSON.stringify(ordinary)});if(result.metadata.status!=='complete')throw Error('scan failed');` : ''} console.log(performance.now()-start)`
    const child = spawn(process.execPath,['--input-type=module','-e',code],{env:process.env,windowsHide:true,stdio:['ignore','pipe','pipe']})
    let output=''; child.stdout.on('data',chunk=>output+=chunk)
    child.on('error',reject)
    child.on('exit',code=>{ if(code)reject(new Error('Benchmark child failed'));else resolve({total:performance.now()-start,capture:Number(output)}) })
  })
}
try {
  const started = performance.now()
  if ((await captureInput(ordinary)).metadata.status !== 'complete') throw new Error('Cold capture failed')
  const coldCaptureMs = +(performance.now()-started).toFixed(2)
  const synthetic = ['ghp','Ab3De5Gh7Jk9Mn1Pq3St5Vw7Yz9Bc1Ef3Hi5Kl7N'.slice(0,36)].join('_')
  const cases = {shell:ordinary,slack:{channel:'C_TEST',text:'Deployment complete. '.repeat(100)+synthetic},input64KiB:{text:'Ordinary text. '.repeat(4400)},inputNearLimit:{text:'Ordinary text. '.repeat(34000)}}
  const results = {}
  for (const [name,input] of Object.entries(cases)) {
    const times=[]
    for(let i=0;i<(name==='inputNearLimit'?20:100);i++) {
      const start=performance.now();const result=await captureInput(input);times.push(performance.now()-start)
      if (result.metadata.status==='omitted')throw Error('Capture unexpectedly omitted')
      if (name==='slack' && result.parameters.text.includes(synthetic))throw Error('Redaction failed')
    }
    results[name]={inputBytes:Buffer.byteLength(JSON.stringify(input)),...summarize(times)}
  }
  const baseline=[],totals=[],capture=[]
  for(let i=0;i<20;i++) {
    baseline.push((await freshProcess(false)).total)
    const result=await freshProcess(true);totals.push(result.total);capture.push(result.capture)
  }
  const result={date:new Date().toISOString(),platform:process.platform,arch:process.arch,cpu:os.cpus()[0].model.trim(),node:process.version,coldCaptureMs,includes:'Binary checksum verification, helper authentication, local round trip, detection, redaction and metadata; excludes Actera API',warmCapture:results,freshHookProcess:{baselineImport:summarize(baseline),withCapture:summarize(totals),captureOnly:summarize(capture)}}
  await mkdir('.tools', { recursive: true })
  await writeFile('.tools/capture-benchmark.json',JSON.stringify(result,null,2)+'\n')
  console.log(JSON.stringify(result,null,2))
  if(results.shell.p95Ms>50 || results.slack.p95Ms>50 || result.freshHookProcess.captureOnly.p95Ms>50)process.exitCode=1
} finally {
  await stopScanner().catch(()=>{})
  if(previous===undefined)delete process.env.ACTERA_CLAUDE_BRIDGE_HOME;else process.env.ACTERA_CLAUDE_BRIDGE_HOME=previous
  await rm(home,{recursive:true,force:true,maxRetries:10,retryDelay:100})
}
