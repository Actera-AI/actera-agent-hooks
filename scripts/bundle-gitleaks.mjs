// Maintainer-only packaging. Runtime hooks never download executable code.
import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { gzipSync, gunzipSync } from 'node:zlib'
import { fileURLToPath } from 'node:url'

const version = '8.30.1'
const platforms = { 'darwin-arm64': ['darwin','arm64'], 'darwin-x64': ['darwin','amd64'], 'linux-arm64': ['linux','arm64'], 'linux-x64': ['linux','amd64'], 'win32-arm64': ['windows','arm64'], 'win32-x64': ['windows','amd64'] }
const destination = new URL('../vendor/gitleaks/', import.meta.url)
const source = new URL('../scanner/', import.meta.url)
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex')
const sourceFiles = ['main.go','go.mod','go.sum']
const sourceHash = createHash('sha256')
for (const name of sourceFiles) { sourceHash.update(name); sourceHash.update((await readFile(new URL(name,source),'utf8')).replaceAll('\r\n','\n')) }
const sourceSha256 = sourceHash.digest('hex')
const verifyBuild = process.argv.includes('--verify-build')
const expected = verifyBuild ? JSON.parse(await readFile(new URL('manifest.json',destination),'utf8')) : undefined
if (process.argv.includes('--build') || verifyBuild) {
  await mkdir(destination,{recursive:true})
  const stage = new URL('../.tools/helper-build/',import.meta.url)
  await mkdir(stage,{recursive:true})
  const binaries = {}
  const goVersion = execFileSync('go',['version'],{encoding:'utf8'}).trim()
  for (const [platform,[GOOS,GOARCH]] of Object.entries(platforms)) {
    const output = new URL(platform + (GOOS === 'windows' ? '.exe' : ''),stage)
    execFileSync('go',['build','-trimpath','-buildvcs=false','-ldflags=-s -w -buildid=','-o',fileURLToPath(output),'.'],{cwd:fileURLToPath(source),env:{...process.env,GOWORK:'off',CGO_ENABLED:'0',GOOS,GOARCH},stdio:'inherit'})
    const bytes = await readFile(output)
    const compressed = gzipSync(bytes,{level:9})
    if (verifyBuild) {
      if (sha256(bytes) !== expected.binaries[platform].sha256) throw new Error(`Rebuild differs: ${platform}`)
    } else await writeFile(new URL(`${platform}.gz`,destination),compressed)
    binaries[platform] = {file:`${platform}.gz`,sha256:sha256(bytes),compressedSha256:sha256(compressed)}
    console.log(`Bundled helper ${platform} (${compressed.length} bytes)`)
  }
  if (!verifyBuild) await writeFile(new URL('manifest.json',destination),JSON.stringify({version,protocol:1,sourceSha256,goVersion,module:'github.com/zricethezav/gitleaks/v8',binaries},null,2)+'\n')
}
const manifest = JSON.parse(await readFile(new URL('manifest.json',destination),'utf8'))
if (manifest.version !== version || manifest.protocol !== 1 || manifest.sourceSha256 !== sourceSha256) throw new Error('Scanner source changed: rebuild bundled helpers')
for (const platform of Object.keys(platforms)) {
  const entry = manifest.binaries[platform]
  const compressed = await readFile(new URL(entry.file,destination))
  if (sha256(compressed) !== entry.compressedSha256 || sha256(gunzipSync(compressed)) !== entry.sha256) throw new Error(`Bundled helper integrity check failed: ${platform}`)
}
console.log(`Verified all six Gitleaks ${version} helper bundles and source provenance`)
